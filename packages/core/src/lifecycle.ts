/**
 * Máquina de estados de la tarea (SDD 01 §3, ADR-0006 nivel «tarea»).
 *
 * Tabla pura: qué transiciones existen y quién puede pedirlas. El daemon la
 * aplica a todo cambio de `work_items.lifecycle`, venga del protocolo o de su
 * propio supervisor; ningún otro proceso la reimplementa.
 *
 * Autoridad:
 * - `human`: la puede pedir un cliente por `work_items.transition`.
 * - `system`: sólo el scheduler o el supervisor de runs del daemon.
 * - `human_close`: el cierre humano explícito (SDD 01 §3), un comando aparte
 *   que adjunta razón y evidencia; `work_items.transition` nunca lo cumple.
 */
import type { Lifecycle, RunPurpose } from "./visual-state.js"

export type TransitionAuthority = "human" | "system" | "human_close"

export type LifecycleEdge = { from: Lifecycle; to: Lifecycle; by: TransitionAuthority }

export const LIFECYCLE_EDGES: readonly LifecycleEdge[] = [
  { from: "triage", to: "planned", by: "human" }, // alcance y plan válidos
  { from: "planned", to: "running", by: "system" }, // el scheduler reserva recursos
  { from: "planned", to: "blocked", by: "system" }, // dependencias pendientes
  { from: "running", to: "blocked", by: "system" }, // checkpoint por dependencia
  { from: "running", to: "waiting_human", by: "system" }, // decisión necesaria
  { from: "running", to: "needs_review", by: "system" }, // evidencia independiente válida
  { from: "running", to: "failed", by: "system" }, // fallo, presupuesto o run interrumpido
  // Cancelar el run devuelve la tarea a `planned`. No está en el diagrama del
  // SDD 01 §3, que describe el recorrido normal; queda anotado para el SDD.
  { from: "running", to: "planned", by: "system" },
  { from: "waiting_human", to: "planned", by: "human" }, // la decisión permite continuar
  { from: "blocked", to: "planned", by: "system" }, // todas las guardas satisfechas
  { from: "failed", to: "planned", by: "human" }, // replanificación
  { from: "needs_review", to: "planned", by: "human" }, // cambios solicitados
  { from: "needs_review", to: "done", by: "human_close" }, // aceptación humana
  // ADR-0027: cierre a mano, con motivo y evidencia, de trabajo hecho fuera de Keel.
  { from: "triage", to: "done", by: "human_close" },
  { from: "planned", to: "done", by: "human_close" },
  { from: "waiting_human", to: "done", by: "human_close" },
  { from: "failed", to: "done", by: "human_close" },
]

export function lifecycleEdge(from: Lifecycle, to: Lifecycle): LifecycleEdge | null {
  return LIFECYCLE_EDGES.find((e) => e.from === from && e.to === to) ?? null
}

/** Destinos alcanzables desde `from` con esa autoridad (para mensajes de error y para la UI). */
export function allowedTransitions(from: Lifecycle, by: TransitionAuthority): Lifecycle[] {
  return LIFECYCLE_EDGES.filter((e) => e.from === from && e.by === by).map((e) => e.to)
}

export type TransitionCheck =
  | { ok: true; edge: LifecycleEdge }
  | { ok: false; reason: "no_such_transition" | "wrong_authority"; edge: LifecycleEdge | null }

export function checkTransition(
  from: Lifecycle,
  to: Lifecycle,
  by: TransitionAuthority,
): TransitionCheck {
  const edge = lifecycleEdge(from, to)
  if (!edge) return { ok: false, reason: "no_such_transition", edge: null }
  if (edge.by !== by) return { ok: false, reason: "wrong_authority", edge }
  return { ok: true, edge }
}

/**
 * Desde qué lifecycle se puede iniciar un run de cada `purpose`, y a qué
 * lifecycle pasa la tarea al iniciarlo. El Reasoner (`plan`, `triage_eval`)
 * trabaja en `triage` sin moverla (ADR-0006 §2: `planning` es visual, no
 * lifecycle); `execute` sólo arranca desde `planned` y la lleva a `running`.
 * Los bloqueos abiertos (`work_item_blocks`) se comprueban aparte.
 */
export const RUN_START_RULES: Record<RunPurpose, { from: Lifecycle; to: Lifecycle }> = {
  plan: { from: "triage", to: "triage" },
  triage_eval: { from: "triage", to: "triage" },
  execute: { from: "planned", to: "running" },
}
