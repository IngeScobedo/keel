/**
 * Proyección de eventos del Claude Agent SDK a `runs`, `agent_instances` y
 * `tool_calls` (ADR-0004 §4: proyecciones, no verdad). Pura respecto al SDK:
 * recibe mensajes y hooks ya serializados y escribe por el `ProjectionStore`.
 *
 * Identidad de agentes (ADR-0002 §4, canal 0 `sdk`): un mensaje con `agent_id`
 * es de un subagente; su `parent_tool_use_id` es el bloque `tool_use` `Agent`
 * del mensaje padre, y el `agent_id` de ese mensaje (o null = root) es el padre.
 */
import {
  classifyRunOutcome,
  type NodeState,
  type RunOutcome,
  type RunSignals,
  toolCallLabel,
} from "@keel/core"
import type { ProjectionStore } from "./adapters/provider.js"
import { nowIso } from "./ids.js"
import { inlineOrPreview } from "./payload.js"
import type { RunRow } from "./store/repo.js"

type Json = Record<string, unknown>

export type ProjectorContext = {
  store: ProjectionStore
  run: RunRow
  provider: "claude"
  /** id del agente raíz en `agent_instances` */
  rootAgentId: string
}

/** Estado en memoria por run: qué tool_use pertenece a qué agente, y session_id. */
export class RunProjector {
  readonly toolUseOwner = new Map<string, string>() // tool_use_id (toolu_…) -> agent_id (fila)
  sessionId: string | null = null
  model: string | null = null
  private rootCreated = false
  /** Señales para clasificar el final (run-outcome de @keel/core). */
  private readonly signals: RunSignals = {}

  readonly ctx: ProjectorContext
  constructor(ctx: ProjectorContext) {
    this.ctx = ctx
  }

  private agentRowId(sdkAgentId: string | null | undefined): string {
    return sdkAgentId ? `${this.ctx.run.id}:${sdkAgentId}` : this.ctx.rootAgentId
  }

  private ensureRoot(sessionId: string, model: string | null): void {
    if (this.rootCreated) return
    this.rootCreated = true
    const t = nowIso()
    this.ctx.store.upsertAgent({
      id: this.ctx.rootAgentId,
      run_id: this.ctx.run.id,
      provider: this.ctx.provider,
      session_id: sessionId,
      external_agent_id: null,
      parent_agent_id: null,
      parent_source: null,
      classification: "root",
      state: "running",
      agent_type: null,
      model,
      first_seen: t,
      last_seen: t,
    })
  }

  /** Mensaje del stream de `query()`. Devuelve qué cambió para notificar. */
  onMessage(m: Json): { run?: Partial<RunRow>; agent?: string; toolCalls?: string[] } {
    const type = String(m.type ?? "")
    const t = nowIso()
    if (type === "system" && m.subtype === "init") {
      this.sessionId = String(m.session_id ?? "")
      this.model = typeof m.model === "string" ? m.model : null
      this.ensureRoot(this.sessionId, this.model)
      this.ctx.store.updateRun(this.ctx.run.id, {
        status: "running",
        started_at: this.ctx.run.started_at ?? t,
      })
      return { run: { status: "running" }, agent: this.ctx.rootAgentId }
    }
    if (type === "assistant") {
      // `error` lo pone el SDK cuando el turno falló contra la API (authentication_failed, rate_limit…).
      if (typeof m.error === "string") this.signals.providerError = m.error
      const sdkAgent = typeof m.agent_id === "string" ? m.agent_id : null
      const parentToolUse = typeof m.parent_tool_use_id === "string" ? m.parent_tool_use_id : null
      const agentId = this.agentRowId(sdkAgent)
      if (sdkAgent) {
        const parentAgentId = parentToolUse
          ? (this.toolUseOwner.get(parentToolUse) ?? this.ctx.rootAgentId)
          : null
        this.ctx.store.upsertAgent({
          id: agentId,
          run_id: this.ctx.run.id,
          provider: this.ctx.provider,
          session_id: this.sessionId ?? String(m.session_id ?? ""),
          external_agent_id: sdkAgent,
          parent_agent_id: parentAgentId,
          parent_source: parentAgentId ? "sdk" : null,
          classification: "worker",
          state: "running",
          agent_type: null,
          model: readModel(m),
          first_seen: t,
          last_seen: t,
        })
      } else {
        this.ensureRoot(String(m.session_id ?? this.sessionId ?? ""), readModel(m))
      }
      const content = (m.message as Json | undefined)?.content
      if (Array.isArray(content)) {
        for (const block of content as Json[]) {
          if (block.type === "tool_use" && typeof block.id === "string")
            this.toolUseOwner.set(block.id, agentId)
        }
      }
      return { agent: agentId }
    }
    if (type === "result") {
      // Uso y costo; el estado del run lo decide `finish` con todas las señales.
      this.signals.result = {
        subtype: String(m.subtype ?? ""),
        is_error: m.is_error === true || (typeof m.subtype === "string" && m.subtype !== "success"),
        errors: Array.isArray(m.errors) ? (m.errors as unknown[]).map(String) : [],
        startup_failure_reason:
          typeof m.startup_failure_reason === "string" ? m.startup_failure_reason : null,
        terminal_reason: typeof m.terminal_reason === "string" ? m.terminal_reason : null,
      }
      const usage = (m.usage as Json | undefined) ?? {}
      const cost =
        typeof m.total_cost_usd === "number" ? Math.round(m.total_cost_usd * 1_000_000) : null
      const patch: Partial<RunRow> = {
        input_tokens:
          num(usage.input_tokens) +
          num(usage.cache_read_input_tokens) +
          num(usage.cache_creation_input_tokens),
        output_tokens: num(usage.output_tokens),
        total_cost_micro_usd: cost,
        // El SDK estima a precio de lista incluso con sesión de suscripción (FINDINGS); nunca es `observed`.
        cost_kind: cost === null ? "unknown" : "estimated",
      }
      this.ctx.store.updateRun(this.ctx.run.id, patch)
      return { run: patch }
    }
    return {}
  }

  /**
   * Hook in-process del SDK. `sourceEventId` es el evento que guardó el hook
   * íntegro: un cuerpo que no cabe en la proyección apunta a él.
   */
  onHook(
    name: string,
    input: Json,
    toolUseId: string | undefined,
    sourceEventId: string | null = null,
  ): { agent?: string; toolCalls?: string[] } {
    const t = nowIso()
    const sdkAgent = typeof input.agent_id === "string" ? input.agent_id : null
    const agentId = this.agentRowId(sdkAgent)
    if (name === "SubagentStart" && sdkAgent) {
      this.ctx.store.upsertAgent({
        id: agentId,
        run_id: this.ctx.run.id,
        provider: this.ctx.provider,
        session_id: String(input.session_id ?? this.sessionId ?? ""),
        external_agent_id: sdkAgent,
        parent_agent_id: null,
        parent_source: null,
        classification: "worker",
        state: "running",
        agent_type: typeof input.agent_type === "string" ? input.agent_type : null,
        model: null,
        first_seen: t,
        last_seen: t,
      })
      return { agent: agentId }
    }
    if (name === "SubagentStop" && sdkAgent) {
      this.ctx.store.setAgentState(agentId, "succeeded", t)
      return { agent: agentId }
    }
    if (name === "PreToolUse" && typeof input.tool_use_id === "string") {
      const toolUse = input.tool_use_id
      this.toolUseOwner.set(toolUse, agentId)
      const toolName = String(input.tool_name ?? "?")
      const inputJson = input.tool_input === undefined ? null : JSON.stringify(input.tool_input)
      const label = toolCallLabel(toolName, (input.tool_input as Json) ?? null) ?? toolName
      const row = this.ctx.store.openToolCall({
        run_id: this.ctx.run.id,
        agent_id: agentId,
        tool_use_id: toolUse,
        tool_name: toolName,
        label,
        started_at: t,
        input_json: inputJson,
      })
      return { agent: agentId, toolCalls: [row.id] }
    }
    if (
      (name === "PostToolUse" || name === "PostToolUseFailure") &&
      typeof input.tool_use_id === "string"
    ) {
      const ok = name === "PostToolUse"
      // K-06: preview JSON válido + referencia al cuerpo íntegro, nunca un slice.
      const output =
        ok && input.tool_response !== undefined
          ? inlineOrPreview(
              input.tool_response,
              sourceEventId
                ? `event:${sourceEventId}#/tool_response`
                : `tool_use:${input.tool_use_id}`,
            )
          : null
      const row = this.ctx.store.closeToolCall({
        run_id: this.ctx.run.id,
        tool_use_id: input.tool_use_id,
        state: ok ? "succeeded" : "failed",
        ended_at: t,
        duration_ms: typeof input.duration_ms === "number" ? input.duration_ms : null,
        output_json: output?.json ?? null,
        artifact_ref: output?.artifactRef ?? null,
        error_message: ok ? null : String((input as { error?: unknown }).error ?? "tool failed"),
      })
      return { agent: agentId, toolCalls: row ? [row.id] : [] }
    }
    if (name === "StopFailure") {
      if (typeof input.error === "string") this.signals.stopFailure = input.error
      this.ctx.store.setAgentState(
        agentId,
        "interrupted",
        t,
        String(input.error ?? input.message ?? "StopFailure"),
      )
      return { agent: agentId }
    }
    void toolUseId
    return {}
  }

  /**
   * Cierra el run con todas las señales: las que vio el proyector (result,
   * errores del proveedor, StopFailure) más las del adaptador (abortado, proceso,
   * excepción). Un único punto decide `status` y `end_reason` (run-outcome.ts).
   * Si el SDK no manda `result` tras abortar (FINDINGS §1), el daemon sintetiza.
   */
  finish(
    extra: RunSignals,
    message: string | null = null,
  ): {
    run: Partial<RunRow>
    outcome: RunOutcome
    signals: RunSignals
    agent: string
    toolCalls: string[]
  } {
    const t = nowIso()
    const signals = { ...this.signals, ...extra }
    const outcome = classifyRunOutcome(signals)
    const patch: Partial<RunRow> = {
      status: outcome.status,
      end_reason: outcome.end_reason,
      ended_at: t,
    }
    this.ctx.store.updateRun(this.ctx.run.id, patch)
    const stopped: "cancelled" | "interrupted" | null =
      outcome.status === "cancelled" || outcome.status === "interrupted" ? outcome.status : null
    if (stopped) {
      for (const a of this.ctx.store.agentsOfRun(this.ctx.run.id))
        if (["running", "waiting_human", "pending"].includes(a.state))
          this.ctx.store.setAgentState(a.id, stopped, t, message)
    } else {
      this.ctx.store.setAgentState(
        this.ctx.rootAgentId,
        outcome.status === "completed" ? "succeeded" : "failed",
        t,
        outcome.status === "completed" ? null : (outcome.provider_error ?? message),
      )
    }
    const toolCalls = this.closeOpenToolCalls(stopped ?? "orphan", t)
    return { run: patch, outcome, signals, agent: this.ctx.rootAgentId, toolCalls }
  }

  private closeOpenToolCalls(state: NodeState, t: string): string[] {
    const ids: string[] = []
    for (const tc of this.ctx.store.openToolCalls(this.ctx.run.id)) {
      const row = this.ctx.store.closeToolCall({
        run_id: this.ctx.run.id,
        tool_use_id: tc.tool_use_id,
        state,
        ended_at: t,
        duration_ms: null,
        output_json: null,
        error_message: state === "orphan" ? "sin cierre al terminar el run" : state,
      })
      if (row) ids.push(row.id)
    }
    return ids
  }
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0
}
function readModel(m: Json): string | null {
  const msg = m.message as Json | undefined
  return typeof msg?.model === "string" ? msg.model : null
}
