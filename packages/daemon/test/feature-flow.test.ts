/**
 * ADR-0022: una feature es un árbol de tareas con su rama. Daemon, git, worktrees y
 * SQLite reales; el proveedor es un guion por run que actúa como el agente por la
 * puerta de agentes con el token de su run.
 */
import { afterEach, describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Options, PermissionResult, SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import { Daemon, IpcClient, type QueryFn } from "../src/index.ts"
import { initRepo } from "./git-fixture.ts"

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
const meta = () => ({ request_id: "r", idempotency_key: `feat-${++n}` })

type Turn = {
  run_id: string
  work_item_id: string
  options: Options
  agent: IpcClient
  use: (tool: string, input: Record<string, unknown>) => Promise<PermissionResult | undefined>
}
type Script = (t: Turn) => Promise<void>

const BRIEF = `# Brief
## Problema
El diseñador no ve los capítulos.
## Alcance
API y backoffice.
## Fuera de alcance
La tienda.
## Criterios de aceptación
- se ven los capítulos
`
const SPEC = `## Requisitos
### R1 — Capítulos en el API
#### Escenario: lista
- **Dado** un proyecto con capítulos
- **Cuando** pido el detalle
- **Entonces** vienen los capítulos
### R2 — Capítulos en el backoffice
#### Escenario: agrupado
- **Dado** fotos con capítulo
- **Cuando** abro el detalle
- **Entonces** se agrupan
`
const DESIGN = `# Diseño
## Contrato congelado
\`GET /projects/:id\` devuelve \`chapters: Chapter[]\`.
## Fronteras de archivos
| responsable | archivos |
| ----------- | -------- |
| backend | \`api/**\` |
| frontend | \`web/**\` |
`
const TASKS = `## Fase 1 — API
- [ ] T1 Contrato de capítulos → \`api/contract/**\` → R1
- [ ] T2 Repositorio de capítulos → \`api/repo/**\` → R1
## Fase 2 — Backoffice
- [ ] T3 Tarjeta por capítulos → \`web/photos/**\` → R2
`

async function boot() {
  const dir = mkdtempSync(join(tmpdir(), "keel-feature-"))
  dirs.push(dir)
  const repoDir = initRepo(join(dir, "repo"))
  const scripts: Script[] = []
  const seen: Turn[] = []
  let daemon: Daemon
  const queryFn: QueryFn = ({ options }) => {
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
        work_item_id: run?.work_item_id as string,
        options,
        agent,
        use: async (tool, input) =>
          (await options.canUseTool?.(tool, input, {
            signal: new AbortController().signal,
            suggestions: [],
          } as never)) ?? undefined,
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
  await human.call("projects.profile_set", {
    ...meta(),
    profile: {
      stack: [],
      verify: [{ name: "test", command: "true" }],
      protected_branches: ["main"],
      branch_prefixes: {},
      generated_paths: [],
      canon: { adr_dirs: [], sdd_dirs: [], roadmap: null },
      invariants: [],
      adr_pattern: "ADR-\\d+",
      harness: { claude_dir: false, agents_md: false, claude_md: false },
    },
  })
  const until = async (cond: () => boolean, what: string, ms = 15_000) => {
    const end = Date.now() + ms
    while (!cond()) {
      if (Date.now() > end) {
        if (process.env.FEATURE_DEBUG)
          for (const e of daemon.repo.eventsAfter(0, null, 100_000))
            if (
              /^(feature|task|git|approval|run\.(created|completed|failed|start)|work_item\.transitioned)/.test(
                e.kind,
              )
            )
              console.log(e.kind, e.payload_json.slice(0, 260))
        throw new Error(`no llegó a tiempo: ${what}`)
      }
      await Bun.sleep(15)
    }
  }
  const events = (kind: string) =>
    daemon.repo
      .eventsAfter(0, null, 100_000)
      .filter((e) => e.kind === kind)
      .map((e) => JSON.parse(e.payload_json) as Record<string, unknown>)
  const gitOut = (...args: string[]) =>
    execFileSync("git", args, { cwd: repoDir, encoding: "utf8" }).trim()
  return { daemon, human, scripts, seen, until, events, gitOut, repoDir }
}

const put = (t: Turn, kind: string, content_markdown: string) =>
  t.agent.call("task_docs.put", { ...meta(), work_item_id: t.work_item_id, kind, content_markdown })
const advance = (t: Turn, to: string, extra: Record<string, unknown> = {}) =>
  t.agent.call("stages.advance", { ...meta(), work_item_id: t.work_item_id, to, ...extra })

/** Lo que hace el agente de una subtarea: implementa en su frontera, revisa y propone el commit. */
function subtaskScript(daemon: () => Daemon, extra?: (t: Turn) => Promise<void>): Script {
  return async (t) => {
    const sub = JSON.parse(daemon().repo.getFlow(t.work_item_id)?.subtask_json ?? "{}") as {
      key: string
      frontier: string[]
    }
    const dir = (sub.frontier[0] as string).replace("/**", "")
    const cwd = String(t.options.cwd)
    execFileSync("mkdir", ["-p", join(cwd, dir)])
    writeFileSync(join(cwd, dir, `${sub.key}.ts`), `export const ${sub.key} = true\n`)
    await advance(t, "review")
    await put(t, "qa", "## Veredicto: PASS\n## Evidencia\n- el escenario se cumple\n")
    await t.agent.call("verify.run", { ...meta(), work_item_id: t.work_item_id })
    await advance(t, "close")
    if (extra) await extra(t)
    await t.agent.call("git.propose", { ...meta(), message: `${sub.key}: implementado` })
  }
}

async function approveGate(human: IpcClient, daemon: Daemon, workItemId: string, extra = {}) {
  const gate = daemon.repo.pendingStageGate(workItemId)
  if (!gate) throw new Error("no hay gate")
  await human.call("approvals.resolve", {
    ...meta(),
    approval_id: gate.id,
    operation_hash: gate.operation_hash,
    decision: "approve_once",
    ...extra,
  })
}

describe("ADR-0022: feature y subtareas", () => {
  test("el diseño aprobado hace nacer las subtareas; se integran solas a la rama de la feature y el padre revisa", async () => {
    const { daemon, human, scripts, until, events, gitOut } = await boot()
    const d = () => daemon
    const parent = (await human.call("work_items.create", {
      ...meta(),
      title: "Capítulos en el detalle",
      kind: "feature",
    })) as { id: string; display_id: string }
    // Brief formal → gate (a); diseño con el plan → gate (b).
    scripts.push(async (t) => {
      await put(t, "brief", BRIEF)
      await advance(t, "design", { ceremony: "formal", reason: "cambia el contrato" })
    })
    scripts.push(async (t) => {
      await put(t, "spec", SPEC)
      await put(t, "design", DESIGN)
      await put(t, "tasks", TASKS)
      await advance(t, "implement")
    })
    scripts.push(subtaskScript(d), subtaskScript(d), subtaskScript(d))
    let reviewCwd = ""
    scripts.push(async (t) => {
      reviewCwd = String(t.options.cwd)
    })
    await human.call("tasks.work", { ...meta(), work_item_id: parent.id })
    await until(() => daemon.repo.pendingStageGate(parent.id) !== null, "gate (a)")
    await approveGate(human, daemon, parent.id)
    await until(
      () =>
        daemon.repo.pendingStageGate(parent.id) !== null &&
        daemon.repo.getFlow(parent.id)?.stage === "design",
      "gate (b)",
    )
    await approveGate(human, daemon, parent.id, { auto_integrate: true })

    // Nacen 3 hijas: la fase 2 espera; el padre queda bloqueado con 0/3.
    const children = daemon.repo.childrenOf(parent.id)
    expect(children.map((c) => c.title)).toEqual([
      "Contrato de capítulos",
      "Repositorio de capítulos",
      "Tarjeta por capítulos",
    ])
    expect(daemon.repo.getWorkItem(parent.id)?.lifecycle).toBe("blocked")
    expect(daemon.repo.blockDetails(parent.id, "dependency", "subtasks")).toEqual({
      done: 0,
      total: 3,
    })
    expect(daemon.repo.getWorkItem(children[2]?.id as string)?.lifecycle).toBe("blocked")
    expect(daemon.repo.dependenciesOf(children[2]?.id as string).length).toBe(2)
    const story = daemon.repo.getTaskDoc(children[0]?.id as string, "story")
    expect(story && daemon.repo.taskDocContent(story)).toContain("#### Escenario: lista")
    expect(daemon.repo.getFlow(children[0]?.id as string)?.stage).toBe("implement")

    // Las tres se integran solas, en orden; main no se toca.
    const mainBefore = gitOut("rev-parse", "main")
    await until(() => reviewCwd !== "", "las 3 hijas y la revisión del padre", 30_000)
    for (const c of children) expect(daemon.repo.getWorkItem(c.id)?.lifecycle).toBe("done")
    const branch = "feat/KEEL-1-capitulos-en-el-detalle"
    expect(gitOut("rev-parse", "main")).toBe(mainBefore)
    const files = gitOut("ls-tree", "-r", "--name-only", branch).split("\n")
    expect(files).toContain("api/contract/T1.ts")
    expect(files).toContain("api/repo/T2.ts")
    expect(files).toContain("web/photos/T3.ts")
    const started = events("feature.subtask_started").map((e) => e.key)
    expect(started).toEqual(["T1", "T2", "T3"])
    expect(events("feature.subtask_integrated").map((e) => e.key)).toEqual(["T1", "T2", "T3"])
    expect(
      events("approval.resolved").filter((e) => e.auto === "feature.auto_integrate"),
    ).toHaveLength(3)

    // El padre revisa la feature en un worktree sobre su rama.
    expect(daemon.repo.getFlow(parent.id)?.stage).toBe("review")
    expect(existsSync(join(reviewCwd, "web/photos/T3.ts"))).toBe(true)
  }, 60_000)

  test("sin integración automática el humano aprueba cada integración; una subtarea no publica", async () => {
    const { daemon, human, scripts, until } = await boot()
    const d = () => daemon
    const parent = (await human.call("work_items.create", {
      ...meta(),
      title: "Dos piezas",
      kind: "feature",
    })) as { id: string }
    scripts.push(async (t) => {
      await put(t, "brief", BRIEF)
      await advance(t, "design", { ceremony: "formal", reason: "contrato" })
    })
    scripts.push(async (t) => {
      await put(t, "spec", SPEC)
      await put(t, "design", DESIGN)
      await put(t, "tasks", "- [ ] A → `api/a/**` → R1\n- [ ] B → `web/b/**` → R2\n")
      await advance(t, "implement")
    })
    let pushError = ""
    scripts.push(
      subtaskScript(d, async (t) => {
        pushError = await t.agent
          .call("git.propose", { ...meta(), message: "x", push: { branch: "x" } })
          .then(() => "")
          .catch((e: Error) => e.message)
      }),
    )
    await human.call("tasks.work", { ...meta(), work_item_id: parent.id })
    await until(() => daemon.repo.pendingStageGate(parent.id) !== null, "gate (a)")
    await approveGate(human, daemon, parent.id)
    await until(
      () =>
        daemon.repo.getFlow(parent.id)?.stage === "design" &&
        daemon.repo.pendingStageGate(parent.id) !== null,
      "gate (b)",
    )
    await approveGate(human, daemon, parent.id)
    const [a, b] = daemon.repo.childrenOf(parent.id)
    // Sin fases, ninguna espera a la otra, pero corren una a la vez.
    expect(daemon.repo.getWorkItem(b?.id as string)?.lifecycle).toBe("planned")
    await until(
      () =>
        daemon.repo
          .listApprovals(daemon.repo.getWorkItem(a?.id as string)?.project_id as string)
          .some((x) => JSON.parse(x.operation_json).tool === "git.plan"),
      "el plan de la primera",
    )
    expect(pushError).toContain("una subtarea no hace push ni PR")
    expect(daemon.repo.liveRunFor(b?.id as string)).toBeNull()
  }, 60_000)
})
