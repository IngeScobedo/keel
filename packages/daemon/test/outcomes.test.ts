/**
 * DoD de la Fase 1 (SDD 04): auth expirada, proveedor sin capacidad, proceso del
 * proveedor muerto y stream incompleto tienen salidas explícitas. El SDK es un
 * guion; el «proceso muerto» es un proceso real que sale con código 3.
 */
import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import type { EventNotification, RunOutcome } from "@keel/core"
import {
  ApprovalGate,
  ClaudeAdapter,
  type ClaudeProfile,
  createRunContext,
  DEFAULT_PROFILE,
  EventBus,
  openStore,
  type QueryFn,
  Repo,
  SOURCE,
} from "../src/index.ts"
import { hangingQuery } from "./replay.ts"

const cleanup: (() => void)[] = []
afterEach(() => {
  for (const f of cleanup.splice(0)) f()
})

const init = { type: "system", subtype: "init", session_id: "s1", model: "haiku", uuid: "u-init" }
const resultMsg = (subtype: string, isError: boolean, extra: Record<string, unknown> = {}) => ({
  type: "result",
  subtype,
  is_error: isError,
  usage: { input_tokens: 1, output_tokens: 1 },
  total_cost_usd: 0,
  errors: [],
  uuid: `u-${subtype}`,
  session_id: "s1",
  ...extra,
})
const assistantError = (error: string) => ({
  type: "assistant",
  message: { content: [{ type: "text", text: "API Error" }] },
  parent_tool_use_id: null,
  error,
  uuid: `u-a-${error}`,
  session_id: "s1",
})

/** SDK guionado: emite mensajes y, opcionalmente, lanza al final como el SDK cuando el proceso muere. */
function scripted(
  messages: Record<string, unknown>[],
  opts: { before?: (o: Options) => Promise<void> | void; throwAtEnd?: string } = {},
): QueryFn {
  return ({ options }) =>
    (async function* () {
      await opts.before?.(options)
      for (const m of messages) yield m as unknown as SDKMessage
      if (opts.throwAtEnd) throw new Error(opts.throwAtEnd)
    })()
}

async function run(queryFn: QueryFn, profile: Partial<ClaudeProfile> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "keel-outcome-"))
  const store = openStore(join(dir, "keel.sqlite"), { loadVector: false })
  cleanup.push(() => {
    store.db.close()
    rmSync(dir, { recursive: true, force: true })
  })
  const repo = new Repo(store.db)
  const bus = new EventBus()
  const events: EventNotification[] = []
  bus.subscribe((e) => events.push(e))
  const { project_id } = repo.ensureDefaultProject(dir)
  const w = repo.createWorkItem({ project_id, title: "t", kind: "chore" })
  const r = repo.createRun({ project_id, work_item_id: w.id, purpose: "execute" })
  const adapter = new ClaudeAdapter({ queryFn, binary: "/fake/claude" })
  const ctx = createRunContext({
    repo,
    bus,
    run: r,
    gate: new ApprovalGate({ repo, waitApproval: async () => "expired", timeoutMs: 20 }),
    source: SOURCE,
    adapterVersion: adapter.adapterVersion,
  })
  const final = await adapter.execute(ctx, "p", { ...DEFAULT_PROFILE, cwd: dir, ...profile })
  const failure = events.find((e) => e.kind === "run.failure")?.payload as
    | (RunOutcome & { exit: unknown; provider_errors: string[] })
    | undefined
  return { final, failure, repo, runId: r.id }
}

describe("Fase 1: el run termina con una salida explícita, nunca con éxito inventado", () => {
  test("auth caducada con sesión de suscripción: failed, categoría auth y acción iniciar sesión en el proveedor", async () => {
    const { final, failure } = await run(
      scripted([init, assistantError("authentication_failed"), resultMsg("success", true)]),
    )
    expect(final).toMatchObject({ status: "failed", end_reason: "fatal_error" })
    expect(failure).toMatchObject({
      category: "auth",
      provider_error: "authentication_failed",
      user_action: "provider_login",
      retryable: false,
    })
  })

  test("rate limit: interrupted con end_reason rate_limit (ADR-0006 §5)", async () => {
    const { final, failure } = await run(
      scripted([init, assistantError("rate_limit"), resultMsg("success", true)]),
    )
    expect(final).toMatchObject({ status: "interrupted", end_reason: "rate_limit" })
    expect(failure?.user_action).toBe("wait_and_retry")
  })

  test("proveedor sin capacidad (CLI viejo al arrancar): failed con acción actualizar", async () => {
    const { final, failure } = await run(
      scripted([
        resultMsg("error_during_execution", true, {
          startup_failure_reason: "cli_version_too_old",
          errors: ["Claude Code 1.0 es demasiado viejo"],
        }),
      ]),
    )
    expect(final.status).toBe("failed")
    expect(failure).toMatchObject({ category: "capability", user_action: "update_provider" })
    expect(failure?.provider_errors).toEqual(["Claude Code 1.0 es demasiado viejo"])
  })

  test("el proceso del proveedor muere (código 3): interrupted, provider_crashed y la salida registrada", async () => {
    const { final, failure } = await run(
      scripted([init], {
        // Como el SDK real: lanza el proceso por la función de Keel, que lo registra.
        before: (o) =>
          new Promise<void>((ok) => {
            const child = o.spawnClaudeCodeProcess?.({
              command: process.execPath,
              args: ["-e", "process.exit(3)"],
              env: process.env,
              signal: new AbortController().signal,
            })
            child?.once("exit", () => ok())
          }),
        throwAtEnd: "Claude Code process exited with code 3",
      }),
    )
    expect(final).toMatchObject({ status: "interrupted", end_reason: "interrupted" })
    expect(failure).toMatchObject({
      category: "provider_crashed",
      provider_error: "exit 3",
      exit: { code: 3, signal: null },
    })
  })

  test("el stream se corta sin result: interrupted, stream_incomplete", async () => {
    const { final, failure } = await run(scripted([init]))
    expect(final).toMatchObject({ status: "interrupted", end_reason: "interrupted" })
    expect(failure?.category).toBe("stream_incomplete")
  })

  test("supervisor: al vencer el tiempo máximo el run se aborta con end_reason timeout", async () => {
    const { final, failure, repo, runId } = await run(hangingQuery(), { max_wall_ms: 100 })
    expect(final).toMatchObject({ status: "interrupted", end_reason: "timeout" })
    expect(failure).toMatchObject({ category: "timeout", user_action: "raise_limit" })
    expect(repo.toolCallsOfRun(runId).map((t) => t.state)).toEqual(["interrupted"])
  })
})
