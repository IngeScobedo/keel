/**
 * Esquemas Zod para lo que cruza limites de proceso, y la derivacion de campos del
 * payload crudo de hooks. Regla de ADR-002: derivar nunca lanza; lo indeterminable es null.
 */
import { z } from "zod"

/** Linea NDJSON que escribe hook-bridge (Fase 1) y que barre el sweeper (ADR-006). */
export const hookLineSchema = z.object({
  id: z.string().min(1),
  received_at: z.string().min(1),
  hook_event_name: z.string().nullable(),
  cwd: z.string().nullable(),
  session_id: z.string().nullable(),
  raw: z.unknown(),
})

export type HookLine = z.infer<typeof hookLineSchema>

export const UNKNOWN_KIND = "(sin hook_event_name)"
export const NO_SESSION = "(sin session_id)"

function rec(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null
}

export function rawString(raw: unknown, key: string): string | null {
  const r = rec(raw)
  const v = r ? r[key] : undefined
  return typeof v === "string" ? v : null
}

export function rawNumber(raw: unknown, key: string): number | null {
  const r = rec(raw)
  const v = r ? r[key] : undefined
  return typeof v === "number" && Number.isFinite(v) ? v : null
}

export function rawRecord(raw: unknown, key: string): Record<string, unknown> | null {
  const r = rec(raw)
  return r ? rec(r[key]) : null
}

export function rawArray(raw: unknown, key: string): unknown[] | null {
  const r = rec(raw)
  const v = r ? r[key] : undefined
  return Array.isArray(v) ? v : null
}

/** `agent_type: ""` se normaliza a null y NUNCA se trata como un tipo (ADR-008 §9). */
export function normalizeAgentType(v: string | null): string | null {
  return v === "" ? null : v
}

/** Campos que la correlacion lee de una linea de hook. Todo lo dudoso es null. */
export type DerivedFields = {
  kind: string
  sessionId: string
  transcriptPath: string | null
  agentId: string | null
  agentType: string | null
  toolName: string | null
  toolUseId: string | null
  promptId: string | null
}

export function deriveFields(line: HookLine): DerivedFields {
  const raw = line.raw
  return {
    kind: line.hook_event_name ?? rawString(raw, "hook_event_name") ?? UNKNOWN_KIND,
    sessionId: line.session_id ?? rawString(raw, "session_id") ?? NO_SESSION,
    transcriptPath: rawString(raw, "transcript_path"),
    agentId: rawString(raw, "agent_id"),
    agentType: normalizeAgentType(rawString(raw, "agent_type")),
    toolName: rawString(raw, "tool_name"),
    toolUseId: rawString(raw, "tool_use_id"),
    promptId: rawString(raw, "prompt_id"),
  }
}
