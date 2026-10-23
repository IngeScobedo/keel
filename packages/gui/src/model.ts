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
    kind.startsWith("permission.") ||
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
    case "run.failure":
      return { title: `Falló · ${String(p.category)}`, detail: text(p.message ?? p, 400) }
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

export type ChatItem =
  | { kind: "prompt"; key: string; text: string }
  | { kind: "agent"; key: string; text: string }
  | {
      kind: "tool"
      key: string
      name: string
      input: string
      output: string | null
      failed: boolean
    }
  | {
      kind: "approval"
      key: string
      approval_id: string
      operation_hash: string
      tool: string
      input: string
      raw_input: unknown
      expires_at: string | null
      decision: string | null
    }
  | { kind: "status"; key: string; text: string; tone: "info" | "error" }
  | { kind: "human"; key: string; text: string }
  | { kind: "divider"; key: string; text: string }
  | {
      kind: "auto"
      key: string
      tool: string
      input: string
      effect: string
      label: string
      source: string
    }

const TURN_ACTIONS: Record<string, string> = {
  raise_limit: "Sube el límite del perfil y vuelve a lanzar el run.",
  provider_login: "Inicia sesión en el proveedor desde una terminal.",
  retry: "Reintenta el run.",
}

/**
 * Convierte los eventos de un run en una conversación en orden cronológico
 * (lo más nuevo abajo), como la terminal de Claude Code. No inventa nada: lo
 * que no reconoce no aparece, y la vista en crudo lo sigue mostrando.
 */
export function buildChat(events: EventNotification[]): ChatItem[] {
  const items: ChatItem[] = []
  const tools = new Map<string, Extract<ChatItem, { kind: "tool" }>>()
  const approvals = new Map<string, Extract<ChatItem, { kind: "approval" }>>()
  let lastAgent = ""
  // Lo que escribió el humano llega dos veces: como `run.user_message` y como el
  // prompt que ve el proveedor. Se muestra una.
  const said = new Set<string>()
  let currentRun: string | null = null
  for (const e of [...events].sort((a, b) => a.event_seq - b.event_seq)) {
    const p = (e.payload ?? {}) as Loose
    const key = String(e.event_seq)
    if (e.run_id && e.run_id !== currentRun) {
      if (currentRun !== null)
        items.push({
          kind: "divider",
          key: `div:${key}`,
          text: "La conversación continúa en un run nuevo",
        })
      currentRun = e.run_id
    }
    switch (e.kind) {
      case "run.prompt":
        if (typeof p.text === "string") {
          said.add(p.text)
          items.push({
            kind: p.source === "human" ? "human" : "prompt",
            key,
            text: p.text,
          })
        }
        break
      case "run.user_message":
        if (typeof p.text === "string") {
          said.add(p.text)
          items.push({ kind: "human", key, text: p.text })
        }
        break
      case "hook.UserPromptSubmit":
        if (typeof p.prompt === "string" && !said.has(p.prompt))
          items.push({ kind: "prompt", key, text: p.prompt })
        break
      case "run.resume_skipped":
        items.push({ kind: "status", key, tone: "info", text: String(p.reason) })
        break
      case "sdk.assistant": {
        const content = ((p.message as Loose | undefined)?.content ?? []) as Loose[]
        for (const c of content)
          if (c.type === "text" && String(c.text).trim()) {
            lastAgent = String(c.text)
            items.push({ kind: "agent", key: `${key}:${items.length}`, text: lastAgent })
          }
        break
      }
      case "hook.PreToolUse": {
        const item = {
          kind: "tool" as const,
          key,
          name: String(p.tool_name),
          input: toolInput(p.tool_input),
          output: null,
          failed: false,
        }
        if (typeof p.tool_use_id === "string") tools.set(p.tool_use_id, item)
        items.push(item)
        break
      }
      case "hook.PostToolUse":
      case "hook.PostToolUseFailure": {
        const t = typeof p.tool_use_id === "string" ? tools.get(p.tool_use_id) : undefined
        if (t) {
          t.output = toolOutput(p.tool_response ?? p.error ?? "")
          t.failed = e.kind === "hook.PostToolUseFailure"
        }
        break
      }
      case "approval.requested": {
        const a = {
          kind: "approval" as const,
          key,
          approval_id: String(p.approval_id),
          operation_hash: String(p.operation_hash),
          tool: String(p.tool),
          input: p.input === undefined ? "" : toolInput(p.input),
          raw_input: p.input,
          expires_at: typeof p.expires_at === "string" ? p.expires_at : null,
          decision: null as string | null,
        }
        approvals.set(a.approval_id, a)
        items.push(a)
        break
      }
      case "approval.auto":
        items.push({
          kind: "auto",
          key,
          tool: String(p.tool),
          input: p.input === undefined ? "" : toolInput(p.input),
          effect: String(p.effect),
          label: String(p.label),
          source: String(p.source),
        })
        break
      case "approval.resolved": {
        const a = approvals.get(String(p.approval_id))
        if (a) a.decision = String(p.decision)
        break
      }
      case "sdk.result":
        if (typeof p.result === "string" && p.result.trim() && p.result !== lastAgent)
          items.push({ kind: "agent", key, text: p.result })
        break
      case "run.failure": {
        const why = String(p.message ?? p.category ?? "error")
        const action = TURN_ACTIONS[String(p.user_action)] ?? ""
        items.push({
          kind: "status",
          key,
          tone: "error",
          text: `Falló (${String(p.category ?? p.end_reason)}): ${why}${action ? `. ${action}` : ""}`,
        })
        break
      }
      case "run.start_failed":
      case "run.failed":
        items.push({ kind: "status", key, tone: "error", text: text(p.message ?? p, 600) })
        break
      case "run.cancelled":
        items.push({ kind: "status", key, tone: "info", text: "Run cancelado." })
        break
      case "run.updated":
        if (p.status === "completed")
          items.push({ kind: "status", key, tone: "info", text: "Run terminado." })
        break
      default:
        if (e.kind === "codex.app.item/completed" || e.kind === "codex.item.completed") {
          const item = (p.item ?? {}) as Loose
          if (item.type === "agentMessage" || item.type === "agent_message") {
            lastAgent = String(item.text ?? "")
            items.push({ kind: "agent", key, text: lastAgent })
          } else if (item.type === "commandExecution" || item.type === "command_execution")
            items.push({
              kind: "tool",
              key,
              name: "Bash",
              input: String(item.command ?? ""),
              output: text(item.aggregatedOutput ?? item.aggregated_output ?? "", 4000),
              failed: item.status === "failed" || item.status === "declined",
            })
          else if (item.type === "fileChange" || item.type === "file_change")
            items.push({
              kind: "tool",
              key,
              name: "Edit",
              input: text(
                ((item.changes ?? []) as Loose[]).map((c) => c.path).join(", ") || item,
                400,
              ),
              output: null,
              failed: item.status === "failed" || item.status === "declined",
            })
        }
    }
  }
  return items
}

/** La salida de `Bash` viene como `{stdout, stderr}`; el resto, tal cual. */
function toolOutput(response: unknown): string {
  const r = response as Loose
  if (r && typeof r === "object" && typeof r.stdout === "string")
    return text([r.stdout, r.stderr].filter(Boolean).join("\n"), 4000)
  return text(response, 4000)
}

/** Lo legible de la entrada de una herramienta: el comando, la ruta o el patrón. */
function toolInput(input: unknown): string {
  const i = (input ?? {}) as Loose
  for (const k of ["command", "file_path", "pattern", "url", "description", "prompt"])
    if (typeof i[k] === "string") return String(i[k])
  return text(input, 400)
}
