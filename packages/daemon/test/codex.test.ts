/**
 * ADR-0008: adaptador de Codex con el transporte `sdk`. El SDK es un doble
 * que emite eventos con la forma medida en el spike; el daemon, git y SQLite
 * son reales.
 */
import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { CodexOptions, ThreadEvent, ThreadOptions, TurnOptions } from "@openai/codex-sdk"
import { type CodexProfile, codexErrorCode, Daemon, IpcClient } from "../src/index.ts"
import { initRepo } from "./git-fixture.ts"

const dirs: string[] = []
const daemons: Daemon[] = []
afterEach(async () => {
  for (const d of daemons.splice(0)) {
    await d.idle()
    d.stop()
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

let n = 0
const key = () => `cx-${++n}`
const meta = () => ({ request_id: "r", idempotency_key: key() })

type Seen = {
  codex?: CodexOptions | undefined
  thread?: ThreadOptions | undefined
  turn?: TurnOptions | undefined
}
type Script = (turn: TurnOptions) => AsyncGenerator<ThreadEvent>

const ok: Script = async function* () {
  yield { type: "thread.started", thread_id: "th-1" }
  yield { type: "turn.started" }
  yield {
    type: "item.started",
    item: {
      id: "c1",
      type: "command_execution",
      command: "ls src",
      aggregated_output: "",
      status: "in_progress",
    },
  }
  yield {
    type: "item.completed",
    item: {
      id: "c1",
      type: "command_execution",
      command: "ls src",
      aggregated_output: "a.ts\n",
      exit_code: 0,
      status: "completed",
    },
  }
  yield {
    type: "item.completed",
    item: {
      id: "f1",
      type: "file_change",
      changes: [{ path: "src/a.ts", kind: "update" }],
      status: "completed",
    },
  }
  yield {
    type: "turn.completed",
    usage: {
      input_tokens: 1200,
      cached_input_tokens: 800,
      cache_write_input_tokens: 0,
      output_tokens: 40,
      reasoning_output_tokens: 10,
    },
  }
}

const failing = (message: string): Script =>
  async function* () {
    yield { type: "thread.started", thread_id: "th-2" }
    yield { type: "turn.failed", error: { message } }
  }

/** Un turno que sólo termina cuando Keel lo aborta, como el SDK con `signal`. */
const hanging: Script = async function* (turn) {
  yield { type: "thread.started", thread_id: "th-3" }
  await new Promise<void>((_, reject) =>
    turn.signal?.addEventListener("abort", () =>
      reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
    ),
  )
}

function boot(script: Script, codex: Partial<CodexProfile> = {}, login = 0) {
  const dir = mkdtempSync(join(tmpdir(), "keel-codex-"))
  dirs.push(dir)
  initRepo(join(dir, "repo"))
  const seen: Seen = {}
  const daemon = new Daemon({
    dbPath: join(dir, "keel.sqlite"),
    socketPath: join(dir, "keel.sock"),
    rootPath: join(dir, "repo"),
    worktreesDir: join(dir, "worktrees"),
    adapterDeps: { binary: "/fake/claude" },
    codex: { transport: "sdk", subscription_enabled: true, ...codex },
    codexDeps: {
      loginStatus: async () => ({
        code: login,
        output: login === 0 ? "Logged in using ChatGPT" : "Not logged in",
      }),
      createCodex: (opts) => {
        seen.codex = opts
        return {
          startThread: (thread?: ThreadOptions) => {
            seen.thread = thread
            return {
              runStreamed: async (_prompt: unknown, turn?: TurnOptions) => {
                seen.turn = turn
                return { events: script(turn ?? {}) }
              },
            } as never
          },
        }
      },
    },
  })
  daemon.start()
  daemons.push(daemon)
  const start = async (purpose: "execute" | "plan" = "execute") => {
    const client = await IpcClient.connect(daemon.server.path)
    const w = (await client.call("work_items.create", {
      ...meta(),
      title: "con codex",
      kind: "chore",
    })) as {
      id: string
    }
    if (purpose === "execute")
      await client.call("work_items.transition", { ...meta(), work_item_id: w.id, to: "planned" })
    const run = (await client.call("runs.start", {
      ...meta(),
      work_item_id: w.id,
      purpose,
      profile: "codex",
    })) as { id: string }
    return { client, run }
  }
  const stored = (kind: string) =>
    daemon.repo
      .eventsAfter(0, null, 100_000)
      .filter((e) => e.kind === kind)
      .map((e) => JSON.parse(e.payload_json) as Record<string, unknown>)
  const manifest = (runId: string) =>
    JSON.parse(daemon.repo.getRun(runId)?.context_manifest_json ?? "{}") as Record<string, unknown>
  return { daemon, seen, start, stored, manifest }
}

describe("ADR-0008: adaptador de Codex, transporte sdk", () => {
  test("un run execute corre en su worktree con sandbox workspace-write, red apagada y sin aprobaciones", async () => {
    const { daemon, seen, start, manifest } = boot(ok)
    const { client, run } = await start()
    await daemon.idle()
    client.close()

    const done = daemon.repo.getRun(run.id)
    expect(done).toMatchObject({
      status: "completed",
      cost_kind: "unknown",
      input_tokens: 1200,
      output_tokens: 40,
    })
    expect(done?.total_cost_micro_usd).toBeNull()
    expect(seen.thread).toMatchObject({
      sandboxMode: "workspace-write",
      approvalPolicy: "never",
      networkAccessEnabled: false,
    })
    expect(seen.thread?.workingDirectory).toContain("worktrees")
    expect(manifest(run.id)).toMatchObject({
      provider: "codex",
      transport: "sdk",
      process_control: "indirect",
      cancel_scope: "turn",
      session_id: "th-1",
    })
    const calls = daemon.store.db
      .query<{ tool_name: string; label: string; state: string }, [string]>(
        "SELECT tool_name, label, state FROM tool_calls WHERE run_id = ? ORDER BY started_at, tool_name",
      )
      .all(run.id)
    expect(calls).toEqual([
      { tool_name: "Bash", label: "ls src", state: "succeeded" },
      { tool_name: "Edit", label: "src/a.ts", state: "succeeded" },
    ])
  })

  test("un run plan usa el sandbox read-only", async () => {
    const { daemon, seen, start } = boot(ok)
    const { client } = await start("plan")
    await daemon.idle()
    client.close()
    expect(seen.thread?.sandboxMode).toBe("read-only")
  })

  test("sin habilitar la suscripción, el run falla antes de lanzar Codex", async () => {
    const { daemon, seen, start, stored } = boot(ok, { subscription_enabled: false })
    const { client, run } = await start()
    await daemon.idle()
    client.close()
    expect(daemon.repo.getRun(run.id)?.status).toBe("failed")
    expect(String(stored("run.start_failed")[0]?.message)).toContain("--codex-subscription")
    expect(seen.thread).toBeUndefined()
  })

  test("el humano habilita la suscripción desde la GUI y el ajuste queda con su autor", async () => {
    const { daemon, seen, start } = boot(ok, { subscription_enabled: false })
    const human = await IpcClient.connect(daemon.server.path)
    expect(await human.call("settings.get", {})).toMatchObject({
      codex_subscription: { enabled: false, source: "off" },
    })
    const set = (await human.call("settings.codex_subscription_set", {
      ...meta(),
      enabled: true,
    })) as { codex_subscription: { enabled: boolean; source: string; updated_by: string } }
    expect(set.codex_subscription).toMatchObject({ enabled: true, source: "setting" })
    expect(set.codex_subscription.updated_by).toBeTruthy()
    const { client, run } = await start()
    await daemon.idle()
    client.close()
    human.close()
    expect(daemon.repo.getRun(run.id)?.status).toBe("completed")
    expect(seen.thread).toBeDefined()
  })

  test("sin sesión de codex, el run falla como auth y pide codex login, sin fallback", async () => {
    const { daemon, seen, start, stored } = boot(ok, {}, 1)
    const { client, run } = await start()
    await daemon.idle()
    client.close()
    expect(daemon.repo.getRun(run.id)?.status).toBe("failed")
    expect(stored("run.failure")[0]).toMatchObject({
      category: "auth",
      user_action: "provider_login",
    })
    expect(String(stored("run.failure")[0]?.message)).toContain("codex login")
    expect(seen.thread).toBeUndefined()
  })

  test("un turno fallido por 401 es auth; por límite de uso es interrupted; lo desconocido nunca es éxito", async () => {
    for (const [message, expected] of [
      ["unexpected status 401 Unauthorized", { status: "failed", end_reason: "fatal_error" }],
      [
        "You've hit your usage limit. Try again later.",
        { status: "interrupted", end_reason: "rate_limit" },
      ],
      ["algo raro pasó", { status: "failed", end_reason: "fatal_error" }],
    ] as const) {
      const { daemon, start, manifest } = boot(failing(message))
      const { client, run } = await start()
      await daemon.idle()
      client.close()
      expect(daemon.repo.getRun(run.id)).toMatchObject(expected)
      const outcome = manifest(run.id).outcome as { category: string }
      expect(outcome.category).not.toBe("completed")
    }
    // Tres daemons con su repo git seguidos: en Windows pasa de los 5 s por defecto.
  }, 30_000)

  test("cancelar aborta el turno y el run queda cancelled", async () => {
    const { daemon, start, stored } = boot(hanging)
    const { client, run } = await start()
    for (let i = 0; i < 100 && daemon.repo.getRun(run.id)?.status !== "running"; i++)
      await Bun.sleep(10)
    await client.call("runs.cancel", { ...meta(), run_id: run.id })
    await daemon.idle()
    client.close()
    expect(daemon.repo.getRun(run.id)?.status).toBe("cancelled")
    expect(stored("run.cancelled")).toHaveLength(1)
  })

  test("el puente keel mcp llega a Codex por config con la ruta del token, nunca su valor", async () => {
    const { daemon, seen, start } = boot(ok)
    const { client } = await start()
    await daemon.idle()
    client.close()
    const config = (seen.codex as CodexOptions).config as {
      mcp_servers: Record<string, { env: Record<string, string> }>
    }
    const keel = config.mcp_servers.keel
    expect(keel?.env.KEEL_RUN_TOKEN_FILE).toEndWith(".token")
    // El puente entra por la puerta de agentes (ADR-0018 §2).
    expect(keel?.env.KEEL_SOCKET).toBe(daemon.agentServer.path)
    expect(keel).toMatchObject({ default_tools_approval_mode: "approve" })
  })

  test("reglas de errores de Codex, versionadas", () => {
    expect(codexErrorCode("stream error: 401 Unauthorized")).toBe("authentication_failed")
    expect(codexErrorCode("429 Too Many Requests")).toBe("rate_limit")
    expect(codexErrorCode("insufficient_quota")).toBe("billing_error")
    expect(codexErrorCode("model gpt-x does not exist")).toBe("model_not_found")
    expect(codexErrorCode("nada conocido")).toBe("codex_unrecognized_error")
  })
})
