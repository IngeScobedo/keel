/**
 * Lo que la vista de tarea decide con código (ADR-0034 §5): la acción que toca, el plan
 * de la feature como DAG, la checklist derivada del spec, los carriles de subtareas y
 * por qué se abre el cajón. Puro: recibe lo que leyó la GUI y no llama al daemon.
 */
import { type PlannedTask, parseSpec, parseTasks, qaVerdict, type TaskFlowView } from "@keel/core"
import { type FileDiff, fromUnified } from "./chat-model.js"
import type { Run, WorkItem } from "./model.js"

const TERMINAL = new Set(["completed", "failed", "cancelled", "interrupted"])
export const isLive = (r: Run) => !TERMINAL.has(r.status)

export type NextAction =
  | { kind: "gate"; label: string }
  | { kind: "plan"; label: string }
  | { kind: "decide"; label: string }
  | { kind: "work"; label: string }
  | { kind: "watch"; label: string }
  | { kind: "close"; label: string }
  | { kind: "none"; label: string }

const GATE_LABEL = {
  brief: "Aprobar el brief",
  design: "Congelar el contrato",
  close: "Aprobar el cierre",
} as const

/** Una sola acción, la que toca ahora, en orden de urgencia. */
export function nextAction(
  task: WorkItem,
  flow: TaskFlowView | null,
  runs: Run[],
  pending: number,
): NextAction {
  if (task.lifecycle === "done") return { kind: "none", label: "Cerrada" }
  if (flow?.pending_gate) return { kind: "gate", label: GATE_LABEL[flow.pending_gate.gate] }
  if (flow?.git_plan?.state === "pending") return { kind: "plan", label: "Revisar el plan de git" }
  if (pending > 0)
    return {
      kind: "decide",
      label: pending === 1 ? "Decidir 1 permiso" : `Decidir ${pending} permisos`,
    }
  if (runs.some(isLive)) return { kind: "watch", label: "Ver la conversación" }
  if (runs.length === 0) return { kind: "work", label: "Trabajar" }
  if (task.lifecycle === "needs_review" && !flow) return { kind: "close", label: "Cerrar a mano" }
  return { kind: "work", label: flow ? "Seguir trabajando" : "Trabajar" }
}

/**
 * Por qué el cajón se abre solo: algo que pide al humano y no está en el hilo. Cada
 * motivo tiene su clave; si el humano cerró el cajón con esa clave, no se reabre.
 */
export function attentionKey(flow: TaskFlowView | null): string | null {
  if (flow?.git_plan?.state === "pending") return `plan:${flow.git_plan.plan_id}`
  return null
}

/** `git diff` de varios archivos a un diff por archivo. */
export function splitUnified(diff: string): FileDiff[] {
  const out: FileDiff[] = []
  const parts = diff.split(/^(?=diff --git )/m).filter((p) => p.startsWith("diff --git "))
  for (const part of parts) {
    const head = /^diff --git a\/(.+?) b\/(.+)$/m.exec(part)
    const path = head?.[2] ?? "?"
    out.push(fromUnified(path, part))
  }
  return out
}

// --- plan de la feature -------------------------------------------------------------

export type DagNode = PlannedTask & { item: WorkItem | null }
export type Dag = {
  phases: { phase: number; title: string; nodes: DagNode[] }[]
  /** Dependencias explícitas o de la fase anterior: de → a. */
  edges: { from: string; to: string }[]
}

/** El documento `tasks` con cada línea unida a la subtarea que nació de ella. */
export function dagOf(tasksMd: string, subtasks: WorkItem[]): Dag {
  const planned = parseTasks(tasksMd)
  const byKey = new Map(subtasks.flatMap((s) => (s.subtask ? [[s.subtask.key, s] as const] : [])))
  const nodes: DagNode[] = planned.map((p) => ({ ...p, item: byKey.get(p.key) ?? null }))
  const phases = [...new Set(nodes.map((n) => n.phase))]
    .sort((a, b) => a - b)
    .map((phase) => {
      const ns = nodes.filter((n) => n.phase === phase)
      return { phase, title: ns[0]?.phase_title ?? "", nodes: ns }
    })
  const edges = nodes.flatMap((n) => n.after.map((from) => ({ from, to: n.key })))
  return { phases, edges }
}

// --- checklist ---------------------------------------------------------------------

export type CheckLine = {
  id: string
  title: string
  scenarios: number
  done: boolean
  /** Por qué está o no está: lo que Keel comprobó. */
  why: string
}

/**
 * Un renglón por requisito `R<n>` del spec (ADR-0034 §5). En una feature, se cumple
 * cuando todas las subtareas que lo citan en `tasks` están `done`; sin subtareas,
 * cuando el QA de `review` cierra con PASS o WAIVED.
 */
export function checklistOf(
  specMd: string,
  tasksMd: string | null,
  subtasks: WorkItem[],
  qaMd: string | null,
): CheckLine[] {
  const reqs = parseSpec(specMd)
  const planned = tasksMd ? parseTasks(tasksMd) : []
  const byKey = new Map(subtasks.flatMap((s) => (s.subtask ? [[s.subtask.key, s] as const] : [])))
  const verdict = qaMd ? qaVerdict(qaMd) : null
  return reqs.map((r) => {
    const base = { id: r.id, title: r.title, scenarios: r.scenarios.length }
    const covering = planned.filter((p) => p.requirements.includes(r.id))
    if (covering.length > 0) {
      const open = covering.filter((p) => byKey.get(p.key)?.lifecycle !== "done")
      return {
        ...base,
        done: open.length === 0,
        why:
          open.length === 0
            ? `${covering.map((p) => p.key).join(", ")} integradas`
            : `falta ${open.map((p) => p.key).join(", ")}`,
      }
    }
    if (planned.length > 0) return { ...base, done: false, why: "ninguna subtarea lo cita" }
    if (verdict === "PASS" || verdict === "WAIVED")
      return { ...base, done: true, why: `QA ${verdict}` }
    return {
      ...base,
      done: false,
      why: verdict ? `QA ${verdict}` : "sin QA todavía",
    }
  })
}

// --- subtareas ----------------------------------------------------------------------

export type Lanes = {
  waiting: WorkItem[]
  working: WorkItem[]
  queued: WorkItem[]
  done: WorkItem[]
}

/**
 * Te espera (algo pide al humano o espera su revisión), trabajando (run vivo), en cola y
 * terminadas: cada subtarea en un solo carril, el más urgente que le toque.
 */
export function lanesOf(
  subtasks: WorkItem[],
  runs: Run[],
  needsYou: ReadonlySet<string> = new Set(),
): Lanes {
  const live = new Set(runs.filter(isLive).map((r) => r.work_item_id))
  const lanes: Lanes = { waiting: [], working: [], queued: [], done: [] }
  for (const s of subtasks) {
    if (s.lifecycle === "done") lanes.done.push(s)
    else if (
      needsYou.has(s.id) ||
      s.lifecycle === "needs_review" ||
      s.lifecycle === "waiting_human"
    )
      lanes.waiting.push(s)
    else if (live.has(s.id) || s.lifecycle === "running") lanes.working.push(s)
    else lanes.queued.push(s)
  }
  return lanes
}
