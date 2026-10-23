import {
  type EventNotification,
  type Methods,
  NEEDS_YOU,
  RunViewSchema,
  WorkItemViewSchema,
} from "@keel/core"

export type WorkItem = ReturnType<typeof WorkItemViewSchema.parse>
export type Run = ReturnType<typeof RunViewSchema.parse>
export type Snapshot = ReturnType<
  (typeof Methods)["events.subscribe"]["result"]["parse"]
>["snapshot"]
export type BoardColumn = "backlog" | "todo" | "in_progress" | "in_review" | "completed"
export const COLUMNS: { id: BoardColumn; label: string }[] = [
  { id: "backlog", label: "Backlog" },
  { id: "todo", label: "Ready" },
  { id: "in_progress", label: "In Progress" },
  { id: "in_review", label: "In Review" },
  { id: "completed", label: "Done" },
]

export type TaskDetails = {
  repo: string
  assignee: string
  role: string
  labels: string[]
  spec: string
  steps: [number, number]
  contract?: { name: string; version: number; state: string }
}

export function filterTasks(items: WorkItem[], query: string, needsYou: boolean, repo: string) {
  const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean)
  return items.filter((item) => {
    const haystack = `${item.display_id} ${item.title}`.toLocaleLowerCase()
    return (
      words.every((word) => haystack.includes(word)) &&
      (!needsYou || NEEDS_YOU.includes(item.visual_state)) &&
      (repo === "all" || TASK_REPO_LABEL(item) === repo)
    )
  })
}

// El contrato actual no entrega repo_id: el filtro usa metadata de ejemplos,
// nunca infiere repositorios reales a partir de títulos.
const demoRepos = new Map<string, string>()
export function registerDemoRepo(id: string, repo: string) {
  demoRepos.set(id, repo)
}
export function TASK_REPO_LABEL(item: WorkItem) {
  return demoRepos.get(item.id) ?? "unknown"
}

export function formatCost(run?: Pick<Run, "total_cost_micro_usd" | "cost_kind">) {
  if (!run || run.cost_kind === "unknown" || run.total_cost_micro_usd === null)
    return "Costo desconocido"
  const amount = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(
    run.total_cost_micro_usd / 1_000_000,
  )
  return `${amount} ${run.cost_kind === "estimated" ? "estimado" : "observado"}`
}

function upsert<T extends { id: string; revision: number }>(items: T[], next: T): T[] {
  const old = items.find((item) => item.id === next.id)
  if (old && old.revision > next.revision) return items
  return old ? items.map((item) => (item.id === next.id ? next : item)) : [...items, next]
}

/** Revisión y project_id protegen contra replay viejo y eventos de otro proyecto. */
export function applyEvent(
  snapshot: Snapshot,
  event: EventNotification,
  projectId: string,
): Snapshot {
  if (event.project_id !== projectId) return snapshot
  const entity = event.entity ?? event.payload
  if (event.kind.startsWith("work_item.")) {
    const parsed = WorkItemViewSchema.safeParse(entity)
    if (parsed.success) return { ...snapshot, work_items: upsert(snapshot.work_items, parsed.data) }
  }
  if (event.kind.startsWith("run.")) {
    const parsed = RunViewSchema.safeParse(entity)
    if (parsed.success) return { ...snapshot, runs: upsert(snapshot.runs, parsed.data) }
  }
  return snapshot
}

/** Eventos pueden llegar antes de la respuesta de subscribe: se aplican al snapshot. */
export function mergeReplay(snapshot: Snapshot, events: EventNotification[], projectId: string) {
  return events.reduce((state, event) => applyEvent(state, event, projectId), snapshot)
}

/** Quién escribió algo, según el actor que registró el daemon (ADR-0009 §2). */
export function actorLabel(actor: string): {
  role: "human" | "agent" | "external" | "system"
  label: string
} {
  if (actor.startsWith("agent:ext:")) return { role: "external", label: "Agente externo" }
  if (actor.startsWith("agent:"))
    return { role: "agent", label: `Agente · run ${actor.slice(6, 16)}…` }
  if (actor === "system" || actor.startsWith("system")) return { role: "system", label: "Keel" }
  return { role: "human", label: "Tú" }
}

/** Eventos que cambian lo que el Inbox debe pedir de nuevo al daemon. */
export function touchesInbox(kind: string): boolean {
  return (
    kind.startsWith("approval.") ||
    kind.startsWith("session.pairing") ||
    kind === "run.requested" ||
    kind === "run.request_resolved"
  )
}

type Loose = Record<string, unknown>
const text = (v: unknown, max = 160) => {
  const s = typeof v === "string" ? v : JSON.stringify(v)
  return s && s.length > max ? `${s.slice(0, max)}…` : (s ?? "")
}

/** Resumen legible de un evento del run; `null` si es ruido (proyecciones, deltas). */
export function summarizeEvent(event: EventNotification): { title: string; detail: string } | null {
  const p = (event.payload ?? {}) as Loose
  switch (event.kind) {
    case "hook.PreToolUse":
      return { title: `Herramienta · ${String(p.tool_name)}`, detail: text(p.tool_input) }
    case "approval.requested":
      return { title: `Pide aprobación · ${String(p.tool)}`, detail: "Revisa el Inbox" }
    case "approval.resolved":
      return { title: `Aprobación ${String(p.decision)}`, detail: "" }
    case "run.updated":
      return {
        title: `Estado · ${String(p.status)}`,
        detail: p.end_reason ? String(p.end_reason) : "",
      }
    case "run.failed":
    case "run.start_failed":
    case "run.cancelled":
      return { title: event.kind, detail: text(p.message ?? p) }
    case "sdk.assistant": {
      const content = ((p.message as Loose | undefined)?.content ?? []) as Loose[]
      const said = content.filter((c) => c.type === "text").map((c) => String(c.text))
      return said.length ? { title: "El agente dice", detail: text(said.join("\n"), 600) } : null
    }
    case "sdk.result":
      return { title: "Resultado", detail: text(p.result ?? p.subtype, 1200) }
    case "note.added":
      return {
        title: `Nota · ${actorLabel(String(p.author)).label}`,
        detail: text(p.content_markdown, 300),
      }
    default:
      if (event.kind === "codex.app.item/completed" || event.kind === "codex.item.completed") {
        const item = (p.item ?? {}) as Loose
        return {
          title: `Codex · ${String(item.type)}`,
          detail: text(item.command ?? item.text ?? ""),
        }
      }
      return null
  }
}
