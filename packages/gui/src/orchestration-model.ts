/**
 * ADR-0041 §2: la conversación es una vista de tres columnas y lo que ocupa el foco
 * depende de en qué va el lote. Se decide con código, de los eventos de la
 * conversación (ADR-0034 §5): nada que el humano tenga que elegir.
 *
 * - `empty`: sin mensajes; el foco invita a empezar (canvas CTO / 01).
 * - `thread`: una charla sin plan ni lote; el hilo ocupa el centro.
 * - `plan`: el orquestador propuso un lote y espera; el plan toma el centro y el hilo se
 *   angosta a la izquierda con su composer (CTO / 03).
 * - `batch`: el lote corre; el hilo vuelve al centro y a la derecha queda el lote en
 *   vivo (CTO / 04).
 */
import type { EventNotification } from "@keel/core"
import type { Approval } from "./chat-model.js"

export type Stage =
  | { kind: "empty" }
  | { kind: "thread" }
  | { kind: "plan"; plan: Approval }
  | { kind: "batch"; batch: { id: string; display_id: string } }

type Loose = Record<string, unknown>

/** La etapa de la conversación, de los eventos de sus runs. */
export function stageOf(events: EventNotification[], runIds: ReadonlySet<string>): Stage {
  if (runIds.size === 0) return { kind: "empty" }
  let plan: Approval | null = null
  let batch: { id: string; display_id: string } | null = null
  const resolved = new Set<string>()
  for (const e of events) {
    if (e.run_id === null || !runIds.has(e.run_id)) continue
    const p = (e.payload ?? {}) as Loose
    if (e.kind === "approval.requested" && p.tool === "batch.plan")
      plan = {
        kind: "approval",
        key: `plan:${String(p.approval_id)}`,
        approval_id: String(p.approval_id),
        operation_hash: String(p.operation_hash),
        tool: "batch.plan",
        input: p.input,
        expires_at: typeof p.expires_at === "string" ? p.expires_at : null,
        decision: null,
        answers: null,
        reason: null,
        plan: null,
      }
    else if (e.kind === "approval.resolved" && typeof p.approval_id === "string")
      resolved.add(p.approval_id)
    else if (e.kind === "batch.started") {
      const b = p.batch as { id?: unknown; display_id?: unknown } | null
      if (b && typeof b.id === "string")
        batch = { id: b.id, display_id: String(b.display_id ?? "") }
    }
  }
  if (plan && !resolved.has(plan.approval_id)) return { kind: "plan", plan }
  if (batch) return { kind: "batch", batch }
  return { kind: "thread" }
}

/** «A», «B»…: el nombre de un carril en la GUI. */
export const laneName = (n: number) => String.fromCharCode(65 + n)

/** «Claude · Opus», «Codex»: quién trabaja una subtarea. */
export function agentName(p: { provider: string; model?: string | undefined } | null): string {
  if (!p) return "Claude"
  const provider = p.provider === "codex" ? "Codex" : "Claude"
  const model = p.model
    ?.replace(/^claude-/, "")
    .replace(/-\d.*$/, "")
    .replace(/^\w/, (c) => c.toUpperCase())
  return model && p.provider !== "codex" ? `${provider} · ${model}` : provider
}

/** La frontera en una línea: la primera ruta y cuántas más. */
export function leaseOf(frontier: readonly string[]): string {
  if (frontier.length === 0) return "sin frontera"
  const [first, ...rest] = frontier
  return rest.length ? `${first} +${rest.length}` : (first as string)
}

const STAGES = ["brief", "design", "implement", "review", "close"] as const

/** En qué paso del método va: «3 de 5». */
export function stepOf(stage: string | null): { n: number; of: number } {
  const i = stage ? STAGES.indexOf(stage as (typeof STAGES)[number]) : -1
  return { n: i < 0 ? 0 : i + 1, of: STAGES.length }
}
