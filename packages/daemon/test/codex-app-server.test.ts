/**
 * ADR-0008: transporte `app_server` de Codex. El app-server es un doble que
 * corre como proceso real (fixtures/fake-codex-app-server.ts) con las formas
 * del spike; el daemon, git y SQLite son reales.
 */
import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type CodexProfile, Daemon, errorCodeFromInfo, IpcClient, tomlValue } from "../src/index.ts"
import { initRepo } from "./git-fixture.ts"

const FAKE = join(import.meta.dir, "fixtures", "fake-codex-app-server.ts")
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
const key = () => `cxa-${++n}`
const meta = () => ({ request_id: "r", idempotency_key: key() })

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function boot(
  opts: { codex?: Partial<CodexProfile>; noAccount?: boolean; approvalMs?: number } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), "keel-cxa-"))
  dirs.push(dir)
  initRepo(join(dir, "repo"))
  const fakeLog = join(dir, "fake.ndjson")
  const daemon = new Daemon({
    dbPath: join(dir, "keel.sqlite"),
    socketPath: join(dir, "keel.sock"),
    rootPath: join(dir, "repo"),
    worktreesDir: join(dir, "worktrees"),
    adapterDeps: { binary: "/fake/claude" },
    profile: { approval_timeout_ms: opts.approvalMs ?? 60_000 },
    codex: { subscription_enabled: true, ...opts.codex },
    codexDeps: {
      appServerLaunch: (args) => ({
        command: process.execPath,
        args: [FAKE, ...args],
        env: {
          ...(process.env as Record<string, string>),
          FAKE_LOG: fakeLog,
          ...(opts.noAccount ? { FAKE_NO_ACCOUNT: "1" } : {}),
        },
      }),
    },
  })
  daemon.start()
  daemons.push(daemon)
  const start = async (prompt: string, purpose: "execute" | "plan" = "execute") => {
    const client = await IpcClient.connect(daemon.server.path)
    const w = (await client.call("work_items.create", {
      ...meta(),
      title: "codex app",
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
      prompt,
    })) as { id: string }
    return { client, run }
  }
  const fake = () =>
    existsSync(fakeLog)
      ? readFileSync(fakeLog, "utf8")
          .trim()
          .split("\n")
          .map((l) => JSON.parse(l) as Record<string, unknown>)
      : []
  const stored = (kind: string) =>
    daemon.repo
      .eventsAfter(0, null, 100_000)
      .filter((e) => e.kind === kind)
      .map((e) => JSON.parse(e.payload_json) as Record<string, unknown>)
  const manifest = (runId: string) =>
    JSON.parse(daemon.repo.getRun(runId)?.context_manifest_json ?? "{}") as Record<string, unknown>
  return { daemon, start, fake, stored, manifest }
}

describe("ADR-0008: transporte app_server", () => {
  test("un run execute: Keel posee el proceso, proyecta comandos y cambios, y no atiende el refresco de tokens", async () => {
    const { daemon, start, fake, stored, manifest } = boot()
    const { client, run } = await start("ok")
    await daemon.idle()
    client.close()

    expect(daemon.repo.getRun(run.id)).toMatchObject({
      status: "completed",
      cost_kind: "unknown",
      input_tokens: 900,
      output_tokens: 30,
    })
    const m = manifest(run.id)
    expect(m).toMatchObject({
      transport: "app_server",
      process_control: "owned",
      cancel_scope: "process",
      sandbox: "workspace-write",
      approval_policy: "on-request",
      session_id: "th-fake",
    })
    expect((m.provider_process as { pid: number }).pid).toBeGreaterThan(0)
    expect(m.quota).toMatchObject({ primary: { usedPercent: 3 } })

    const calls = daemon.store.db
      .query<
        { tool_name: string; label: string; state: string; duration_ms: number | null },
        [string]
      >(
        "SELECT tool_name, label, state, duration_ms FROM tool_calls WHERE run_id = ? ORDER BY started_at, tool_name",
      )
      .all(run.id)
    expect(calls).toEqual([
      { tool_name: "Bash", label: "/bin/bash -lc 'ls'", state: "succeeded", duration_ms: 12 },
      { tool_name: "Edit", label: "src/a.ts", state: "succeeded", duration_ms: null },
    ])
    // Los deltas no se guardan; el resto sí, con su método.
    expect(stored("codex.app.item/agentMessage/delta")).toHaveLength(0)
    expect(stored("codex.app.turn/completed")).toHaveLength(1)

    const log = fake()
    const refresh = log.find((e) => "refresh" in e)?.refresh as { error?: { message: string } }
    expect(refresh.error?.message).toContain("Keel no atiende")
    const argv = log[0]?.argv as string[]
    expect(argv[0]).toBe("app-server")
    expect(argv).toContain('mcp_servers.keel.default_tools_approval_mode="approve"')
    expect(argv).toContain("sandbox_workspace_write.network_access=false")
    // El puente va con la ruta del token, nunca su valor; al terminar el run se revoca.
    const env = argv.find((a) => a.startsWith("mcp_servers.keel.env=")) ?? ""
    const tokenFile = /"KEEL_RUN_TOKEN_FILE" = "([^"]+)"/.exec(env)?.[1]
    expect(tokenFile).toEndWith(".token")
    expect(existsSync(tokenFile as string)).toBe(false)
  })

  test("un run plan usa read-only y nunca pide aprobaciones", async () => {
    const { daemon, start, fake } = boot()
    const { client } = await start("ok", "plan")
    await daemon.idle()
    client.close()
    const threadStart = fake().find((e) => "threadStart" in e)?.threadStart
    expect(threadStart).toMatchObject({
      sandbox: "read-only",
      approvalPolicy: "never",
      ephemeral: true,
    })
  })

  test("la aprobación de un comando pasa por el gate: aprobar responde accept", async () => {
    const { daemon, start, fake } = boot()
    const { client, run } = await start("approval")
    let pending: { id: string; operation_hash: string } | undefined
    for (let i = 0; i < 300 && !pending; i++) {
      await Bun.sleep(10)
      pending =
        daemon.store.db
          .query<{ id: string; operation_hash: string }, [string]>(
            "SELECT id, operation_hash FROM approval_requests WHERE run_id = ? AND state = 'pending'",
          )
          .get(run.id) ?? undefined
    }
    expect(pending).toBeDefined()
    expect(daemon.repo.getRun(run.id)?.status).toBe("waiting_human")
    // La lista durable da al humano lo mismo que verá al aprobar: operación redactada y hash.
    const listed = (await client.call("approvals.list", {})) as {
      approvals: { id: string; operation_hash: string; work_item_id: string; operation: unknown }[]
    }
    expect(listed.approvals).toHaveLength(1)
    expect(listed.approvals[0]).toMatchObject({
      id: pending?.id,
      operation_hash: pending?.operation_hash,
      operation: { tool: "Bash" },
    })
    await client.call("approvals.resolve", {
      ...meta(),
      approval_id: pending?.id,
      operation_hash: pending?.operation_hash,
      decision: "approve_once",
    })
    await daemon.idle()
    client.close()
    expect(fake().find((e) => "approval" in e)?.approval).toEqual({ decision: "accept" })
    expect(daemon.repo.getRun(run.id)?.status).toBe("completed")
  })

  test("sin respuesta del humano, el gate deniega al vencer y Codex recibe decline", async () => {
    const { daemon, start, fake } = boot({ approvalMs: 200 })
    const { client, run } = await start("approval")
    await daemon.idle()
    client.close()
    expect(fake().find((e) => "approval" in e)?.approval).toEqual({ decision: "decline" })
    const call = daemon.store.db
      .query<{ state: string; error_message: string | null }, [string]>(
        "SELECT state, error_message FROM tool_calls WHERE run_id = ?",
      )
      .get(run.id)
    expect(call).toEqual({ state: "failed", error_message: "denegado por Keel" })
  })

  test("sin sesión de codex, el run falla como auth antes de abrir un hilo", async () => {
    const { daemon, start, fake, stored } = boot({ noAccount: true })
    const { client, run } = await start("ok")
    await daemon.idle()
    client.close()
    expect(daemon.repo.getRun(run.id)?.status).toBe("failed")
    expect(stored("run.failure")[0]).toMatchObject({
      category: "auth",
      user_action: "provider_login",
    })
    expect(fake().some((e) => "threadStart" in e)).toBe(false)
  })

  test("errores con código: 401 es auth y el límite de uso es interrupted", async () => {
    for (const [prompt, expected] of [
      ["fail401", { status: "failed", end_reason: "fatal_error" }],
      ["usage", { status: "interrupted", end_reason: "rate_limit" }],
    ] as const) {
      const { daemon, start, manifest } = boot()
      const { client, run } = await start(prompt)
      await daemon.idle()
      client.close()
      expect(daemon.repo.getRun(run.id)).toMatchObject(expected)
      if (prompt === "fail401")
        expect(manifest(run.id).outcome).toMatchObject({
          category: "auth",
          provider_error: "authentication_failed",
        })
    }
  })

  test("cancelar interrumpe el turno y cierra el app-server: el comando en curso muere con él", async () => {
    const { daemon, start, fake, stored } = boot()
    const { client, run } = await start("hang")
    let childPid: number | undefined
    for (let i = 0; i < 300 && !childPid; i++) {
      await Bun.sleep(10)
      childPid = fake().find((e) => "child" in e)?.child as number | undefined
    }
    expect(childPid).toBeDefined()
    await client.call("runs.cancel", { ...meta(), run_id: run.id })
    await daemon.idle()
    client.close()
    expect(daemon.repo.getRun(run.id)?.status).toBe("cancelled")
    expect(stored("run.cancelled")).toHaveLength(1)
    expect(fake().some((e) => "interrupt" in e)).toBe(true)
    const serverPid = (fake()[0]?.pid as number) ?? 0
    for (let i = 0; i < 100 && (alive(serverPid) || alive(childPid as number)); i++)
      await Bun.sleep(20)
    expect(alive(serverPid)).toBe(false)
    expect(alive(childPid as number)).toBe(false)
  })

  test("si el app-server muere a mitad del turno, el run queda interrupted por caída del proveedor", async () => {
    const { daemon, start, manifest } = boot()
    const { client, run } = await start("crash")
    await daemon.idle()
    client.close()
    // ADR-0006: un proveedor caído es `interrupted` con reintento, nunca éxito.
    expect(daemon.repo.getRun(run.id)?.status).toBe("interrupted")
    expect(manifest(run.id).outcome).toMatchObject({
      category: "provider_crashed",
      provider_error: "exit 3",
    })
  })

  test("codexErrorInfo y valores TOML", () => {
    expect(errorCodeFromInfo({ httpConnectionFailed: { httpStatusCode: 401 } })).toBe(
      "authentication_failed",
    )
    expect(errorCodeFromInfo("usageLimitExceeded")).toBe("rate_limit")
    expect(errorCodeFromInfo("serverOverloaded")).toBe("overloaded")
    expect(errorCodeFromInfo({ responseStreamConnectionFailed: { httpStatusCode: 503 } })).toBe(
      "server_error",
    )
    expect(errorCodeFromInfo("other")).toBeNull()
    expect(tomlValue({ A: 'x"y', B: ["1", 2] })).toBe('{ "A" = "x\\"y", "B" = ["1", 2] }')
  })
})
