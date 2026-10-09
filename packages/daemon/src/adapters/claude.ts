/**
 * Adaptador del Claude Agent SDK (ADR-0001 §2 invariante del adaptador,
 * ADR-0002 modos de autenticación, ADR-0003 §9 procesos hijos).
 *
 * - Modo `subscription_session`: usa el binario de Claude Code instalado por el
 *   usuario y quita cualquier API key del entorno del hijo (sin fallback
 *   silencioso). Keel no lee ni escribe credenciales.
 * - Modo `api_key`: exige `ANTHROPIC_API_KEY` en el entorno; si no está, falla.
 * - Cada mensaje y cada hook se persiste en `events` (raw íntegro) y se proyecta.
 * - `canUseTool` con temporizador del daemon: al expirar, deniega y deja la
 *   solicitud en `approval_requests` (SDD 02 §9; FINDINGS §3: el SDK no lo hace).
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
import type { EventBus } from "../bus.js"
import { canonicalJson, nowIso, sha256Hex, ulid } from "../ids.js"
import { RunProjector } from "../projector.js"
import type { Repo, RunRow } from "../store/repo.js"

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

export type ApprovalWaiter = (
  approvalId: string,
  timeoutMs: number,
) => Promise<"approved" | "denied" | "expired">

export type ClaudeAdapterDeps = {
  repo: Repo
  bus: EventBus
  queryFn?: QueryFn
  waitApproval: ApprovalWaiter
  /** Para tests: ruta al binario; por defecto se detecta el instalado. */
  binary?: string | null
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

export class ClaudeAdapter {
  private readonly running = new Map<string, { abort: AbortController; projector: RunProjector }>()
  private readonly deps: ClaudeAdapterDeps
  constructor(deps: ClaudeAdapterDeps) {
    this.deps = deps
  }

  get activeRuns(): number {
    return this.running.size
  }

  cancel(runId: string, reason: string | null): boolean {
    const r = this.running.get(runId)
    if (!r) return false
    r.abort.abort(reason ?? "cancelled")
    return true
  }

  /** Ejecuta el run hasta el final. Resuelve cuando el run está en estado terminal. */
  async execute(run: RunRow, prompt: string, profile: ClaudeProfile): Promise<RunRow> {
    const { repo, bus } = this.deps
    const env = this.buildEnv(profile)
    const binary = this.deps.binary === undefined ? detectClaudeBinary() : this.deps.binary
    if (profile.auth_mode === "subscription_session" && !binary) {
      return this.failBeforeStart(
        run,
        "subscription_session requiere el binario `claude` instalado por el usuario; no se encontró",
      )
    }
    const rootAgentId = `${run.id}:root`
    const projector = new RunProjector({ repo, run, provider: "claude", rootAgentId })
    const abort = new AbortController()
    this.running.set(run.id, { abort, projector })

    const record = (kind: string, key: string, payload: unknown, occurredAt: string | null) => {
      const e = repo.appendEvent({
        project_id: run.project_id,
        run_id: run.id,
        source: SOURCE,
        source_event_key: key,
        fidelity: "full",
        adapter_version: ADAPTER_VERSION,
        kind,
        occurred_at: occurredAt,
        payload_json: JSON.stringify(payload),
      })
      if (e)
        bus.publish({
          event_seq: e.event_seq,
          kind: e.kind,
          project_id: e.project_id,
          run_id: e.run_id,
          received_at: e.received_at,
          payload: payload,
        })
    }
    const notifyRun = () => {
      const r = repo.getRun(run.id)
      if (r) record("run.updated", `run.updated:${run.id}:${ulid()}`, repo.runView(r), null)
    }

    const hook: HookCallback = async (input: HookInput, toolUseID) => {
      const name = input.hook_event_name
      const key = `hook:${input.session_id}:${name}:${toolUseID ?? ""}:${ulid()}`
      record(`hook.${name}`, key, { ...input, tool_use_id_callback: toolUseID ?? null }, null)
      const changed = projector.onHook(name, input as unknown as Record<string, unknown>, toolUseID)
      if (changed.agent || changed.toolCalls?.length)
        record(
          "projection.updated",
          `proj:${key}`,
          { agent: changed.agent ?? null, tool_calls: changed.toolCalls ?? [] },
          null,
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
      const operation = { tool: toolName, input, run_id: run.id }
      const hash = await sha256Hex(canonicalJson(operation))
      const expires = new Date(Date.now() + profile.approval_timeout_ms).toISOString()
      const approvalId = repo.createApproval({
        project_id: run.project_id,
        run_id: run.id,
        operation_hash: hash,
        operation,
        expires_at: expires,
      })
      repo.updateRun(run.id, { status: "waiting_human" })
      record(
        "approval.requested",
        `approval:${approvalId}`,
        { approval_id: approvalId, operation_hash: hash, tool: toolName, expires_at: expires },
        null,
      )
      notifyRun()
      const decision = await Promise.race([
        this.deps.waitApproval(approvalId, profile.approval_timeout_ms),
        new Promise<"denied">((resolve) =>
          opts.signal.addEventListener("abort", () => resolve("denied"), { once: true }),
        ),
      ])
      const current = repo.getRun(run.id)
      if (current?.status === "waiting_human") repo.updateRun(run.id, { status: "running" })
      if (decision === "expired") repo.setApproval(approvalId, "expired", null)
      record(
        "approval.resolved",
        `approval:${approvalId}:${decision}`,
        { approval_id: approvalId, decision },
        null,
      )
      notifyRun()
      if (decision === "approved") {
        repo.setApproval(approvalId, "consumed", null)
        return { behavior: "allow", updatedInput: input }
      }
      return {
        behavior: "deny",
        message:
          decision === "expired"
            ? `Keel: sin decisión humana en ${Math.round(profile.approval_timeout_ms / 1000)} s; denegado (deny-on-timeout). La solicitud ${approvalId} queda en el inbox.`
            : `Keel: denegado por el humano (${approvalId}).`,
      }
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
    repo.updateRun(run.id, { status: "initializing", started_at: nowIso() })
    repo.mergeManifest(run.id, {
      adapter: ADAPTER_VERSION,
      auth_mode: profile.auth_mode,
      binary,
      model: profile.model,
    })
    notifyRun()

    const queryFn = this.deps.queryFn ?? ((a) => sdkQuery(a))
    let processRecorded = false
    try {
      for await (const message of queryFn({ prompt, options })) {
        const m = message as unknown as Record<string, unknown> & { type: string; uuid?: string }
        const key = m.uuid ? `msg:${m.uuid}` : `msg:${m.type}:${ulid()}`
        record(`sdk.${m.type}`, key, m, typeof m.timestamp === "string" ? m.timestamp : null)
        const changed = projector.onMessage(m)
        if (!processRecorded && m.type === "system" && binary) {
          processRecorded = true
          const proc = findChildProcess(binary, profile.cwd)
          repo.mergeManifest(run.id, {
            provider_process: proc ? { ...proc, session_id: projector.sessionId } : null,
          })
        }
        if (changed.run) notifyRun()
        if (changed.agent || changed.toolCalls?.length)
          record(
            "projection.updated",
            `proj:${key}`,
            { agent: changed.agent ?? null, tool_calls: changed.toolCalls ?? [] },
            null,
          )
      }
      const final = repo.getRun(run.id)
      if (
        final &&
        !["completed", "failed", "cancelled", "interrupted", "budget_exceeded"].includes(
          final.status,
        )
      ) {
        // El stream terminó sin `result`: no inventar éxito.
        projector.onCancelled("interrupted", "el stream del SDK terminó sin mensaje result")
        notifyRun()
      }
    } catch (e) {
      const aborted = abort.signal.aborted
      const msg = e instanceof Error ? e.message : String(e)
      const changed = projector.onCancelled(aborted ? "cancelled" : "interrupted", msg)
      record(
        aborted ? "run.cancelled" : "run.interrupted",
        `end:${run.id}`,
        { message: msg, tool_calls: changed.toolCalls },
        null,
      )
      notifyRun()
    } finally {
      this.running.delete(run.id)
    }
    return repo.getRun(run.id) as RunRow
  }

  private buildEnv(profile: ClaudeProfile): Record<string, string | undefined> {
    const env: Record<string, string | undefined> = { ...process.env }
    if (profile.auth_mode === "subscription_session") {
      // Sin fallback silencioso: en modo sesión el hijo no ve API keys.
      delete env.ANTHROPIC_API_KEY
      delete env.ANTHROPIC_AUTH_TOKEN
    } else if (
      profile.auth_mode === "api_key" &&
      !env.ANTHROPIC_API_KEY &&
      !env.ANTHROPIC_AUTH_TOKEN
    ) {
      throw new Error(
        "api_key requiere ANTHROPIC_API_KEY o ANTHROPIC_AUTH_TOKEN en el entorno del daemon",
      )
    }
    return env
  }

  private failBeforeStart(run: RunRow, message: string): RunRow {
    const t = nowIso()
    const r = this.deps.repo.updateRun(run.id, {
      status: "failed",
      end_reason: "fatal_error",
      started_at: t,
      ended_at: t,
    })
    this.deps.repo.appendEvent({
      project_id: run.project_id,
      run_id: run.id,
      source: SOURCE,
      source_event_key: `start-failed:${run.id}`,
      fidelity: "full",
      adapter_version: ADAPTER_VERSION,
      kind: "run.start_failed",
      occurred_at: null,
      payload_json: JSON.stringify({ message }),
    })
    return r
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
