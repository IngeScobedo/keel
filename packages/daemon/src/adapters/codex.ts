/**
 * Adaptador de Codex (ADR-0008, aceptado). Un adaptador lógico y transportes
 * debajo; aquí está el primero, `sdk` (`@openai/codex-sdk`), para runs
 * desatendidos. El transporte `app_server` entra después, según su spike
 * (docs/reviews/2026-10-22-spike-codex-app-server.md).
 *
 * Lo medido que condiciona este transporte:
 * - El SDK lanza `codex exec` y no expone el proceso: `process_control:
 *   "indirect"`. Keel no conoce el pid; tras un reinicio el run queda
 *   `interrupted` (ADR-0008 §5).
 * - Sin callback por herramienta: `approvalPolicy: "never"`, sandbox
 *   `read-only` para `plan`/`triage_eval` y `workspace-write` con la red
 *   apagada para `execute` (ADR-0008 §3). Lo que pediría aprobación falla.
 * - Cancelar aborta el turno, pero el comando en curso puede seguir vivo
 *   (spike, prueba 10): `cancel_scope: "turn"`.
 * - Los errores llegan como texto: se traducen con reglas versionadas
 *   (`CODEX_ERROR_RULES`) y lo que no se reconoce queda como desconocido.
 * - Costo: sólo tokens. `cost_kind = unknown`; nunca dólares inventados.
 */
import { spawn } from "node:child_process"
import { classifyRunOutcome, type RunSignals, toolCallLabel } from "@keel/core"
import {
  Codex,
  type CodexOptions,
  type ThreadEvent,
  type ThreadItem,
  type ThreadOptions,
  type TurnOptions,
} from "@openai/codex-sdk"
import { nowIso } from "../ids.js"
import type { RunRow } from "../store/repo.js"
import type { Preflight, ProviderAdapter, ProviderCapabilities, RunContext } from "./provider.js"

export const CODEX_ADAPTER_VERSION = "codex-sdk/0.162.0"
export const CODEX_SOURCE = "codex-sdk"

export type CodexProfile = {
  auth_mode: "subscription_session" | "api_key"
  /** ADR-0008 §2: el modo suscripción va detrás de una opción explícita del usuario. */
  subscription_enabled: boolean
  /** null = el modelo por defecto de la cuenta. */
  model: string | null
  reasoning_effort: "minimal" | "low" | "medium" | "high" | null
  /** Red del sandbox en runs `execute`; apagada por defecto (ADR-0008 §3). */
  network_access: boolean
  max_wall_ms: number
  cwd: string
  /** Ruta al `codex` del usuario; null = el que encuentre el SDK. */
  codex_path: string | null
  /** El puente `keel mcp` y otros servidores stdio, como en el perfil de Claude. */
  mcp_servers: Record<string, { command: string; args: string[]; env: Record<string, string> }>
}

export const DEFAULT_CODEX_PROFILE: CodexProfile = {
  auth_mode: "subscription_session",
  subscription_enabled: false,
  model: null,
  reasoning_effort: "low",
  network_access: false,
  max_wall_ms: 30 * 60_000,
  cwd: process.cwd(),
  codex_path: null,
  mcp_servers: {},
}

/** Lo mínimo del SDK que usa el adaptador; los tests lo sustituyen. */
export type CodexLike = Pick<Codex, "startThread">
export type CodexAdapterDeps = {
  createCodex?: (opts: CodexOptions) => CodexLike
  /** `codex login status` en el entorno del run; código 0 = hay sesión. */
  loginStatus?: (codexPath: string | null) => Promise<{ code: number; output: string }>
}

/**
 * Reglas para traducir el texto de un error de Codex a un código que entiende
 * `classifyRunOutcome`. Versionadas: un cambio de reglas cambia la versión.
 * Medido en el spike: sin sesión llega `401` tras varios reintentos.
 */
export const CODEX_ERROR_RULES_VERSION = 1
export const CODEX_ERROR_RULES: readonly { code: string; test: RegExp }[] = [
  { code: "authentication_failed", test: /\b401\b|unauthori[sz]ed|not logged in|login required/i },
  { code: "billing_error", test: /insufficient_quota|billing/i },
  // En suscripción, el límite de uso se recupera al pasar la ventana: es esperar, no pagar.
  { code: "rate_limit", test: /\b429\b|rate.?limit|usage.?limit/i },
  { code: "overloaded", test: /overloaded|\b50[234]\b|server error|unavailable/i },
  {
    code: "model_not_found",
    test: /model.{0,40}(not found|does not exist|not supported|unknown)/i,
  },
]

export function codexErrorCode(message: string): string {
  return CODEX_ERROR_RULES.find((r) => r.test.test(message))?.code ?? "codex_unrecognized_error"
}

export class CodexAdapter implements ProviderAdapter<CodexProfile> {
  readonly provider = "codex"
  readonly adapterVersion = CODEX_ADAPTER_VERSION
  readonly capabilities: ProviderCapabilities = {
    auth_modes: ["subscription_session", "api_key"],
    subagents: false,
    tool_approval: false,
    approval_kinds: [],
    process_control: "indirect",
    budget_unit: "tokens",
    cancel_scope: "turn",
    cost_kind: "unknown",
    cancel_emits_result: false,
  }
  private readonly running = new Map<string, AbortController>()
  private readonly abortCause = new Map<string, "cancelled" | "timeout">()
  private readonly deps: CodexAdapterDeps
  constructor(deps: CodexAdapterDeps = {}) {
    this.deps = deps
  }

  get activeRuns(): number {
    return this.running.size
  }

  cancel(runId: string, reason: string | null): boolean {
    const abort = this.running.get(runId)
    if (!abort) return false
    this.abortCause.set(runId, "cancelled")
    abort.abort(reason ?? "cancelled")
    return true
  }

  preflight(profile: CodexProfile): Preflight {
    if (profile.auth_mode === "subscription_session" && !profile.subscription_enabled)
      return {
        ok: false,
        message:
          "el modo suscripción de Codex necesita habilitarse explícitamente (--codex-subscription, ADR-0008 §2)",
      }
    if (
      profile.auth_mode === "api_key" &&
      !process.env.OPENAI_API_KEY &&
      !process.env.CODEX_API_KEY
    )
      return { ok: false, message: "auth_mode api_key necesita OPENAI_API_KEY o CODEX_API_KEY" }
    return { ok: true }
  }

  async execute(ctx: RunContext, prompt: string, profile: CodexProfile): Promise<RunRow> {
    const { run, store } = ctx
    const pre = this.preflight(profile)
    if (!pre.ok) return ctx.fail(pre.message, "run.start_failed")

    const execute = run.purpose === "execute"
    const threadOptions: ThreadOptions = {
      workingDirectory: profile.cwd,
      sandboxMode: execute ? "workspace-write" : "read-only",
      approvalPolicy: "never",
      networkAccessEnabled: execute && profile.network_access,
      ...(profile.model ? { model: profile.model } : {}),
      ...(profile.reasoning_effort ? { modelReasoningEffort: profile.reasoning_effort } : {}),
    }
    store.updateRun(run.id, { status: "initializing", started_at: nowIso(), cost_kind: "unknown" })
    store.mergeManifest(run.id, {
      adapter: CODEX_ADAPTER_VERSION,
      provider: "codex",
      transport: "sdk",
      auth_mode: profile.auth_mode,
      model: profile.model,
      sandbox: threadOptions.sandboxMode,
      network_access: threadOptions.networkAccessEnabled,
      process_control: "indirect",
      cancel_scope: "turn",
      error_rules_version: CODEX_ERROR_RULES_VERSION,
      mcp_servers: Object.keys(profile.mcp_servers),
    })
    ctx.notifyRun()

    // ADR-0008 §2: con suscripción, el preflight usa el mismo binario y entorno del run.
    if (profile.auth_mode === "subscription_session") {
      const login = await (this.deps.loginStatus ?? loginStatus)(profile.codex_path)
      if (login.code !== 0)
        return this.end(ctx, profile, {
          signals: { providerError: "authentication_failed", authMode: profile.auth_mode },
          message:
            "Codex no tiene sesión: ejecuta `codex login` en tu terminal (o `codex login --device-auth` sin navegador)",
        })
    }

    const codex = (this.deps.createCodex ?? defaultCreateCodex)({
      ...(profile.codex_path ? { codexPathOverride: profile.codex_path } : {}),
      ...mcpConfig(profile.mcp_servers),
    })
    const abort = new AbortController()
    this.running.set(run.id, abort)
    const deadline = setTimeout(() => {
      this.abortCause.set(run.id, "timeout")
      abort.abort("timeout")
    }, profile.max_wall_ms)

    const rootAgentId = `${run.id}:root`
    const signals: RunSignals = { authMode: profile.auth_mode }
    let threadId: string | null = null
    let seq = 0
    let thrown: string | null = null
    try {
      const thread = codex.startThread(threadOptions)
      const turn: TurnOptions = { signal: abort.signal }
      const { events } = await thread.runStreamed(prompt, turn)
      for await (const raw of events) {
        const key = `codex:${threadId ?? run.id}:${++seq}`
        const { payload: e } = ctx.ingest<ThreadEvent>(`codex.${raw.type}`, key, raw, null)
        const touched = this.project(ctx, e, rootAgentId, profile, signals, (id) => {
          threadId = id
        })
        if (touched.length)
          ctx.record(
            "projection.updated",
            `proj:${key}`,
            { agent: rootAgentId, tool_calls: touched },
            null,
          )
      }
    } catch (e) {
      thrown = e instanceof Error ? e.message : String(e)
    } finally {
      clearTimeout(deadline)
      this.running.delete(run.id)
    }
    const cause = abort.signal.aborted ? (this.abortCause.get(run.id) ?? "cancelled") : null
    this.abortCause.delete(run.id)
    if (thrown && !cause && !signals.result && !signals.providerError) {
      const code = codexErrorCode(thrown)
      if (code !== "codex_unrecognized_error") signals.providerError = code
    }
    return this.end(ctx, profile, {
      signals: { ...signals, aborted: cause, thrown },
      message: thrown,
    })
  }

  /** Proyecta un evento: nodo raíz, tool calls y señales del final. Devuelve las tool calls tocadas. */
  private project(
    ctx: RunContext,
    e: ThreadEvent,
    rootAgentId: string,
    profile: CodexProfile,
    signals: RunSignals,
    onThread: (id: string) => void,
  ): string[] {
    const { run, store } = ctx
    const t = nowIso()
    switch (e.type) {
      case "thread.started":
        onThread(e.thread_id)
        store.upsertAgent({
          id: rootAgentId,
          run_id: run.id,
          provider: "codex",
          session_id: e.thread_id,
          external_agent_id: null,
          parent_agent_id: null,
          parent_source: null,
          classification: "root",
          state: "running",
          agent_type: null,
          model: profile.model,
          first_seen: t,
          last_seen: t,
        })
        store.updateRun(run.id, { status: "running" })
        store.mergeManifest(run.id, { session_id: e.thread_id })
        ctx.notifyRun()
        return []
      case "turn.completed":
        signals.result = { subtype: "success", is_error: false }
        store.updateRun(run.id, {
          input_tokens: e.usage.input_tokens,
          output_tokens: e.usage.output_tokens,
        })
        store.mergeManifest(run.id, { usage: e.usage })
        return []
      case "turn.failed":
        signals.result = { subtype: "error", is_error: true, errors: [e.error.message] }
        signals.providerError = codexErrorCode(e.error.message)
        return []
      case "error":
        signals.providerError ??= codexErrorCode(e.message)
        return []
      case "item.started":
      case "item.updated":
      case "item.completed":
        return this.projectItem(ctx, e.item, e.type, rootAgentId, profile.cwd, t)
      default:
        return []
    }
  }

  private projectItem(
    ctx: RunContext,
    item: ThreadItem,
    phase: "item.started" | "item.updated" | "item.completed",
    rootAgentId: string,
    cwd: string,
    t: string,
  ): string[] {
    const call = toolCallOf(item)
    if (!call) return []
    const { run, store } = ctx
    const open = store.openToolCalls(run.id).some((c) => c.tool_use_id === item.id)
    const touched: string[] = []
    if (!open && phase !== "item.updated") {
      const row = store.openToolCall({
        run_id: run.id,
        agent_id: rootAgentId,
        tool_use_id: item.id,
        tool_name: call.name,
        label: toolCallLabel(call.name, call.input, cwd) ?? call.name,
        started_at: t,
        input_json: JSON.stringify(call.input),
      })
      touched.push(row.id)
    }
    if (phase === "item.completed") {
      const row = store.closeToolCall({
        run_id: run.id,
        tool_use_id: item.id,
        state: call.failed ? "failed" : "succeeded",
        ended_at: t,
        duration_ms: null,
        output_json: JSON.stringify(call.output),
        error_message: call.failed ? call.error : null,
      })
      if (row) touched.push(row.id)
    }
    return touched
  }

  /** Un único punto decide cómo terminó (run-outcome de @keel/core), como en Claude. */
  private end(
    ctx: RunContext,
    profile: CodexProfile,
    p: { signals: RunSignals; message: string | null },
  ): RunRow {
    const { run, store } = ctx
    const t = nowIso()
    const outcome = classifyRunOutcome({ ...p.signals, authMode: profile.auth_mode })
    store.updateRun(run.id, { status: outcome.status, end_reason: outcome.end_reason, ended_at: t })
    const rootAgentId = `${run.id}:root`
    const stopped =
      outcome.status === "cancelled" || outcome.status === "interrupted" ? outcome.status : null
    if (store.agentsOfRun(run.id).some((a) => a.id === rootAgentId))
      store.setAgentState(
        rootAgentId,
        stopped ?? (outcome.status === "completed" ? "succeeded" : "failed"),
        t,
        outcome.status === "completed" ? null : (outcome.provider_error ?? p.message),
      )
    const closed: string[] = []
    for (const tc of store.openToolCalls(run.id)) {
      const row = store.closeToolCall({
        run_id: run.id,
        tool_use_id: tc.tool_use_id,
        state: stopped ?? "orphan",
        ended_at: t,
        duration_ms: null,
        output_json: null,
        error_message: null,
      })
      if (row) closed.push(row.id)
    }
    store.mergeManifest(run.id, { outcome })
    if (outcome.status !== "completed" && outcome.status !== "cancelled")
      ctx.record(
        "run.failure",
        `failure:${run.id}`,
        { ...outcome, message: p.message, provider_errors: p.signals.result?.errors ?? [] },
        null,
      )
    if (outcome.status === "cancelled")
      ctx.record("run.cancelled", `end:${run.id}`, { message: p.message, tool_calls: closed }, null)
    if (closed.length)
      ctx.record(
        "projection.updated",
        `proj:end:${run.id}`,
        { agent: rootAgentId, tool_calls: closed },
        null,
      )
    ctx.notifyRun()
    return store.getRun(run.id) as RunRow
  }
}

type ToolCallView = {
  name: string
  input: Record<string, unknown>
  output: unknown
  failed: boolean
  error: string | null
}

/** `command_execution`, `file_change` y `mcp_tool_call` se proyectan como tool calls con su `id` (ADR-0008 §8). */
function toolCallOf(item: ThreadItem): ToolCallView | null {
  switch (item.type) {
    case "command_execution":
      return {
        name: "Bash",
        input: { command: item.command },
        output: { exit_code: item.exit_code ?? null, output: item.aggregated_output },
        failed: item.status === "failed" || (item.exit_code ?? 0) !== 0,
        error: item.status === "failed" ? `salió con ${item.exit_code ?? "?"}` : null,
      }
    case "file_change":
      return {
        name: "Edit",
        input: { file_path: item.changes[0]?.path ?? "", changes: item.changes },
        output: { status: item.status },
        failed: item.status === "failed",
        error: item.status === "failed" ? "no se aplicó el parche" : null,
      }
    case "mcp_tool_call":
      return {
        name: `mcp__${item.server}__${item.tool}`,
        input: (item.arguments ?? {}) as Record<string, unknown>,
        output: item.result ?? null,
        failed: item.status === "failed",
        error: item.error?.message ?? null,
      }
    default:
      return null
  }
}

/** Los servidores MCP del run, como configuración de Codex (`mcp_servers.<nombre>`). */
function mcpConfig(servers: CodexProfile["mcp_servers"]): Pick<CodexOptions, "config"> | object {
  const names = Object.keys(servers)
  if (names.length === 0) return {}
  return {
    config: {
      mcp_servers: Object.fromEntries(
        names.map((n) => {
          const s = servers[n] as CodexProfile["mcp_servers"][string]
          return [n, { command: s.command, args: s.args, env: s.env }]
        }),
      ),
    },
  }
}

function defaultCreateCodex(opts: CodexOptions): CodexLike {
  return new Codex(opts)
}

function loginStatus(codexPath: string | null): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(codexPath ?? "codex", ["login", "status"], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    })
    let output = ""
    child.stdout.on("data", (d: Buffer) => {
      output += d.toString()
    })
    child.stderr.on("data", (d: Buffer) => {
      output += d.toString()
    })
    child.on("error", (e) => resolve({ code: 127, output: e.message }))
    child.on("close", (code) => resolve({ code: code ?? 1, output: output.trim() }))
  })
}
