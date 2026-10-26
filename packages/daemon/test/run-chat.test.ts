/**
 * ADR-0020: preguntas del agente contestadas desde el chat, aprobaciones que no
 * vencen, patrón editable, modo y modelo en vivo, modelos de la cuenta y
 * sugerencias. Daemon, git y SQLite reales; el proveedor es una `Query` falsa
 * que pide permiso por `canUseTool` y anota lo que el daemon le cambia.
 */
import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
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
const meta = () => ({ request_id: "r", idempotency_key: `chat-${++n}` })
type Op = { tool: string; input: Record<string, unknown> }
type Approval = {
  id: string
  operation_hash: string
  expires_at: string | null
  state: string
  operation: { tool: string; input: Record<string, unknown> }
}

/** Lo que el daemon le hizo a la `Query`. */
type Control = {
  options?: Options
  results: PermissionResult[]
  modes: string[]
  models: string[]
  flags: unknown[]
}

/** Una `Query` falsa: pide cada operación y, si `hold`, espera antes de terminar. */
function liveQuery(ops: Op[], ctl: Control, hold: Promise<void> = Promise.resolve()): QueryFn {
  return ({ options }) => {
    ctl.options = options
    const gen = (async function* () {
      yield { type: "system", subtype: "init", session_id: "s", model: "opus", uuid: "u0" } as never
      for (const op of ops) {
        const d = await options.canUseTool?.(op.tool, op.input, {
          signal: new AbortController().signal,
          suggestions: [],
        } as never)
        if (d) ctl.results.push(d)
      }
      await hold
      yield {
        type: "result",
        subtype: "success",
        uuid: "u1",
        session_id: "s",
        is_error: false,
        result: "ok",
        total_cost_usd: 0.001,
        usage: { input_tokens: 1, output_tokens: 1 },
      } as unknown as SDKMessage
    })()
    return Object.assign(gen, {
      setPermissionMode: async (m: string) => {
        ctl.modes.push(m)
      },
      setModel: async (m?: string) => {
        ctl.models.push(m ?? "")
      },
      applyFlagSettings: async (f: unknown) => {
        ctl.flags.push(f)
      },
      supportedModels: async () => [
        {
          value: "opus",
          displayName: "Opus 5.5",
          description: "el más capaz",
          supportsEffort: true,
          supportedEffortLevels: ["low", "medium", "high", "max"],
        },
        { value: "haiku", displayName: "Haiku 5.5", description: "rápido" },
      ],
    }) as never
  }
}

async function boot(profile: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "keel-chat-"))
  dirs.push(dir)
  initRepo(join(dir, "repo"))
  let next: QueryFn = liveQuery([], newControl())
  const daemon = new Daemon({
    dbPath: join(dir, "keel.sqlite"),
    socketPath: join(dir, "keel.sock"),
    rootPath: join(dir, "repo"),
    worktreesDir: join(dir, "worktrees"),
    adapterDeps: { queryFn: (a) => next(a), binary: "/fake/claude" },
    profile,
    mcpBridge: false,
  })
  daemon.start()
  daemons.push(daemon)
  const human = await IpcClient.connect(daemon.server.path)
  clients.push(human)

  async function start(query: QueryFn, options: Record<string, unknown> = {}) {
    next = query
    const w = (await human.call("work_items.create", { ...meta(), title: "t", kind: "chore" })) as {
      id: string
    }
    await human.call("work_items.transition", { ...meta(), work_item_id: w.id, to: "planned" })
    return (await human.call("runs.start", {
      ...meta(),
      work_item_id: w.id,
      purpose: "execute",
      options,
    })) as { id: string; work_item_id: string }
  }
  async function pending(runId: string): Promise<Approval> {
    for (;;) {
      const { approvals } = (await human.call("approvals.list", { run_id: runId })) as {
        approvals: Approval[]
      }
      const a = approvals.find((x) => x.state === "pending")
      if (a) return a
      await Bun.sleep(10)
    }
  }
  async function finished(runId: string) {
    while (!["completed", "failed", "cancelled"].includes(daemon.repo.getRun(runId)?.status ?? ""))
      await Bun.sleep(10)
    await daemon.idle()
  }
  const resolve = (a: Approval, extra: Record<string, unknown>) =>
    human.call("approvals.resolve", {
      ...meta(),
      approval_id: a.id,
      operation_hash: a.operation_hash,
      ...extra,
    })
  const events = (runId: string, kind: string) =>
    daemon.repo
      .eventsAfter(0, null, 100_000)
      .filter((e) => e.kind === kind && e.run_id === runId)
      .map((e) => JSON.parse(e.payload_json) as Record<string, unknown>)
  return { daemon, human, start, pending, finished, resolve, events }
}

function newControl(): Control {
  return { results: [], modes: [], models: [], flags: [] }
}

const question = (q: string): Op => ({
  tool: "AskUserQuestion",
  input: {
    questions: [
      {
        question: q,
        header: "Paginación",
        multiSelect: false,
        options: [
          { label: "Todos de una vez", description: "simple" },
          { label: "Paginado de 50", description: "con cursor" },
        ],
      },
    ],
  },
})

describe("ADR-0020 §7: las preguntas del agente se contestan en el chat", () => {
  test("la respuesta vuelve al SDK en updatedInput.answers; sin respuestas no se aprueba", async () => {
    // Un límite corto no toca a las preguntas: el tiempo no contesta por el humano.
    const s = await boot({ approval_timeout_ms: 50 })
    const ctl = newControl()
    const q = "¿Cómo cargo los capítulos?"
    const run = await s.start(liveQuery([question(q)], ctl))
    const a = await s.pending(run.id)
    expect(a.expires_at).toBeNull()
    await Bun.sleep(120)
    expect((await s.pending(run.id)).id).toBe(a.id)

    await expect(s.resolve(a, { decision: "approve_session" })).rejects.toThrow("se contesta")
    await expect(s.resolve(a, { decision: "approve_once" })).rejects.toThrow("faltan respuestas")
    await s.resolve(a, {
      decision: "approve_once",
      answers: { [q]: "Paginado de 50" },
      annotations: { [q]: { notes: "usa el mismo cursor que fotos" } },
    })
    await s.finished(run.id)
    expect(ctl.results[0]).toMatchObject({
      behavior: "allow",
      updatedInput: {
        questions: [{ question: q }],
        answers: { [q]: "Paginado de 50" },
        annotations: { [q]: { notes: "usa el mismo cursor que fotos" } },
      },
    })
    expect(s.events(run.id, "approval.resolved")[0]).toMatchObject({
      decision: "approved",
      answers: { [q]: "Paginado de 50" },
    })
  })

  test("no contestar le dice al agente que el humano no quiso, con su motivo", async () => {
    const s = await boot()
    const ctl = newControl()
    const run = await s.start(liveQuery([question("¿Sí o no?")], ctl))
    await s.resolve(await s.pending(run.id), { decision: "deny", reason: "decide tú" })
    await s.finished(run.id)
    expect(ctl.results[0]).toMatchObject({ behavior: "deny" })
    expect((ctl.results[0] as { message: string }).message).toContain(
      "no quiso contestar la pregunta: decide tú",
    )
  })

  test("aprobar un plan y pasar a aceptar ediciones lo aplica el SDK al permitir", async () => {
    const s = await boot()
    const ctl = newControl()
    const run = await s.start(
      liveQuery([{ tool: "ExitPlanMode", input: { plan: "1. hacer" } }], ctl),
      {
        permission_mode: "plan",
      },
    )
    await s.resolve(await s.pending(run.id), {
      decision: "approve_once",
      then_mode: "accept_edits",
    })
    await s.finished(run.id)
    expect(ctl.results[0]).toMatchObject({
      behavior: "allow",
      updatedPermissions: [{ type: "setMode", mode: "acceptEdits", destination: "session" }],
    })
    expect(s.events(run.id, "run.mode_changed")[0]).toMatchObject({
      from: "plan",
      to: "accept_edits",
    })
  })
})

describe("ADR-0020 §2–§3: aprobaciones sin vencimiento y con patrón editable", () => {
  test("por defecto una aprobación espera sin límite y al aprobarla el run sigue", async () => {
    const s = await boot()
    expect(s.daemon.settingsView().approvals.timeout_ms).toBeNull()
    const ctl = newControl()
    const run = await s.start(liveQuery([{ tool: "Bash", input: { command: "bun test" } }], ctl))
    const a = await s.pending(run.id)
    expect(a.expires_at).toBeNull()
    await Bun.sleep(100)
    expect(s.daemon.repo.getRun(run.id)?.status).toBe("waiting_human")
    // ADR-0006 §4: la tarjeta sigue al lifecycle; antes se quedaba en backlog.
    const column = async () =>
      (
        (await s.human.call("work_items.get", { work_item_id: run.work_item_id })) as {
          item: { board_status: string }
        }
      ).item.board_status
    expect(await column()).toBe("in_progress")
    await s.resolve(a, { decision: "approve_once" })
    await s.finished(run.id)
    expect(ctl.results.map((r) => r.behavior)).toEqual(["allow"])
    expect(s.daemon.repo.getRun(run.id)?.status).toBe("completed")
    expect(await column()).toBe("in_review")
  })

  test("el humano fija un límite en Ajustes; al vencer se niega", async () => {
    const s = await boot()
    const view = (await s.human.call("settings.update", {
      ...meta(),
      approvals_timeout_ms: 60_000,
    })) as { approvals: { timeout_ms: number | null } }
    expect(view.approvals.timeout_ms).toBe(60_000)
    await expect(
      s.human.call("settings.update", { ...meta(), approvals_timeout_ms: 5 }),
    ).rejects.toThrow()
    const ctl = newControl()
    const run = await s.start(liveQuery([{ tool: "Bash", input: { command: "ls" } }], ctl))
    const a = await s.pending(run.id)
    expect(a.expires_at).not.toBeNull()
    await s.resolve(a, { decision: "deny" })
    await s.finished(run.id)
  })

  test("aprobar `cd *` en la sesión deja pasar otro cd, nunca un encadenamiento", async () => {
    const s = await boot()
    const ctl = newControl()
    const bash = (command: string): Op => ({ tool: "Bash", input: { command } })
    const run = await s.start(
      liveQuery([bash("cd /home/x/repo"), bash("cd ../otra"), bash("cd x && rm -rf y")], ctl),
    )
    const first = await s.pending(run.id)
    await expect(
      s.resolve(first, { decision: "approve_session", pattern: "cd x && *" }),
    ).rejects.toThrow("patrón no válido")
    await expect(
      s.resolve(first, { decision: "approve_session", pattern: "ls *" }),
    ).rejects.toThrow("no cubre")
    await expect(s.resolve(first, { decision: "approve_session", pattern: "*" })).rejects.toThrow(
      "bypass",
    )
    await s.resolve(first, { decision: "approve_session", pattern: "cd *" })
    const third = await s.pending(run.id)
    expect(third.operation.input.command).toBe("cd x && rm -rf y")
    await s.resolve(third, { decision: "deny" })
    await s.finished(run.id)
    expect(ctl.results.map((r) => r.behavior)).toEqual(["allow", "allow", "deny"])
    expect(s.events(run.id, "approval.auto")[0]).toMatchObject({ label: "Bash(cd:*)" })
  })
})

describe("ADR-0020 §4–§6: control en vivo, modelos y sugerencias", () => {
  test("pasar a bypass y cambiar modelo con el run vivo; queda el actor humano", async () => {
    const s = await boot()
    const ctl = newControl()
    let release: () => void = () => {}
    const hold = new Promise<void>((r) => {
      release = r
    })
    const run = await s.start(liveQuery([], ctl, hold))
    while (!ctl.options) await Bun.sleep(10)
    // Se declara al lanzar para poder pasar a bypass después (execute con git).
    expect(ctl.options.allowDangerouslySkipPermissions).toBe(true)
    expect(ctl.options.permissionMode).toBe("default")

    const moved = (await s.human.call("runs.set_mode", {
      ...meta(),
      run_id: run.id,
      permission_mode: "bypass",
    })) as { run: { options: { permission_mode: string } }; applies: string }
    expect(moved.applies).toBe("now")
    expect(moved.run.options.permission_mode).toBe("bypass")
    await s.human.call("runs.set_model", {
      ...meta(),
      run_id: run.id,
      model: "haiku",
      effort: "high",
    })
    // `idle()` esperaría al run, que sigue vivo: basta con que lleguen los cambios.
    while (ctl.flags.length === 0) await Bun.sleep(10)
    expect(ctl.modes).toEqual(["bypassPermissions"])
    expect(ctl.models).toEqual(["haiku"])
    expect(ctl.flags).toEqual([{ effortLevel: "high" }])
    expect(s.events(run.id, "run.mode_changed")[0]).toMatchObject({
      from: "ask",
      to: "bypass",
      actor: { kind: "human" },
    })
    expect(s.events(run.id, "run.model_changed")[0]).toMatchObject({
      to: { model: "haiku", effort: "high" },
    })
    release()
    await s.finished(run.id)
    await expect(
      s.human.call("runs.set_mode", { ...meta(), run_id: run.id, permission_mode: "ask" }),
    ).rejects.toThrow("completed")
  })

  test("providers.models sale del SDK; las sugerencias se piden salvo que el humano las apague", async () => {
    const s = await boot()
    const models = (await s.human.call("providers.models", { provider: "claude" })) as {
      models: { value: string; display_name: string; description: string; efforts: string[] }[]
      source: string
    }
    expect(models.source).toBe("sdk")
    expect(models.models).toEqual([
      {
        value: "opus",
        display_name: "Opus 5.5",
        description: "el más capaz",
        efforts: ["low", "medium", "high", "max"],
      },
      { value: "haiku", display_name: "Haiku 5.5", description: "rápido", efforts: [] },
    ])

    const on = newControl()
    const a = await s.start(liveQuery([], on), { effort: "max" })
    await s.finished(a.id)
    expect(on.options).toMatchObject({ promptSuggestions: true, effort: "max" })

    await s.human.call("settings.update", { ...meta(), prompt_suggestions: false })
    const off = newControl()
    const b = await s.start(liveQuery([], off))
    await s.finished(b.id)
    expect(off.options?.promptSuggestions).toBeUndefined()
  })
})
