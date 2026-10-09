/**
 * Envelope canonico de eventos (ADR-002): delgado, estable, `raw` integro.
 * Los campos se DERIVAN de raw; si la derivacion falla van null y el evento entra igual.
 */

export type EventSource = "hook" | "jsonl" | "otel" | "sdk"
export type Fidelity = "full" | "partial"

export type AgentEvent = {
  // identidad
  id: string // ULID, ordenable en el tiempo
  received_at: string // ISO — autoridad de orden
  occurred_at: string | null // reloj de la fuente, si lo da

  // procedencia (ADR-001)
  source: EventSource
  fidelity: Fidelity
  adapter_version: string

  // correlacion (ADR-008)
  run_id: string
  session_id: string
  agent_id: string
  parent_agent_id: string | null
  tool_use_id: string | null

  // clasificacion minima
  kind: string // string libre, NO enum (ADR-002)
  tool_name: string | null

  // el dato
  raw: unknown
}
