/**
 * Adaptador del Claude Agent SDK (ADR-0001 §2 invariante del adaptador,
 * ADR-0002 modos de autenticación, ADR-0003 §9 procesos hijos).
 *
 * - Modo `subscription_session`: usa el binario de Claude Code instalado por el
 *   usuario y quita cualquier API key del entorno del hijo (sin fallback
 *   silencioso). Keel no lee ni escribe credenciales.
 * - Modo `api_key`: exige `ANTHROPIC_API_KEY` en el entorno; si no está, falla.
 * - Implementa `ProviderAdapter` (ADR-0007 §7): cada mensaje y cada hook va
 *   íntegro a `RunContext.record` y se proyecta por `RunContext.store`.
 * - `canUseTool` delega en la política del daemon (`RunContext.decideTool`).
 * - Registra pid + cwd + session_id del proceso `claude` en el manifest del run
 *   para reconciliar al arrancar.
 */
import { existsSync, readdirSync, readFileSync, readlinkSync } from "node:fs"
import { join } from "node:path"
import type {
  HookCallback,
  HookCallbackMatcher,
  HookInput,
  Options,
  PermissionResult,
  Query,
  SDKMessage,
} from "@anthropic-ai/claude-agent-sdk"
import { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk"
import { isLive } from "@keel/core"
import { nowIso, ulid } from "../ids.js"
import { RunProjector } from "../projector.js"
import type { RunRow } from "../store/repo.js"
import type { Preflight, ProviderAdapter, ProviderCapabilities, RunContext } from "./provider.js"

export const ADAPTER_VERSION = "claude-sdk/0.3.295"
export const SOURCE = "claude-sdk"

export type AuthMode = "subscription_session" | "api_key" | "bedrock" | "vertex"

export type ClaudeProfile = {
  auth_mode: AuthMode
  model: string
  allowed_tools: string[]
  max_turns: number
  /** ms que el daemon espera una decisión humana antes de denegar (SDD 02 §9). */
  approval_timeout_ms: number
  cwd: string
}

export const DEFAULT_PROFILE: ClaudeProfile = {
  auth_mode: "subscription_session",
  model: "haiku",
  allowed_tools: ["Read", "Glob", "Grep"],
  max_turns: 12,
  approval_timeout_ms: 60_000,
  cwd: process.cwd(),
}

const HOOK_EVENTS = [
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "PostToolBatch",
  "UserPromptSubmit",
  "Stop",
  "StopFailure",
  "SubagentStart",
  "SubagentStop",
  "PreCompact",
  "PostCompact",
  "PermissionRequest",
  "PermissionDenied",
  "SessionStart",
  "SessionEnd",
  "Notification",
] as const

export type QueryFn = (args: {
  prompt: string
  options: Options
}) => Query | AsyncIterable<SDKMessage>

export type ClaudeAdapterDeps = {
  queryFn?: QueryFn
  /** Para tests: ruta al binario; por defecto se detecta el instalado. */
  binary?: string | null
  /** Entorno del que hereda el hijo; por defecto el del daemon. */
  env?: Record<string, string | undefined>
}

export function detectClaudeBinary(): string | null {
  const candidates = [
    process.env.KEEL_CLAUDE_PATH,
    join(process.env.HOME ?? "", ".local/bin/claude"),
    "/usr/local/bin/claude",
    "/usr/bin/claude",
  ]
  return (
    candidates.find((p): p is string => typeof p === "string" && p.length > 0 && existsSync(p)) ??
    null
  )
}

export class ClaudeAdapter implements ProviderAdapter<ClaudeProfile> {
  readonly provider = "claude"
  readonly adapterVersion = ADAPTER_VERSION
  /** Medido en el spike (spikes/sdk-capabilities/FINDINGS.md, ADR-0003). */
  readonly capabilities: ProviderCapabilities = {
    auth_modes: ["subscription_session", "api_key", "bedrock", "vertex"],
    subagents: true,
    tool_approval: true,
    // El SDK estima a precio de lista incluso con suscripción: nunca `observed`.
    cost_kind: "estimated",
    // Tras abortar no llega `result` (FINDINGS §1): el daemon sintetiza `cancelled`.
    cancel_emits_result: false,
  }
  private readonly running = new Map<string, AbortController>()
  private readonly deps: ClaudeAdapterDeps
  constructor(deps: ClaudeAdapterDeps = {}) {
    this.deps = deps
  }

  get activeRuns(): number {
    return this.running.size
  }

  cancel(runId: string, reason: string | null): boolean {
    const abort = this.running.get(runId)
    if (!abort) return false
    abort.abort(reason ?? "cancelled")
    return true
  }

  preflight(profile: ClaudeProfile): Preflight {
    const r = this.resolveLaunch(profile)
    return r.ok ? { ok: true } : r
  }

  /**
   * Ejecuta el run hasta el final. Resuelve cuando el run está en estado
   * terminal; un error de configuración o de autenticación lo termina en
   * `failed` antes del spawn, nunca deja la promesa rechazada (K-08).
   */
  async execute(ctx: RunContext, prompt: string, profile: ClaudeProfile): Promise<RunRow> {
    const { run, store } = ctx
    const launch = this.resolveLaunch(profile)
    if (!launch.ok) return ctx.fail(launch.message, "run.start_failed")
    const { env, binary } = launch
    const projector = new RunProjector({
      store,
      run,
      provider: "claude",
      rootAgentId: `${run.id}:root`,
    })
    const abort = new AbortController()
    this.running.set(run.id, abort)

    const notifyProjection = (key: string, changed: { agent?: string; toolCalls?: string[] }) => {
      if (changed.agent || changed.toolCalls?.length)
        ctx.record(
          "projection.updated",
          `proj:${key}`,
          { agent: changed.agent ?? null, tool_calls: changed.toolCalls ?? [] },
          null,
        )
    }

    const hook: HookCallback = async (input: HookInput, toolUseID) => {
      const name = input.hook_event_name
      const key = `hook:${input.session_id}:${name}:${toolUseID ?? ""}:${ulid()}`
      const eventId = ctx.record(
        `hook.${name}`,
        key,
        { ...input, tool_use_id_callback: toolUseID ?? null },
        null,
      )
      notifyProjection(
        key,
        projector.onHook(name, input as unknown as Record<string, unknown>, toolUseID, eventId),
      )
      return {}
    }
    const hooks = Object.fromEntries(
      HOOK_EVENTS.map((e) => [e, [{ hooks: [hook] }] satisfies HookCallbackMatcher[]]),
    )

    const canUseTool = async (
      toolName: string,
      input: Record<string, unknown>,
      opts: { signal: AbortSignal },
    ): Promise<PermissionResult> => {
      const d = await ctx.decideTool({ tool: toolName, input, signal: opts.signal })
      return d.behavior === "allow"
        ? { behavior: "allow", updatedInput: d.input }
        : { behavior: "deny", message: d.message }
    }

    const options: Options = {
      ...(binary ? { pathToClaudeCodeExecutable: binary } : {}),
      model: profile.model,
      cwd: profile.cwd,
      settingSources: [],
      maxTurns: profile.max_turns,
      allowedTools: profile.allowed_tools,
      permissionMode: "default",
      env,
      abortController: abort,
      hooks,
      canUseTool,
    }
    store.updateRun(run.id, { status: "initializing", started_at: nowIso() })
    store.mergeManifest(run.id, {
      adapter: ADAPTER_VERSION,
      auth_mode: profile.auth_mode,
      binary,
      model: profile.model,
    })
    ctx.notifyRun()

    const queryFn = this.deps.queryFn ?? ((a) => sdkQuery(a))
    let processRecorded = false
    try {
      for await (const message of queryFn({ prompt, options })) {
        const m = message as unknown as Record<string, unknown> & { type: string; uuid?: string }
        const key = m.uuid ? `msg:${m.uuid}` : `msg:${m.type}:${ulid()}`
        ctx.record(`sdk.${m.type}`, key, m, typeof m.timestamp === "string" ? m.timestamp : null)
        const changed = projector.onMessage(m)
        if (!processRecorded && m.type === "system" && binary) {
          processRecorded = true
          const proc = findChildProcess(binary, profile.cwd)
          store.mergeManifest(run.id, {
            provider_process: proc ? { ...proc, session_id: projector.sessionId } : null,
          })
        }
        if (changed.run) ctx.notifyRun()
        notifyProjection(key, changed)
      }
      const final = store.getRun(run.id)
      if (final && isLive(final.status)) {
        // El stream terminó sin `result`: no inventar éxito.
        projector.onCancelled("interrupted", "el stream del SDK terminó sin mensaje result")
        ctx.notifyRun()
      }
    } catch (e) {
      const aborted = abort.signal.aborted
      const msg = e instanceof Error ? e.message : String(e)
      const changed = projector.onCancelled(aborted ? "cancelled" : "interrupted", msg)
      ctx.record(
        aborted ? "run.cancelled" : "run.interrupted",
        `end:${run.id}`,
        { message: msg, tool_calls: changed.toolCalls },
        null,
      )
      ctx.notifyRun()
    } finally {
      this.running.delete(run.id)
    }
    return store.getRun(run.id) as RunRow
  }

  /** Modo de autenticación, entorno del hijo y binario, sin lanzar nada (ADR-0002: sin fallback silencioso). */
  private resolveLaunch(
    profile: ClaudeProfile,
  ):
    | { ok: true; env: Record<string, string | undefined>; binary: string | null }
    | { ok: false; message: string } {
    const env: Record<string, string | undefined> = { ...(this.deps.env ?? process.env) }
    if (profile.auth_mode === "subscription_session") {
      // En modo sesión el hijo no ve API keys.
      delete env.ANTHROPIC_API_KEY
      delete env.ANTHROPIC_AUTH_TOKEN
    } else if (
      profile.auth_mode === "api_key" &&
      !env.ANTHROPIC_API_KEY &&
      !env.ANTHROPIC_AUTH_TOKEN
    ) {
      return {
        ok: false,
        message:
          "api_key requiere ANTHROPIC_API_KEY o ANTHROPIC_AUTH_TOKEN en el entorno del daemon",
      }
    }
    const binary = this.deps.binary === undefined ? detectClaudeBinary() : this.deps.binary
    if (profile.auth_mode === "subscription_session" && !binary)
      return {
        ok: false,
        message:
          "subscription_session requiere el binario `claude` instalado por el usuario; no se encontró",
      }
    return { ok: true, env, binary }
  }
}

/** Busca el proceso `claude` hijo directo de este daemon con ese cwd (sólo nuestro subárbol; nunca por nombre global). */
export function findChildProcess(
  binary: string,
  cwd: string,
): { pid: number; cwd: string; argv0: string } | null {
  if (!existsSync("/proc")) return null
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue
    try {
      const stat = readFileSync(`/proc/${entry}/stat`, "utf8")
      const ppid = Number(stat.split(") ")[1]?.split(" ")[1])
      if (ppid !== process.pid) continue
      const cmd = readFileSync(`/proc/${entry}/cmdline`, "utf8").split("\0")
      if (cmd[0] !== binary && cmd[1] !== binary) continue
      const procCwd = readlinkSync(`/proc/${entry}/cwd`)
      if (procCwd !== cwd) continue
      return { pid: Number(entry), cwd: procCwd, argv0: cmd[0] ?? "" }
    } catch {}
  }
  return null
}
