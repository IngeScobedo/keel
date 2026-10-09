/**
 * Vocabulario de estados y su proyección visual (ADR-0006).
 *
 * Tres enumeraciones del dominio (tarea, run, nodo de ejecución) y una tabla
 * canónica que las lleva a los 13 estados visuales del canvas. El daemon
 * calcula `visual_state` con estas funciones y lo manda por el protocolo
 * (ADR-0005); ningún cliente reimplementa el mapeo. Añadir un valor a
 * `VISUAL_STATES` es un cambio de protocolo.
 */

export const LIFECYCLES = [
  "triage",
  "planned",
  "running",
  "waiting_human",
  "blocked",
  "needs_review",
  "failed",
  "done",
] as const
export type Lifecycle = (typeof LIFECYCLES)[number]

export const RUN_STATUSES = [
  "queued",
  "initializing",
  "running",
  "paused",
  "waiting_human",
  "completed",
  "failed",
  "cancelled",
  "interrupted",
  "budget_exceeded",
] as const
export type RunStatus = (typeof RUN_STATUSES)[number]

/** Estados de run que cuentan como vivo: mismos que `idx_live_run` (SDD 03). */
export const LIVE_RUN_STATUSES: readonly RunStatus[] = [
  "queued",
  "initializing",
  "running",
  "paused",
  "waiting_human",
]

export const RUN_PURPOSES = ["plan", "execute", "triage_eval"] as const
export type RunPurpose = (typeof RUN_PURPOSES)[number]

export const NODE_STATES = [
  "pending",
  "running",
  "waiting_human",
  "succeeded",
  "failed",
  "cancelled",
  "interrupted",
  "orphan",
] as const
export type NodeState = (typeof NODE_STATES)[number]

export const VISUAL_STATES = [
  "queued",
  "planning",
  "paused",
  "running",
  "waiting_human",
  "needs_review",
  "blocked",
  "succeeded",
  "failed",
  "cancelled",
  "interrupted",
  "orphan",
  "budget_stop",
] as const
export type VisualState = (typeof VISUAL_STATES)[number]

export const VISUAL_FAMILIES = {
  queued: "neutral",
  planning: "violet",
  paused: "neutral",
  running: "blue",
  waiting_human: "amber",
  needs_review: "amber",
  blocked: "orange",
  succeeded: "green",
  failed: "red",
  cancelled: "gray",
  interrupted: "teal",
  orphan: "magenta",
  budget_stop: "pink",
} as const satisfies Record<VisualState, string>

/** «Needs you» es un filtro, no un estado: todo lo ámbar. */
export const NEEDS_YOU: readonly VisualState[] = ["waiting_human", "needs_review"]

/** Lo que el daemon sabe del run vivo de una tarea, si lo hay. */
export type LiveRun = { status: RunStatus; purpose: RunPurpose } | null

/**
 * Tarea → visual. `planning` sólo existe con un run vivo de `purpose = 'plan'`
 * detrás; una tarea cuyo Reasoner no corre está `queued`.
 */
export function visualForWorkItem(lifecycle: Lifecycle, liveRun: LiveRun): VisualState {
  switch (lifecycle) {
    case "triage":
      return liveRun && liveRun.purpose === "plan" && isLive(liveRun.status) ? "planning" : "queued"
    case "planned":
      return "queued"
    case "running":
      return "running"
    case "waiting_human":
      return "waiting_human"
    case "needs_review":
      return "needs_review"
    case "blocked":
      return "blocked"
    case "failed":
      return "failed"
    case "done":
      return "succeeded"
  }
}

/** Run → visual. `purpose = 'plan'` vivo se pinta `planning`, no `running`. */
export function visualForRun(status: RunStatus, purpose: RunPurpose): VisualState {
  if (purpose === "plan" && isLive(status) && status !== "paused" && status !== "waiting_human") {
    return "planning"
  }
  switch (status) {
    case "queued":
    case "initializing":
      return "queued"
    case "paused":
      return "paused"
    case "running":
      return "running"
    case "waiting_human":
      return "waiting_human"
    case "completed":
      return "succeeded"
    case "failed":
      return "failed"
    case "cancelled":
      return "cancelled"
    case "interrupted":
      return "interrupted"
    case "budget_exceeded":
      return "budget_stop"
  }
}

/** Nodo de ejecución (agente, workflow, tool call) → visual. */
export function visualForNode(state: NodeState): VisualState {
  switch (state) {
    case "pending":
      return "queued"
    case "running":
      return "running"
    case "waiting_human":
      return "waiting_human"
    case "succeeded":
      return "succeeded"
    case "failed":
      return "failed"
    case "cancelled":
      return "cancelled"
    case "interrupted":
      return "interrupted"
    case "orphan":
      return "orphan"
  }
}

export function isLive(status: RunStatus): boolean {
  return LIVE_RUN_STATUSES.includes(status)
}

export function isVisualState(value: unknown): value is VisualState {
  return typeof value === "string" && (VISUAL_STATES as readonly string[]).includes(value)
}

/**
 * Lo que un cliente hace con un `visual_state` que no conoce (ADR-0006 §3):
 * familia neutra y el texto crudo del estado. Nunca ocultar la entidad.
 */
export function visualFallback(rawState: string): { family: "neutral"; label: string } {
  return { family: "neutral", label: rawState }
}

export type ConformanceRow =
  | { entity: "work_item"; state: Lifecycle; live_run: LiveRun; visual_state: VisualState }
  | { entity: "run"; state: RunStatus; purpose: RunPurpose; visual_state: VisualState }
  | { entity: "node"; state: NodeState; visual_state: VisualState }

/**
 * Tabla canónica de conformidad: todas las combinaciones de las tres
 * enumeraciones con su visual. Es el artefacto que los tests del daemon y de
 * los clientes comparan; se exporta como fixture (`fixtures/visual-state.json`).
 */
export function conformanceTable(): ConformanceRow[] {
  const rows: ConformanceRow[] = []
  const liveRuns: LiveRun[] = [null]
  for (const status of RUN_STATUSES)
    for (const purpose of RUN_PURPOSES) liveRuns.push({ status, purpose })
  for (const state of LIFECYCLES)
    for (const live_run of liveRuns)
      rows.push({
        entity: "work_item",
        state,
        live_run,
        visual_state: visualForWorkItem(state, live_run),
      })
  for (const state of RUN_STATUSES)
    for (const purpose of RUN_PURPOSES)
      rows.push({ entity: "run", state, purpose, visual_state: visualForRun(state, purpose) })
  for (const state of NODE_STATES)
    rows.push({ entity: "node", state, visual_state: visualForNode(state) })
  return rows
}
