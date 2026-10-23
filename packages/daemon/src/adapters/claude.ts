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
 * - Lanza el proceso `claude` él mismo (`spawnClaudeCodeProcess`) y registra en
 *   el manifest su pid, instante de arranque, ejecutable y session_id para
 *   reconciliar al arrancar (processes.ts).
 */
import { type ChildProcess, spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import type {
  HookCallback,
  HookCallbackMatcher,
  HookInput,
  Options,
  PermissionResult,
  Query,
  SDKMessage,
  SpawnedProcess,
  SpawnOptions,
} from "@anthropic-ai/claude-agent-sdk"
import { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk"
import type { PermissionMode } from "@keel/core"
import { nowIso, ulid } from "../ids.js"
import { defaultProcessTable, type ProcessTable } from "../processes.js"
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
  /** Tiempo máximo de reloj de un run; al vencer, Keel lo aborta (`end_reason: timeout`). */
  max_wall_ms: number
  /** Tope de costo estimado del run (`maxBudgetUsd` del SDK); lo fija el daemon (limits.ts). */
  max_budget_usd: number | null
  cwd: string
  /**
   * Servidores MCP stdio del run; el daemon inyecta aquí `keel` (ADR-0009). Sus
   * tools se autorizan en el daemon por operación, así que se auto-aprueban.
   */
  mcp_servers: Record<string, { command: string; args: string[]; env: Record<string, string> }>
  /** Modo de permisos del run (ADR-0019 §4); `ask` deja todo lo no permitido al gate de Keel. */
  permission_mode: PermissionMode
  /** Variables extra del proceso del agente (atribución en git, ADR-0018 §1). */
  env: Record<string, string>
}

/** Modo de Keel → modo del SDK. `bypass` exige además `allowDangerouslySkipPermissions`. */
const SDK_PERMISSION_MODE = {
  ask: "default",
  accept_edits: "acceptEdits",
  plan: "plan",
  bypass: "bypassPermissions",
} as const

export const DEFAULT_PROFILE: ClaudeProfile = {
  auth_mode: "subscription_session",
  model: "haiku",
  allowed_tools: ["Read", "Glob", "Grep"],
  max_turns: 12,
  approval_timeout_ms: 60_000,
  // Default bajo (ADR-0002 regla 3): subirlo es una decisión explícita del perfil.
  max_wall_ms: 30 * 60_000,
  max_budget_usd: null,
  cwd: process.cwd(),
  mcp_servers: {},
  permission_mode: "ask",
  env: {},
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
  /** Identidad de procesos para el registro; por defecto la de la plataforma. */
  processes?: ProcessTable
  queryFn?: QueryFn
  /** Para tests: ruta al binario; por defecto se detecta el instalado. */
  binary?: string | null
  /** Entorno del que hereda el hijo; por defecto el del daemon. */
  env?: Record<string, string | undefined>
}

export type BinaryLookup = {
  platform?: NodeJS.Platform
  env?: Record<string, string | undefined>
  home?: string
}

/**
 * Dónde buscar el `claude` que instaló el usuario (ADR-0002 regla 3: se detecta,
 * no se bundlea), en orden: `KEEL_CLAUDE_PATH`, el instalador nativo
 * (`~/.local/bin`, medido en Linux y en Windows) y el `PATH`. En Windows sólo
 * cuenta `claude.exe`: un `claude.cmd` de npm no se puede lanzar como ejecutable.
 */
export function claudeCandidates(l: BinaryLookup = {}): string[] {
  const platform = l.platform ?? process.platform
  const env = l.env ?? process.env
  const home = l.home ?? homedir()
  const exe = platform === "win32" ? "claude.exe" : "claude"
  const pathVar = env.PATH ?? env.Path ?? ""
  const list = [
    env.KEEL_CLAUDE_PATH,
    join(home, ".local", "bin", exe),
    ...(platform === "win32" ? [] : ["/usr/local/bin/claude", "/usr/bin/claude"]),
    ...pathVar
      .split(platform === "win32" ? ";" : ":")
      .filter((d) => d.length > 0)
      .map((d) => join(d, exe)),
  ]
  return [...new Set(list.filter((p): p is string => typeof p === "string" && p.length > 0))]
}

export function detectClaudeBinary(l: BinaryLookup = {}): string | null {
  return claudeCandidates(l).find((p) => existsSync(p)) ?? null
}

export class ClaudeAdapter implements ProviderAdapter<ClaudeProfile> {
  readonly provider = "claude"
  readonly adapterVersion = ADAPTER_VERSION
  /** Medido en el spike (spikes/sdk-capabilities/FINDINGS.md, ADR-0003). */
  readonly capabilities: ProviderCapabilities = {
    auth_modes: ["subscription_session", "api_key", "bedrock", "vertex"],
    subagents: true,
    tool_approval: true,
    approval_kinds: ["any_tool"],
    process_control: "owned",
    budget_unit: "usd",
    cancel_scope: "process",
    // El SDK estima a precio de lista incluso con suscripción: nunca `observed`.
    cost_kind: "estimated",
    // Tras abortar no llega `result` (FINDINGS §1): el daemon sintetiza `cancelled`.
    cancel_emits_result: false,
  }
  private readonly running = new Map<string, AbortController>()
  /** Por qué abortó Keel un run: lo canceló el humano o venció su tiempo máximo. */
  private readonly abortCause = new Map<string, "cancelled" | "timeout">()
  private readonly deps: ClaudeAdapterDeps
  private readonly processes: ProcessTable
  constructor(deps: ClaudeAdapterDeps = {}) {
    this.deps = deps
    this.processes = deps.processes ?? defaultProcessTable()
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
      cwd: profile.cwd,
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
      // Se proyecta la copia saneada: tool_calls.input_json tampoco guarda secretos.
      const { id: eventId, payload } = ctx.ingest(
        `hook.${name}`,
        key,
        {
          ...(input as unknown as Record<string, unknown>),
          tool_use_id_callback: toolUseID ?? null,
        },
        null,
      )
      notifyProjection(key, projector.onHook(name, payload, toolUseID, eventId))
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

    // Keel lanza el proceso para conocer su pid en el instante del spawn y registrar
    // su identidad (pid + arranque + ejecutable) para reconciliar (ADR-0003 §9).
    const launched = this.processRecorder(ctx)
    const spawnClaudeCodeProcess = (o: SpawnOptions): SpawnedProcess => {
      const child = spawn(o.command, o.args, {
        cwd: o.cwd,
        env: o.env as NodeJS.ProcessEnv,
        signal: o.signal,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      })
      launched.spawned(child, o)
      return child as unknown as SpawnedProcess
    }

    const options: Options = {
      ...(binary ? { pathToClaudeCodeExecutable: binary } : {}),
      spawnClaudeCodeProcess,
      model: profile.model,
      cwd: profile.cwd,
      settingSources: [],
      maxTurns: profile.max_turns,
      ...(profile.max_budget_usd === null ? {} : { maxBudgetUsd: profile.max_budget_usd }),
      allowedTools: [
        ...profile.allowed_tools,
        ...Object.keys(profile.mcp_servers).map((name) => `mcp__${name}`),
      ],
      ...mcpOptions(profile.mcp_servers),
      permissionMode: SDK_PERMISSION_MODE[profile.permission_mode],
      ...(profile.permission_mode === "bypass" ? { allowDangerouslySkipPermissions: true } : {}),
      env: { ...env, ...profile.env },
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
      mcp_servers: Object.keys(profile.mcp_servers),
    })
    ctx.notifyRun()

    const queryFn = this.deps.queryFn ?? ((a) => sdkQuery(a))
    // Supervisor: tiempo máximo de reloj. Abortar pasa por el mismo camino que cancelar.
    const deadline = setTimeout(() => {
      this.abortCause.set(run.id, "timeout")
      abort.abort("timeout")
    }, profile.max_wall_ms)
    let thrown: string | null = null
    try {
      for await (const message of queryFn({ prompt, options })) {
        const raw = message as unknown as Record<string, unknown> & { type: string; uuid?: string }
        const key = raw.uuid ? `msg:${raw.uuid}` : `msg:${raw.type}:${ulid()}`
        const { payload: m } = ctx.ingest(
          `sdk.${raw.type}`,
          key,
          raw,
          typeof raw.timestamp === "string" ? raw.timestamp : null,
        )
        const changed = projector.onMessage(m)
        if (m.type === "system" && projector.sessionId)
          launched.update({ session_id: projector.sessionId })
        if (changed.run) ctx.notifyRun()
        notifyProjection(key, changed)
      }
    } catch (e) {
      thrown = e instanceof Error ? e.message : String(e)
    } finally {
      clearTimeout(deadline)
    }
    // Un único punto decide cómo terminó (run-outcome de @keel/core). La salida del
    // proceso puede llegar justo después del fin del stream: se espera un momento.
    const exit = await launched.exited(2_000)
    const cause = abort.signal.aborted ? (this.abortCause.get(run.id) ?? "cancelled") : null
    const end = projector.finish(
      { aborted: cause, thrown, exit, authMode: profile.auth_mode },
      thrown,
    )
    this.running.delete(run.id)
    this.abortCause.delete(run.id)
    store.mergeManifest(run.id, { outcome: end.outcome })
    if (end.outcome.status !== "completed" && end.outcome.status !== "cancelled")
      ctx.record(
        "run.failure",
        `failure:${run.id}`,
        {
          ...end.outcome,
          message: thrown,
          provider_errors: end.signals.result?.errors ?? [],
          terminal_reason: end.signals.result?.terminal_reason ?? null,
          exit,
        },
        null,
      )
    if (cause === "cancelled")
      ctx.record(
        "run.cancelled",
        `end:${run.id}`,
        { message: thrown, tool_calls: end.toolCalls },
        null,
      )
    ctx.notifyRun()
    notifyProjection(`end:${run.id}`, { agent: end.agent, toolCalls: end.toolCalls })
    return store.getRun(run.id) as RunRow
  }

  /**
   * Registra en el manifest el proceso lanzado: pid al instante, identidad
   * (arranque y ejecutable) en cuanto la tabla de procesos la da, `session_id`
   * cuando llega `init`. Si el proceso sale con error, guarda la cola de stderr.
   */
  private processRecorder(ctx: RunContext) {
    const { run, store } = ctx
    let current: Record<string, unknown> | null = null
    let child: ChildProcess | null = null
    let exitInfo: { code: number | null; signal: string | null } | null = null
    const update = (patch: Record<string, unknown>) => {
      if (!current) return
      current = { ...current, ...patch }
      store.mergeManifest(run.id, { provider_process: current })
    }
    return {
      update,
      /** Salida del proceso, esperando hasta `ms` si aún no salió; null si nunca se lanzó. */
      exited: (ms: number): Promise<{ code: number | null; signal: string | null } | null> => {
        const c = child
        if (exitInfo || !c) return Promise.resolve(exitInfo)
        return new Promise((ok) => {
          const t = setTimeout(() => ok(exitInfo), ms)
          c.once("exit", () => {
            clearTimeout(t)
            ok(exitInfo)
          })
        })
      },
      spawned: (spawnedChild: ChildProcess, o: SpawnOptions) => {
        child = spawnedChild
        let stderrTail = ""
        spawnedChild.stderr?.on("data", (b: Buffer) => {
          stderrTail = (stderrTail + b.toString("utf8")).slice(-8192)
        })
        spawnedChild.once("exit", (code, signal) => {
          exitInfo = { code, signal }
          if (code !== 0 && stderrTail)
            ctx.record(
              "provider.stderr",
              `stderr:${run.id}:${ulid()}`,
              { code, signal, tail: stderrTail },
              null,
            )
        })
        const pid = spawnedChild.pid
        if (pid === undefined) return
        current = { pid, started_at: null, exe: null, cwd: o.cwd ?? null, command: o.command }
        store.mergeManifest(run.id, { provider_process: current })
        void this.processes
          .get(pid)
          .then((info) => {
            if (info)
              update({ started_at: info.startedAt, exe: info.exe, cwd: info.cwd ?? o.cwd ?? null })
          })
          .catch(() => undefined)
      },
    }
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

/**
 * Sólo los servidores que pasa Keel (`strictMcpConfig`: nada de `.mcp.json` ni
 * de la configuración del usuario). `alwaysLoad` hace que el arranque espere a
 * que el servidor conecte, de modo que el puente se vincula antes del primer
 * turno (ADR-0009 §3); sin él, el SDK arranca los servidores MCP sin bloquear.
 */
function mcpOptions(servers: ClaudeProfile["mcp_servers"]): Partial<Options> {
  const names = Object.keys(servers)
  if (names.length === 0) return {}
  return {
    strictMcpConfig: true,
    mcpServers: Object.fromEntries(
      names.map((name) => {
        const s = servers[name] as ClaudeProfile["mcp_servers"][string]
        return [
          name,
          { type: "stdio", command: s.command, args: s.args, env: s.env, alwaysLoad: true },
        ]
      }),
    ),
  }
}
