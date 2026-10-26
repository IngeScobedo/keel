/**
 * ADR-0021: Keel conduce el método. Daemon, git, worktrees y SQLite reales; el
 * proveedor es un guion por run que actúa como el agente: llama a `canUseTool`
 * y al daemon por la puerta de agentes con el token de su run, igual que el
 * puente MCP.
 */
import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type {
  HookCallback,
  Options,
  PermissionResult,
  SDKMessage,
} from "@anthropic-ai/claude-agent-sdk"
import { Daemon, IpcClient, type QueryFn } from "../src/index.ts"
import { initRepo } from "./git-fixture.ts"
import { firstPrompt } from "./replay.ts"

const dirs: string[] = []
const daemons: Daemon[] = []
const clients: IpcClient[] = []
afterEach(async () => {
  for (const c of clients.splice(0)) c.close()
  for (const d of daemons.splice(0)) {
    await d.idle()
    d.stop()
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

let n = 0
const meta = () => ({ request_id: "r", idempotency_key: `method-${++n}` })

/** Lo que el guion de un run puede hacer: actuar como el agente de ese run. */
type Turn = {
  run_id: string
  options: Options
  prompt: string
  agent: IpcClient
  /** Pide permiso como lo haría Claude Code. */
  use: (tool: string, input: Record<string, unknown>) => Promise<PermissionResult | null | undefined>
}
type Script = (t: Turn) => Promise<void>

const BRIEF = `# Brief
## Problema
Los capítulos no se ven en el detalle.
## Alcance
Mostrar los capítulos en la vista del diseñador.
## Fuera de alcance
La tienda.
## Criterios de aceptación
- el detalle muestra los capítulos
`
const SPEC = `## Requisitos
### R1 — Capítulos visibles
#### Escenario: con capítulos
- **Dado** un proyecto con capítulos
- **Cuando** abro el detalle
- **Entonces** los veo
`
const DESIGN = (contract: string) => `# Diseño
## Contrato congelado
${contract}
## Fronteras de archivos
| responsable | archivos |
| ----------- | -------- |
| backend | \`api/**\` |
`

async function boot() {
  const dir = mkdtempSync(join(tmpdir(), "keel-method-"))
  dirs.push(dir)
  const repoDir = initRepo(join(dir, "repo"))
  const scripts: Script[] = []
  const seen: Turn[] = []
  let daemon: Daemon
  const queryFn: QueryFn = ({ prompt, options }) => {
    const script = scripts.shift() ?? (async () => {})
    return (async function* () {
      const runId = String((options.env as Record<string, string>).KEEL_RUN_ID)
      const run = daemon.repo.getRun(runId)
      const { file } = daemon.agentTokens.issue({
        run_id: runId,
        project_id: run?.project_id as string,
        work_item_id: run?.work_item_id as string,
      })
      const agent = await IpcClient.connect(daemon.agentServer.path)
      clients.push(agent)
      await agent.call("session.bind_agent", { token: readFileSync(file, "utf8") })
      yield {
        type: "system",
        subtype: "init",
        session_id: `s-${runId}`,
        model: "opus",
        uuid: `i-${runId}`,
      } as never
      const turn: Turn = {
        run_id: runId,
        options,
        prompt: firstPrompt(prompt),
        agent,
        use: (tool, input) =>
          options.canUseTool?.(tool, input, {
            signal: new AbortController().signal,
            suggestions: [],
          } as never) ?? Promise.resolve(undefined),
      }
      seen.push(turn)
      await script(turn)
      yield {
        type: "result",
        subtype: "success",
        uuid: `r-${runId}`,
        session_id: `s-${runId}`,
        is_error: false,
        result: "ok",
        total_cost_usd: 0.001,
        usage: { input_tokens: 1, output_tokens: 1 },
      } as unknown as SDKMessage
    })()
  }
  daemon = new Daemon({
    dbPath: join(dir, "keel.sqlite"),
    socketPath: join(dir, "keel.sock"),
    rootPath: repoDir,
    worktreesDir: join(dir, "worktrees"),
    adapterDeps: { queryFn, binary: "/fake/claude" },
    mcpBridge: false,
  })
  daemon.start()
  daemons.push(daemon)
  const human = await IpcClient.connect(daemon.server.path)
  clients.push(human)
  // El perfil confirmado: una verificación determinista que el agente arregla.
  await human.call("projects.profile_set", {
    ...meta(),
    profile: {
      stack: [],
      verify: [{ name: "test", command: "test -f ok.txt" }],
      protected_branches: ["main"],
      branch_prefixes: {},
      generated_paths: [],
      canon: { adr_dirs: [], sdd_dirs: [], roadmap: null },
      invariants: ["centavos"],
      adr_pattern: "ADR-\\d+",
      harness: { claude_dir: false, agents_md: false, claude_md: false },
    },
  })
  const task = async (title: string) =>
    (await human.call("work_items.create", { ...meta(), title, kind: "feature" })) as {
      id: string
    }
  const runsOf = (workItemId: string) =>
    daemon.repo
      .eventsAfter(0, null, 100_000)
      .filter((e) => e.kind === "run.created")
      .map(
        (e) =>
          JSON.parse(e.payload_json) as {
            id: string
            work_item_id: string
            purpose: string
            parent_run_id: string | null
          },
      )
      .filter((r) => r.work_item_id === workItemId)
  const until = async (cond: () => boolean, ms = 10_000) => {
    const end = Date.now() + ms
    while (!cond()) {
      if (Date.now() > end) throw new Error("no llegó a tiempo")
      await Bun.sleep(15)
    }
  }
  const events = (kind: string) =>
    daemon.repo
      .eventsAfter(0, null, 100_000)
      .filter((e) => e.kind === kind)
      .map((e) => JSON.parse(e.payload_json) as Record<string, unknown>)
  return { daemon, human, scripts, seen, task, runsOf, until, events }
}

const put = (t: Turn, work_item_id: string, kind: string, content_markdown: string) =>
  t.agent.call("task_docs.put", { ...meta(), work_item_id, kind, content_markdown }) as Promise<{
    version: number
    report: { ok: boolean }
  }>
const advance = (t: Turn, work_item_id: string, to: string, extra: Record<string, unknown> = {}) =>
  t.agent.call("stages.advance", { ...meta(), work_item_id, to, ...extra }) as Promise<{
    flow: { stage: string }
    gate: { approval_id: string; gate: string } | null
  }>

describe("ADR-0021: trabajo directo", () => {
  test("del brief al cierre sin elegir pasos: sólo lectura, documentos validados, worktree y delta-verde", async () => {
    const s = await boot()
    const w = await s.task("Capítulos en el detalle")
    // 1. Brief en un run de planeación, en el worktree de la tarea.
    s.scripts.push(async (t) => {
      const touch = await t.use("Bash", { command: "touch x.txt" })
      expect(touch).toMatchObject({ behavior: "deny" })
      expect((touch as { message: string }).message).toContain("sólo lectura")
      // Sin brief válido, Keel dice qué falta.
      await expect(advance(t, w.id, "implement", { ceremony: "direct" })).rejects.toThrow(
        "brief: falta",
      )
      expect((await put(t, w.id, "brief", "## Problema\nalgo\n")).report.ok).toBe(false)
      await expect(advance(t, w.id, "implement", { ceremony: "direct" })).rejects.toThrow(
        "sección «Alcance»",
      )
      expect((await put(t, w.id, "brief", BRIEF)).report.ok).toBe(true)
      const r = await advance(t, w.id, "implement", { ceremony: "direct", reason: "fix chico" })
      expect(r).toMatchObject({ flow: { stage: "implement" }, gate: null })
    })
    // 2. Implementación: Keel abre el run solo al terminar el de planeación.
    let release: () => void = () => {}
    const hold = new Promise<void>((r) => {
      release = r
    })
    s.scripts.push(async (t) => {
      await hold
      writeFileSync(join(String(t.options.cwd), "ok.txt"), "listo\n")
      const v = (await t.agent.call("verify.run", { ...meta(), work_item_id: w.id })) as {
        delta: { green: boolean; fixed: string[] }
      }
      expect(v.delta).toMatchObject({ green: true, fixed: ["test"] })
      await advance(t, w.id, "review")
      // En revisión vuelve a ser sólo lectura.
      expect(await t.use("Bash", { command: "rm ok.txt" })).toMatchObject({ behavior: "deny" })
      await put(t, w.id, "qa", "## Veredicto: PASS\n")
      await advance(t, w.id, "close")
    })
    const work = (await s.human.call("tasks.work", { ...meta(), work_item_id: w.id })) as {
      delivered: string
      flow: { stage: string }
      run: { purpose: string }
    }
    expect(work).toMatchObject({
      delivered: "started",
      flow: { stage: "brief" },
      run: { purpose: "plan" },
    })

    await s.until(() => s.seen.length === 2)
    const [plan, exec] = s.seen as [Turn, Turn]
    // Planear corre en modo plan, con el harness del proyecto y el método de Keel.
    expect(plan.options.permissionMode).toBe("plan")
    expect(plan.options.settingSources).toEqual(["project"])
    expect(plan.options.plugins?.[0]?.path).toEndWith("method-plugin")
    // Una conversación: el run de implementación es hijo del de planeación y en su carpeta.
    expect(exec.options.cwd).toBe(plan.options.cwd)
    expect(String(plan.options.cwd)).toContain("worktrees")
    expect(exec.options.permissionMode).toBe("default")
    expect(exec.prompt).toContain("etapa implement")
    const runs = s.runsOf(w.id)
    expect(runs.map((r) => r.purpose)).toEqual(["plan", "execute"])
    expect(runs[1]?.parent_run_id).toBe(runs[0]?.id)
    // El baseline se tomó al entrar a implementación, con el test en rojo.
    await s.until(() => s.daemon.repo.getFlow(w.id)?.baseline_json !== null)
    expect(JSON.parse(s.daemon.repo.getFlow(w.id)?.baseline_json ?? "[]")).toMatchObject([
      { name: "test", ok: false },
    ])
    expect(s.daemon.repo.getWorkItem(w.id)?.lifecycle).toBe("running")
    release()
    await s.until(() => s.daemon.repo.getWorkItem(w.id)?.lifecycle === "needs_review")
    expect(s.daemon.repo.getFlow(w.id)?.stage).toBe("close")
    // La transición directa quedó a nombre del humano que pidió trabajar la tarea.
    expect(s.events("task.stage_changed")[0]).toMatchObject({
      from: "brief",
      to: "implement",
      delegated: true,
    })
    const view = (await s.human.call("work_items.get", { work_item_id: w.id })) as {
      item: { stage: string; board_status: string }
    }
    expect(view.item).toMatchObject({ stage: "close", board_status: "in_review" })
    // Ningún permiso se le preguntó al humano: las negaciones fueron del método.
    expect(s.events("approval.requested")).toHaveLength(0)
  })
})

describe("ADR-0021: ciclo formal", () => {
  test("gates (a) y (b), negar con motivo, contrato congelado y su cambio reabre el gate", async () => {
    const s = await boot()
    const w = await s.task("Paginar capítulos")
    const gate = async () => {
      await s.until(() => s.daemon.repo.pendingStageGate(w.id) !== null)
      const g = s.daemon.repo.pendingStageGate(w.id) as { id: string; operation_hash: string }
      return (decision: string, reason?: string) =>
        s.human.call("approvals.resolve", {
          ...meta(),
          approval_id: g.id,
          operation_hash: g.operation_hash,
          decision,
          ...(reason ? { reason } : {}),
        })
    }
    const designed = `${DESIGN("`GET /chapters` en centavos")}\nVer ADR-0006.\n`
    let approvedBrief: () => void = () => {}
    const briefOk = new Promise<void>((r) => {
      approvedBrief = r
    })
    // Run 1 (planeación): brief, gate (a), diseño y gate (b).
    s.scripts.push(async (t) => {
      await put(t, w.id, "brief", BRIEF)
      expect(await advance(t, w.id, "design", { ceremony: "formal" })).toMatchObject({
        gate: { gate: "brief" },
      })
      await expect(advance(t, w.id, "design")).rejects.toThrow("gate esperando")
      await briefOk
      await put(t, w.id, "spec", SPEC)
      await put(t, w.id, "design", DESIGN("`GET /chapters` en centavos"))
      // El invariante del proyecto exige su ADR en el diseño.
      await expect(advance(t, w.id, "implement")).rejects.toThrow("invariante")
      await put(t, w.id, "design", designed)
      expect(await advance(t, w.id, "implement")).toMatchObject({ gate: { gate: "design" } })
    })
    // Run 2 (planeación): Keel lo abre al negar, con el motivo del humano.
    s.scripts.push(async (t) => {
      expect(t.prompt).toContain("falta el caso sin capítulos")
      await put(
        t,
        w.id,
        "spec",
        `${SPEC}#### Escenario: sin capítulos\n- **Dado** un proyecto sin capítulos\n- **Cuando** abro el detalle\n- **Entonces** veo «sin capítulos»\n`,
      )
      await advance(t, w.id, "implement")
    })
    // Run 3 (implementación): cambiar el contrato reabre el gate (b) y congela la escritura.
    const frozen: { result?: PermissionResult | null | undefined } = {}
    s.scripts.push(async (t) => {
      await put(t, w.id, "design", designed.replace("GET /chapters", "GET /chapters?cursor"))
      frozen.result = await t.use("Bash", { command: "touch a.txt" })
    })
    s.scripts.push(async () => {})

    await s.human.call("tasks.work", { ...meta(), work_item_id: w.id })
    await (await gate())("approve_once")
    expect(s.daemon.repo.getFlow(w.id)?.stage).toBe("design")
    // Con el run de planeación vivo, Keel le escribe en vez de abrir otro.
    expect(s.events("run.keel_message").at(-1)?.text).toContain("aprobó el brief")
    approvedBrief()

    await (await gate())("deny", "falta el caso sin capítulos")
    expect(s.daemon.repo.getFlow(w.id)?.stage).toBe("design")
    expect(s.daemon.repo.getWorkItem(w.id)?.lifecycle).toBe("triage")

    await (await gate())("approve_once")
    const contract = s.daemon.repo.getFlow(w.id)?.contract_sha256
    expect(contract).toMatch(/^[0-9a-f]{64}$/)
    await s.until(() => s.runsOf(w.id).length === 3)
    expect(s.runsOf(w.id).map((r) => r.purpose)).toEqual(["plan", "plan", "execute"])

    const change = await gate()
    await s.until(() => frozen.result !== undefined)
    expect(frozen.result).toMatchObject({ behavior: "deny" })
    await change("approve_once")
    expect(s.daemon.repo.getFlow(w.id)?.contract_sha256).not.toBe(contract)
    expect(s.daemon.repo.getFlow(w.id)?.stage).toBe("implement")
    await s.until(() => s.runsOf(w.id).length === 4)
  }, 30_000)
})

describe("ADR-0021: reglas que el agente no se salta", () => {
  test("un humano no avanza etapas y un agente sólo opera su tarea; devolver es del humano", async () => {
    const s = await boot()
    const a = await s.task("A")
    const b = await s.task("B")
    s.scripts.push(async (t) => {
      await expect(put(t, b.id, "brief", BRIEF)).rejects.toThrow(
        "sólo opera sobre la tarea de su run",
      )
      await put(t, a.id, "brief", BRIEF)
      await advance(t, a.id, "implement", { ceremony: "direct" })
    })
    s.scripts.push(async () => {})
    await s.human.call("tasks.work", { ...meta(), work_item_id: a.id })
    await expect(
      s.human.call("stages.advance", { ...meta(), work_item_id: a.id, to: "review" }),
    ).rejects.toThrow("la avanza el agente")
    await s.until(() => s.daemon.repo.getWorkItem(a.id)?.lifecycle === "waiting_human")
    // Implementación sin cerrar: la tarea espera al humano, no pasa a revisión.
    expect(s.daemon.repo.getFlow(a.id)?.stage).toBe("implement")
    await expect(
      s.human.call("stages.return", { ...meta(), work_item_id: a.id, to: "brief", reason: "x" }),
    ).rejects.toThrow("ya pasó a implementación")
  })

  test("una regla allow del proyecto vuelve al gate de Keel con ask", async () => {
    const s = await boot()
    const repoRoot = s.daemon.rootPath
    writeFileSync(
      join(repoRoot, ".gitignore"),
      "", // el worktree sale del último commit: la regla tiene que estar commiteada
    )
    const settings = join(repoRoot, ".claude")
    await Bun.$`mkdir -p ${settings} && echo '{"permissions":{"allow":["Bash(touch:*)"]}}' > ${join(settings, "settings.json")} && git -C ${repoRoot} add -A && git -C ${repoRoot} commit -qm reglas`.quiet()
    const w = await s.task("C")
    s.scripts.push(async (t) => {
      const pre = (t.options.hooks?.PreToolUse?.[0]?.hooks?.[0] ?? null) as HookCallback | null
      const out = await pre?.(
        {
          hook_event_name: "PreToolUse",
          tool_name: "Bash",
          tool_input: { command: "touch a && touch b" },
          session_id: "s",
          transcript_path: "",
          cwd: "",
          tool_use_id: "t1",
        } as never,
        "t1",
        { signal: new AbortController().signal },
      )
      expect(out).toMatchObject({ hookSpecificOutput: { permissionDecision: "ask" } })
      const other = await pre?.(
        {
          hook_event_name: "PreToolUse",
          tool_name: "Bash",
          tool_input: { command: "ls" },
          session_id: "s",
          transcript_path: "",
          cwd: "",
          tool_use_id: "t2",
        } as never,
        "t2",
        { signal: new AbortController().signal },
      )
      expect(other).toEqual({})
    })
    await s.human.call("tasks.work", { ...meta(), work_item_id: w.id })
    await s.until(() => s.seen.length === 1)
    await s.daemon.idle()
    expect(existsSync(join(String(s.seen[0]?.options.cwd), ".claude", "settings.json"))).toBe(true)
  })
})
