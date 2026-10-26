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
import {
  classifyRunOutcome,
  type Effort,
  type ModelOption,
  type PermissionMode,
  type RunSignals,
  toolCallLabel,
} from "@keel/core"
import {
  Codex,
  type CodexOptions,
  type ThreadEvent,
  type ThreadItem,
  type ThreadOptions,
  type TurnOptions,
} from "@openai/codex-sdk"
import { nowIso, ulid } from "../ids.js"
import type { ProcessTable } from "../processes.js"
import type { RunRow } from "../store/repo.js"
import {
  AppServerClient,
  type AppServerLaunch,
  errorCodeFromInfo,
  tomlValue,
} from "./codex-app-server.js"
import type {
  LiveChange,
  Preflight,
  ProviderAdapter,
  ProviderCapabilities,
  RunContext,
} from "./provider.js"

export const CODEX_ADAPTER_VERSION = "codex-sdk/0.162.0"
export const CODEX_SOURCE = "codex-sdk"

export type CodexProfile = {
  /**
   * `app_server` (por defecto): Keel lanza `codex app-server` por run, posee el
   * proceso y atiende aprobaciones. `sdk`: `@openai/codex-sdk`, sin pid ni
   * aprobaciones. El spike del 2026-10-22 decidió que `app_server` entra.
   */
  transport: "app_server" | "sdk"
  /** Política de aprobación de runs `execute` con `app_server`; los demás usan `never`. */
  approval_policy: "on-request" | "untrusted" | "never"
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
  /**
   * Modo de permisos del run (ADR-0019 §4). En Codex: `plan` usa `read-only`;
   * `bypass` quita las aprobaciones pero conserva el sandbox `workspace-write`;
   * `ask` y `accept_edits` piden aprobación (Codex ya aplica las ediciones del
   * sandbox sin preguntar).
   */
  permission_mode: PermissionMode
  /** Variables extra del proceso del agente (atribución en git, ADR-0018 §1). */
  env: Record<string, string>
  /** Hilo de Codex que retoma este run (continuar una conversación, ADR-0019 §3). */
  resume_thread_id: string | null
}

export const DEFAULT_CODEX_PROFILE: CodexProfile = {
  transport: "app_server",
  approval_policy: "on-request",
  permission_mode: "ask",
  env: {},
  resume_thread_id: null,
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
export type CodexLike = Pick<Codex, "startThread"> & Partial<Pick<Codex, "resumeThread">>
export type CodexAdapterDeps = {
  /** Tabla de procesos para registrar la identidad del app-server (processes.ts). */
  processes?: ProcessTable
  /** Cómo se lanza el app-server; los tests ponen un servidor falso. */
  appServerLaunch?: (args: string[], profile: CodexProfile) => AppServerLaunch
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
  readonly capabilities: ProviderCapabilities
  private readonly running = new Map<string, AbortController>()
  /** Entrega de mensajes humanos a los runs vivos con `app_server` (ADR-0019 §3). */
  private readonly live = new Map<string, (text: string) => boolean>()
  private readonly abortCause = new Map<string, "cancelled" | "timeout">()
  /**
   * ADR-0020 §4: lo que el humano cambió con el run vivo; entra en el
   * `turn/start` siguiente. Sólo con `app_server`.
   */
  private readonly turnOverrides = new Map<
    string,
    {
      execute: boolean
      network: boolean
      base: CodexProfile["approval_policy"]
      next: Record<string, unknown>
    }
  >()
  private readonly deps: CodexAdapterDeps
  constructor(deps: CodexAdapterDeps = {}, transport: CodexProfile["transport"] = "app_server") {
    this.deps = deps
    this.capabilities = codexCapabilities(transport)
  }

  get activeRuns(): number {
    return this.running.size
  }

  sendMessage(runId: string, text: string): boolean {
    return this.live.get(runId)?.(text) ?? false
  }

  async setMode(runId: string, mode: PermissionMode): Promise<LiveChange> {
    const o = this.turnOverrides.get(runId)
    if (!o) return { error: "Codex sólo cambia de modo en vivo con el app-server" }
    o.next.approvalPolicy = o.execute && mode !== "bypass" ? o.base : "never"
    // ADR-0021 §3: `plan` en un run que ejecuta es la revisión: el sandbox del turno
    // vuelve a sólo lectura; los demás modos devuelven la escritura en el worktree.
    if (o.execute)
      o.next.sandboxPolicy =
        mode === "plan"
          ? { type: "readOnly" }
          : {
              type: "workspaceWrite",
              writableRoots: [],
              networkAccess: o.network,
              excludeTmpdirEnvVar: false,
              excludeSlashTmp: false,
            }
    return { applies: "next_turn" }
  }

  async setModel(runId: string, model: string, effort: Effort | null): Promise<LiveChange> {
    const o = this.turnOverrides.get(runId)
    if (!o) return { error: "Codex sólo cambia de modelo en vivo con el app-server" }
    o.next.model = model
    if (effort) o.next.effort = effort === "low" || effort === "medium" ? effort : "high"
    return { applies: "next_turn" }
  }

  /** Sin pregunta al proveedor todavía: el daemon muestra el modelo del perfil. */
  async listModels(): Promise<ModelOption[] | null> {
    return null
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
          "el modo suscripción de Codex necesita habilitarse explícitamente: en la GUI (Ajustes) o con --codex-subscription (ADR-0008 §2)",
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
    const pre = this.preflight(profile)
    if (!pre.ok) return ctx.fail(pre.message, "run.start_failed")
    return profile.transport === "app_server"
      ? this.executeAppServer(ctx, prompt, profile)
      : this.executeSdk(ctx, prompt, profile)
  }

  private async executeSdk(
    ctx: RunContext,
    prompt: string,
    profile: CodexProfile,
  ): Promise<RunRow> {
    const { run, store } = ctx

    const execute = run.purpose === "execute" && profile.permission_mode !== "plan"
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
      cwd: profile.cwd,
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
      // Con `env` el SDK no hereda process.env: se pasa entero más lo del run.
      ...(Object.keys(profile.env).length
        ? { env: { ...(process.env as Record<string, string>), ...profile.env } }
        : {}),
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
      const thread =
        profile.resume_thread_id && codex.resumeThread
          ? codex.resumeThread(profile.resume_thread_id, threadOptions)
          : codex.startThread(threadOptions)
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

  /**
   * Transporte `app_server`: un `codex app-server` por run, lanzado y vigilado
   * por Keel. Las aprobaciones de comandos pasan por el gate de Keel y sólo se
   * responden `accept` o `decline` (ADR-0008 §3).
   */
  private async executeAppServer(
    ctx: RunContext,
    prompt: string,
    profile: CodexProfile,
  ): Promise<RunRow> {
    const { run, store } = ctx
    const execute = run.purpose === "execute" && profile.permission_mode !== "plan"
    const sandbox = execute ? "workspace-write" : "read-only"
    const approvalPolicy =
      execute && profile.permission_mode !== "bypass" ? profile.approval_policy : "never"
    store.updateRun(run.id, { status: "initializing", started_at: nowIso(), cost_kind: "unknown" })
    store.mergeManifest(run.id, {
      adapter: CODEX_ADAPTER_VERSION,
      provider: "codex",
      transport: "app_server",
      cwd: profile.cwd,
      auth_mode: profile.auth_mode,
      model: profile.model,
      sandbox,
      approval_policy: approvalPolicy,
      network_access: execute && profile.network_access,
      process_control: "owned",
      cancel_scope: "process",
      error_rules_version: CODEX_ERROR_RULES_VERSION,
      mcp_servers: Object.keys(profile.mcp_servers),
    })
    ctx.notifyRun()

    const args = ["app-server", ...configOverrides(profile, execute)]
    const base = (this.deps.appServerLaunch ?? defaultAppServerLaunch)(args, profile)
    const launch = { ...base, env: { ...base.env, ...profile.env } }
    const server = new AppServerClient(launch)
    this.recordProcess(ctx, server, launch)
    const abort = new AbortController()
    this.running.set(run.id, abort)
    const deadline = setTimeout(() => {
      this.abortCause.set(run.id, "timeout")
      abort.abort("timeout")
    }, profile.max_wall_ms)

    const rootAgentId = `${run.id}:root`
    const signals: RunSignals = { authMode: profile.auth_mode }
    let threadId: string | null = null
    let turnId: string | null = null
    let message: string | null = null
    let seq = 0
    // Un turno a la vez; el humano puede escribir durante el turno (`turn/steer`) o
    // dejar el mensaje para el siguiente (ADR-0019 §3).
    let settle: (status: string) => void = () => {}
    let turnOpen = false
    let serverGone = false
    // Se resuelve con el id del turno en cuanto `turn/start` responde.
    let turnReady: Promise<string | null> = Promise.resolve(null)
    let markReady: (id: string | null) => void = () => {}
    const queue: string[] = []
    let finished = false
    const overrides = {
      execute,
      network: execute && profile.network_access,
      base: profile.approval_policy,
      next: {},
    }
    this.turnOverrides.set(run.id, overrides)
    this.live.set(run.id, (text) => {
      // Tras el último turno ya nadie leería la cola: el run no acepta más mensajes.
      if (finished) return false
      if (!turnOpen) {
        queue.push(text)
        return true
      }
      void turnReady.then((id) => {
        if (!id || !threadId || !turnOpen) return queue.push(text)
        return server
          .request("turn/steer", { threadId, expectedTurnId: id, input: [{ type: "text", text }] })
          .catch(() => queue.push(text))
      })
      return true
    })

    server.onNotification((method, params) => {
      // Los deltas de streaming no se guardan: el item completo trae el texto entero.
      if (method.endsWith("/delta") || method.endsWith("/outputDelta")) return
      const key = `codex-app:${run.id}:${++seq}`
      const { payload: p } = ctx.ingest(`codex.app.${method}`, key, params, null)
      const touched = this.projectAppServer(ctx, method, p, rootAgentId, profile, signals)
      if (touched.length)
        ctx.record(
          "projection.updated",
          `proj:${key}`,
          { agent: rootAgentId, tool_calls: touched },
          null,
        )
      if (method === "thread/started") threadId = (p.thread as { id: string }).id
      if (method === "turn/completed") {
        const turn = p.turn as { id: string; status: string }
        if (!turnId || turn.id === turnId) settle(turn.status)
      }
    })
    server.onServerRequest(async (method, params) => {
      ctx.ingest(`codex.app.request.${method}`, `codex-app:${run.id}:${++seq}`, params, null)
      if (method === "item/commandExecution/requestApproval") {
        const d = await ctx.decideTool({
          tool: "Bash",
          input: { command: params.command, cwd: params.cwd, reason: params.reason ?? null },
          signal: abort.signal,
        })
        return { decision: d.behavior === "allow" ? "accept" : "decline" }
      }
      if (method === "item/fileChange/requestApproval") {
        const d = await ctx.decideTool({
          tool: "Edit",
          input: {
            item_id: params.itemId,
            reason: params.reason ?? null,
            grant_root: params.grantRoot ?? null,
          },
          signal: abort.signal,
        })
        return { decision: d.behavior === "allow" ? "accept" : "decline" }
      }
      // Refresco de tokens, permisos y lo desconocido: no se atiende (ADR-0002).
      return undefined
    })
    void server.exited.then(() => {
      serverGone = true
      settle("server_exited")
    })

    let thrown: string | null = null
    try {
      await server.request("initialize", {
        clientInfo: { name: "keel", title: "Keel", version: CODEX_ADAPTER_VERSION },
        capabilities: { experimentalApi: false },
      })
      server.notify("initialized")
      // Preflight de sesión en el mismo proceso y entorno (spike, prueba 2).
      if (profile.auth_mode === "subscription_session") {
        const account = await server.request<{ account: unknown; requiresOpenaiAuth?: boolean }>(
          "account/read",
          {},
        )
        if (!account.account) {
          signals.providerError = "authentication_failed"
          message =
            "Codex no tiene sesión: ejecuta `codex login` en tu terminal (o `codex login --device-auth` sin navegador)"
        }
      }
      if (!signals.providerError && !abort.signal.aborted) {
        // Hilos persistidos por Codex (no efímeros) para poder continuarlos después.
        const opened = profile.resume_thread_id
          ? await server.request<{ thread: { id: string } }>("thread/resume", {
              threadId: profile.resume_thread_id,
              cwd: profile.cwd,
              sandbox,
              approvalPolicy,
              ...(profile.model ? { model: profile.model } : {}),
            })
          : await server.request<{ thread: { id: string } }>("thread/start", {
              cwd: profile.cwd,
              sandbox,
              approvalPolicy,
              ephemeral: false,
              ...(profile.model ? { model: profile.model } : {}),
            })
        threadId = opened.thread.id
        const aborted = new Promise<string>((resolve) =>
          abort.signal.addEventListener("abort", () => resolve("aborted"), { once: true }),
        )
        let next: string | undefined = prompt
        while (next !== undefined && !abort.signal.aborted && !serverGone) {
          const turnDone = new Promise<string>((resolve) => {
            settle = resolve
          })
          turnId = null
          turnReady = new Promise((resolve) => {
            markReady = resolve
          })
          turnOpen = true
          const turn = await server
            .request<{ turn: { id: string } }>("turn/start", {
              threadId,
              input: [{ type: "text", text: next }],
              ...(profile.reasoning_effort ? { effort: profile.reasoning_effort } : {}),
              ...overrides.next,
            })
            .catch((e: unknown) => {
              markReady(null)
              throw e
            })
          turnId = turn.turn.id
          markReady(turnId)
          const status = await Promise.race([turnDone, aborted])
          turnOpen = false
          markReady(null)
          if (status === "aborted") {
            // Interrumpir cierra el turno, pero el comando sigue vivo: luego se cierra el proceso.
            await server.request("turn/interrupt", { threadId, turnId }).catch(() => undefined)
            await Promise.race([turnDone, Bun.sleep(5_000)])
            break
          }
          // Un turno fallido termina el run; si no, lo que escribió el humano abre otro.
          if (status !== "completed") break
          next = queue.shift()
        }
        finished = true
      }
    } catch (e) {
      thrown = e instanceof Error ? e.message : String(e)
    } finally {
      finished = true
      clearTimeout(deadline)
      this.running.delete(run.id)
      this.live.delete(run.id)
      this.turnOverrides.delete(run.id)
    }
    const exit = await server.close()
    if (exit.code !== 0 && exit.code !== null && server.stderr)
      ctx.record(
        "provider.stderr",
        `stderr:${run.id}:${ulid()}`,
        { ...exit, tail: server.stderr },
        null,
      )
    const cause = abort.signal.aborted ? (this.abortCause.get(run.id) ?? "cancelled") : null
    this.abortCause.delete(run.id)
    // Si el app-server murió sin cerrar el turno, el run no llegó a un final propio.
    const sawEnd = signals.result !== undefined || signals.providerError !== undefined
    return this.end(ctx, profile, {
      signals: {
        ...signals,
        aborted: cause,
        thrown,
        exit: sawEnd || cause ? null : exit,
      },
      message: message ?? thrown,
    })
  }

  /** Proyección de las notificaciones del app-server (esquema v2 de 0.162.1). */
  private projectAppServer(
    ctx: RunContext,
    method: string,
    p: Record<string, unknown>,
    rootAgentId: string,
    profile: CodexProfile,
    signals: RunSignals,
  ): string[] {
    const { run, store } = ctx
    const t = nowIso()
    switch (method) {
      case "thread/started": {
        const thread = p.thread as { id: string; model?: string | null }
        store.upsertAgent({
          id: rootAgentId,
          run_id: run.id,
          provider: "codex",
          session_id: thread.id,
          external_agent_id: null,
          parent_agent_id: null,
          parent_source: null,
          classification: "root",
          state: "running",
          agent_type: null,
          model: thread.model ?? profile.model,
          first_seen: t,
          last_seen: t,
        })
        store.updateRun(run.id, { status: "running" })
        store.mergeManifest(run.id, { session_id: thread.id })
        ctx.notifyRun()
        return []
      }
      case "thread/tokenUsage/updated": {
        const total = (p.tokenUsage as { total?: { inputTokens: number; outputTokens: number } })
          ?.total
        if (total)
          store.updateRun(run.id, {
            input_tokens: total.inputTokens,
            output_tokens: total.outputTokens,
          })
        return []
      }
      case "account/rateLimits/updated":
        // Cuota de la suscripción por ventana: nunca «tokens restantes» (ADR-0008 §7).
        store.mergeManifest(run.id, { quota: p.rateLimits })
        return []
      case "error": {
        if (p.willRetry) return []
        const err = p.error as { message?: string; codexErrorInfo?: unknown } | undefined
        signals.providerError ??=
          errorCodeFromInfo(err?.codexErrorInfo) ?? codexErrorCode(err?.message ?? "")
        return []
      }
      case "turn/completed": {
        const turn = p.turn as {
          status: string
          error?: { message?: string; codexErrorInfo?: unknown } | null
        }
        if (turn.status === "completed") signals.result = { subtype: "success", is_error: false }
        else if (turn.status === "failed") {
          signals.result = { subtype: "error", is_error: true, errors: [turn.error?.message ?? ""] }
          signals.providerError =
            errorCodeFromInfo(turn.error?.codexErrorInfo) ??
            codexErrorCode(turn.error?.message ?? "")
        } else if (turn.status === "interrupted") {
          // Un turno interrumpido sin que Keel lo pidiera no es éxito ni fallo propio.
          signals.result = { subtype: "interrupted", is_error: true }
          signals.providerError ??= "server_error"
        }
        return []
      }
      case "item/started":
      case "item/completed": {
        const item = p.item as Record<string, unknown> & { id: string }
        return this.projectItem(
          ctx,
          item.id,
          toolCallOfV2(item),
          method === "item/started" ? "item.started" : "item.completed",
          rootAgentId,
          profile.cwd,
          t,
        )
      }
      default:
        return []
    }
  }

  /** Pid al instante e identidad (arranque y ejecutable) cuando la tabla de procesos la da. */
  private recordProcess(ctx: RunContext, server: AppServerClient, launch: AppServerLaunch): void {
    const pid = server.pid
    if (pid === undefined) return
    const recorded = { pid, started_at: null, exe: null, cwd: null, command: launch.command }
    ctx.store.mergeManifest(ctx.run.id, { provider_process: recorded })
    void this.deps.processes
      ?.get(pid)
      .then((info) => {
        if (info)
          ctx.store.mergeManifest(ctx.run.id, {
            provider_process: { ...recorded, started_at: info.startedAt, exe: info.exe },
          })
      })
      .catch(() => undefined)
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
        return this.projectItem(
          ctx,
          e.item.id,
          toolCallOf(e.item),
          e.type,
          rootAgentId,
          profile.cwd,
          t,
        )
      default:
        return []
    }
  }

  private projectItem(
    ctx: RunContext,
    itemId: string,
    call: ToolCallView | null,
    phase: "item.started" | "item.updated" | "item.completed",
    rootAgentId: string,
    cwd: string,
    t: string,
  ): string[] {
    if (!call) return []
    const { run, store } = ctx
    const open = store.openToolCalls(run.id).some((c) => c.tool_use_id === itemId)
    const touched: string[] = []
    if (!open && phase !== "item.updated") {
      const row = store.openToolCall({
        run_id: run.id,
        agent_id: rootAgentId,
        tool_use_id: itemId,
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
        tool_use_id: itemId,
        state: call.failed ? "failed" : "succeeded",
        ended_at: t,
        duration_ms: call.durationMs ?? null,
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
  /** Duración que reporta el proveedor, si la da (`duration_ms` del runtime). */
  durationMs?: number | null
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

/** Capacidades por transporte, medidas en el spike (ADR-0008 §9). */
export function codexCapabilities(transport: CodexProfile["transport"]): ProviderCapabilities {
  return transport === "app_server"
    ? {
        auth_modes: ["subscription_session", "api_key"],
        subagents: false,
        tool_approval: true,
        // Sólo lo verificado: el spike probó que Codex respeta `decline` en comandos.
        approval_kinds: ["command"],
        process_control: "owned",
        budget_unit: "tokens",
        cancel_scope: "process",
        cost_kind: "unknown",
        cancel_emits_result: true,
      }
    : {
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
}

/**
 * Overrides `-c` del app-server: red del sandbox y servidores MCP del run, con
 * sus tools aprobadas (la autoridad la comprueba el daemon). Claves validadas
 * con `codex app-server --strict-config` (0.162.1).
 */
export function configOverrides(profile: CodexProfile, execute: boolean): string[] {
  const out: string[] = []
  const set = (key: string, value: unknown) => out.push("-c", `${key}=${tomlValue(value)}`)
  set("sandbox_workspace_write.network_access", execute && profile.network_access)
  for (const [name, s] of Object.entries(profile.mcp_servers)) {
    set(`mcp_servers.${name}.command`, s.command)
    set(`mcp_servers.${name}.args`, s.args)
    set(`mcp_servers.${name}.env`, s.env)
    set(`mcp_servers.${name}.default_tools_approval_mode`, "approve")
  }
  return out
}

function defaultAppServerLaunch(args: string[], profile: CodexProfile): AppServerLaunch {
  return {
    command: profile.codex_path ?? "codex",
    args,
    env: { ...process.env } as Record<string, string>,
  }
}

/** Items del esquema v2 que se proyectan como tool calls. */
function toolCallOfV2(item: Record<string, unknown>): ToolCallView | null {
  const status = item.status as string | undefined
  const failed = status === "failed" || status === "declined"
  switch (item.type) {
    case "commandExecution":
      return {
        name: "Bash",
        input: { command: item.command, cwd: item.cwd },
        output: { exit_code: item.exitCode ?? null, output: item.aggregatedOutput ?? null },
        failed: failed || (typeof item.exitCode === "number" && item.exitCode !== 0),
        error:
          status === "declined"
            ? "denegado por Keel"
            : status === "failed"
              ? `salió con ${String(item.exitCode ?? "?")}`
              : null,
        durationMs: (item.durationMs as number | null) ?? null,
      }
    case "fileChange": {
      const changes = (item.changes as { path: string }[] | undefined) ?? []
      return {
        name: "Edit",
        input: { file_path: changes[0]?.path ?? "", files: changes.map((c) => c.path) },
        output: { status },
        failed,
        error:
          status === "declined" ? "denegado por Keel" : failed ? "no se aplicó el parche" : null,
      }
    }
    case "mcpToolCall":
      return {
        name: `mcp__${String(item.server)}__${String(item.tool)}`,
        input: (item.arguments ?? {}) as Record<string, unknown>,
        output: item.result ?? null,
        failed,
        error: (item.error as { message?: string } | null)?.message ?? null,
        durationMs: (item.durationMs as number | null) ?? null,
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
          // Sin esto, con approvalPolicy never Codex bloquea toda tool MCP (corrida real del
          // 2026-10-22). La autoridad la comprueba el daemon en cada operación (ADR-0009 §5).
          return [
            n,
            {
              command: s.command,
              args: s.args,
              env: s.env,
              default_tools_approval_mode: "approve",
            },
          ]
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
