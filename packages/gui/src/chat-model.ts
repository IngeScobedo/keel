/**
 * El run como conversación (ADR-0020 §1): de los eventos a tarjetas por
 * intención, más lo que el panel lateral resume (archivos, tareas, notas,
 * sesión). Puro: no llama al daemon. Lo que no reconoce no aparece; la vista
 * de eventos en crudo lo sigue mostrando.
 */
import type { EventNotification } from "@keel/core"

type Loose = Record<string, unknown>

export type ToolState = "running" | "done" | "failed"

/** Un hunk de diff unificado; `lines` empiezan con " ", "+" o "-". */
export type Hunk = { oldStart: number; newStart: number; lines: string[] }

export type ToolCall = {
  kind: "tool"
  key: string
  /** `tool_use_id` de Claude o id del item de Codex. */
  id: string | null
  name: string
  input: Loose
  response: unknown
  error: string | null
  state: ToolState
  duration_ms: number | null
  /** Cuándo llegó el inicio, para el reloj de «corriendo». */
  started_at: string
  /** La aprobación que pidió esta herramienta, si la pidió. */
  approval: Approval | null
  /** Diff ya resuelto si es una edición (Claude `structuredPatch` o Codex `changes`). */
  diff: FileDiff[] | null
}

export type FileDiff = { path: string; hunks: Hunk[]; added: number; removed: number }

export type Approval = {
  kind: "approval"
  key: string
  approval_id: string
  operation_hash: string
  tool: string
  input: unknown
  expires_at: string | null
  /** null mientras espera. */
  decision: "approved" | "denied" | "expired" | null
  answers: Record<string, string> | null
  reason: string | null
}

/** Lo que hizo el método (ADR-0021): etapas, documentos, verificación y avisos de Keel. */
export type MethodItem =
  | {
      kind: "method"
      key: string
      event: "stage"
      from: string
      to: string
      ceremony: string | null
      delegated: boolean
      reason: string | null
      returned: boolean
    }
  | {
      kind: "method"
      key: string
      event: "doc"
      doc: string
      version: number
      ok: boolean
      missing: string[]
    }
  | {
      kind: "method"
      key: string
      event: "verify"
      baseline: boolean
      results: { name: string; ok: boolean; duration_ms: number; tail: string }[]
      delta: { green: boolean; newRed: string[]; stillRed: string[]; fixed: string[] }
    }
  | { kind: "method"; key: string; event: "keel" | "stalled" | "closed" | "started"; text: string }

export type ChatItem =
  | { kind: "prompt" | "human" | "agent" | "divider"; key: string; text: string }
  | MethodItem
  | { kind: "status"; key: string; text: string; tone: "info" | "error" }
  | ToolCall
  | Approval
  | {
      kind: "auto"
      key: string
      tool: string
      input: string
      effect: string
      label: string
      source: string
    }

export type Question = {
  question: string
  header: string
  multiSelect: boolean
  options: { label: string; description: string; preview?: string }[]
}

const TURN_ACTIONS: Record<string, string> = {
  raise_limit: "Sube el límite del perfil y vuelve a lanzar el run.",
  provider_login: "Inicia sesión en el proveedor desde una terminal.",
  retry: "Reintenta el run.",
}

const MODE_LABEL: Record<string, string> = {
  ask: "Preguntar",
  accept_edits: "Aceptar ediciones",
  plan: "Sólo planear",
  bypass: "Bypass",
}

export function buildChat(events: EventNotification[]): ChatItem[] {
  const items: ChatItem[] = []
  const tools = new Map<string, ToolCall>()
  const approvals = new Map<string, Approval>()
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
          // Lo que escribe Keel al cambiar de etapa no es del humano (ADR-0021).
          if (p.source === "keel") items.push({ kind: "method", key, event: "keel", text: p.text })
          else items.push({ kind: p.source === "human" ? "human" : "prompt", key, text: p.text })
        }
        break
      case "run.user_message":
        if (typeof p.text === "string") {
          said.add(p.text)
          items.push({ kind: "human", key, text: p.text })
        }
        break
      case "hook.UserPromptSubmit":
        // El proveedor ve el texto con el encabezado de Keel delante (ADR-0017 §1).
        if (
          typeof p.prompt === "string" &&
          ![...said].some((t) => (p.prompt as string).endsWith(t))
        )
          items.push({ kind: "prompt", key, text: p.prompt })
        break
      case "run.resume_skipped":
        items.push({ kind: "status", key, tone: "info", text: String(p.reason) })
        break
      case "run.mode_changed":
        items.push({
          kind: "status",
          key,
          tone: p.to === "bypass" ? "error" : "info",
          text: `Modo: ${MODE_LABEL[String(p.from)] ?? p.from} → ${MODE_LABEL[String(p.to)] ?? p.to}${p.applies === "next_turn" ? " (desde el turno siguiente)" : ""}`,
        })
        break
      case "run.model_changed": {
        const to = (p.to ?? {}) as Loose
        items.push({
          kind: "status",
          key,
          tone: "info",
          text: `Modelo: ${modelLabel(String(to.model))}${to.effort ? ` · ${EFFORT_LABEL[String(to.effort)] ?? to.effort}` : ""}`,
        })
        break
      }
      case "task.flow_started":
        items.push({ kind: "method", key, event: "started", text: String(p.stage) })
        break
      case "task.stage_changed":
        items.push({
          kind: "method",
          key,
          event: "stage",
          from: String(p.from),
          to: String(p.to),
          ceremony: typeof p.ceremony === "string" ? p.ceremony : null,
          delegated: p.delegated === true,
          reason: typeof p.reason === "string" ? p.reason : null,
          returned: p.returned === true,
        })
        break
      case "task.doc_put": {
        const report = (p.report ?? { ok: true, checks: [] }) as {
          ok: boolean
          checks: { ok: boolean; msg: string; detail?: string }[]
        }
        items.push({
          kind: "method",
          key,
          event: "doc",
          doc: String(p.kind),
          version: Number(p.version),
          ok: report.ok,
          missing: report.checks
            .filter((c) => !c.ok)
            .map((c) => `${c.msg}${c.detail ? ` (${c.detail})` : ""}`),
        })
        break
      }
      case "verify.completed":
        items.push({
          kind: "method",
          key,
          event: "verify",
          baseline: p.baseline === true,
          results: (p.results ?? []) as {
            name: string
            ok: boolean
            duration_ms: number
            tail: string
          }[],
          delta: (p.delta ?? { green: true, newRed: [], stillRed: [], fixed: [] }) as {
            green: boolean
            newRed: string[]
            stillRed: string[]
            fixed: string[]
          },
        })
        break
      case "run.keel_message":
        items.push({ kind: "method", key, event: "keel", text: String(p.text) })
        break
      case "task.flow_stalled":
        items.push({ kind: "method", key, event: "stalled", text: String(p.message) })
        break
      case "task.closed":
        items.push({ kind: "method", key, event: "closed", text: "" })
        break
      case "run.live_change_failed":
        items.push({
          kind: "status",
          key,
          tone: "error",
          text: `No se aplicó: ${String(p.message)}`,
        })
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
        const item: ToolCall = {
          kind: "tool",
          key,
          id: typeof p.tool_use_id === "string" ? p.tool_use_id : null,
          name: String(p.tool_name),
          input: (p.tool_input ?? {}) as Loose,
          response: undefined,
          error: null,
          state: "running",
          duration_ms: null,
          started_at: e.received_at,
          approval: null,
          diff: null,
        }
        if (item.id) tools.set(item.id, item)
        items.push(item)
        break
      }
      case "hook.PostToolUse":
      case "hook.PostToolUseFailure": {
        const t = typeof p.tool_use_id === "string" ? tools.get(p.tool_use_id) : undefined
        if (!t) break
        t.response = p.tool_response
        t.error = e.kind === "hook.PostToolUseFailure" ? text(p.error ?? "falló", 4000) : null
        t.state = e.kind === "hook.PostToolUseFailure" ? "failed" : "done"
        t.duration_ms = typeof p.duration_ms === "number" ? p.duration_ms : null
        t.diff = claudeDiff(t.name, t.input, p.tool_response)
        break
      }
      case "approval.requested": {
        const a: Approval = {
          kind: "approval",
          key,
          approval_id: String(p.approval_id),
          operation_hash: String(p.operation_hash),
          tool: String(p.tool),
          input: p.input,
          expires_at: typeof p.expires_at === "string" ? p.expires_at : null,
          decision: null,
          answers: null,
          reason: null,
        }
        approvals.set(a.approval_id, a)
        // Claude anuncia la herramienta antes de pedir permiso: la tarjeta es la misma.
        const owner = [...tools.values()]
          .reverse()
          .find((t) => t.state === "running" && !t.approval && sameOperation(t, a))
        if (owner) owner.approval = a
        else items.push(a)
        break
      }
      case "approval.auto":
        // Lo que permitió una regla no hace falta repetirlo: la tarjeta de la herramienta ya está.
        if (p.effect === "deny" || !String(p.source).startsWith("session:"))
          items.push({
            kind: "auto",
            key,
            tool: String(p.tool),
            input: p.input === undefined ? "" : inputLine(p.input),
            effect: String(p.effect),
            label: String(p.label),
            source: String(p.source),
          })
        break
      case "approval.resolved": {
        const a = approvals.get(String(p.approval_id))
        if (a) {
          a.decision = p.decision as Approval["decision"]
          a.answers = (p.answers as Record<string, string> | undefined) ?? null
          a.reason = typeof p.reason === "string" ? p.reason : null
        }
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
        codexItem(e, key, items, tools, (t) => {
          lastAgent = t
        })
    }
  }
  return items
}

/** Items del app-server y del SDK de Codex: mensaje, comando y cambio de archivos. */
function codexItem(
  e: EventNotification,
  key: string,
  items: ChatItem[],
  tools: Map<string, ToolCall>,
  said: (t: string) => void,
) {
  const started = e.kind === "codex.app.item/started" || e.kind === "codex.item.started"
  const completed = e.kind === "codex.app.item/completed" || e.kind === "codex.item.completed"
  if (!started && !completed) return
  const item = ((e.payload as Loose | null)?.item ?? {}) as Loose
  const type = String(item.type)
  if (completed && (type === "agentMessage" || type === "agent_message")) {
    said(String(item.text ?? ""))
    items.push({ kind: "agent", key, text: String(item.text ?? "") })
    return
  }
  const command = type === "commandExecution" || type === "command_execution"
  const files = type === "fileChange" || type === "file_change"
  if (!command && !files) return
  const id = typeof item.id === "string" ? `codex:${item.id}` : null
  let t = id ? tools.get(id) : undefined
  if (!t) {
    t = {
      kind: "tool",
      key,
      id,
      name: command ? "Bash" : "Edit",
      input: command ? { command: String(item.command ?? "") } : {},
      response: undefined,
      error: null,
      state: "running",
      duration_ms: null,
      started_at: e.received_at,
      approval: null,
      diff: null,
    }
    if (id) tools.set(id, t)
    items.push(t)
  }
  if (!completed) return
  const failed = item.status === "failed" || item.status === "declined"
  t.state = failed ? "failed" : "done"
  t.duration_ms = typeof item.durationMs === "number" ? item.durationMs : null
  if (command) {
    const out = String(item.aggregatedOutput ?? item.aggregated_output ?? "")
    t.response = { stdout: out, exit_code: item.exitCode ?? item.exit_code ?? null }
    if (failed) t.error = out || (item.status === "declined" ? "negado" : "falló")
  } else {
    const changes = (item.changes ?? []) as Loose[]
    t.input = { file_path: changes.map((c) => String(c.path)).join(", ") }
    t.diff = changes.map((c) => fromUnified(String(c.path), String(c.diff ?? "")))
    if (failed) t.error = item.status === "declined" ? "negado" : "falló"
  }
}

/** ¿La aprobación es de esta herramienta? La entrada guardada está redactada: se compara lo legible. */
function sameOperation(t: ToolCall, a: Approval): boolean {
  if (t.name !== a.tool) return false
  const i = (a.input ?? {}) as Loose
  for (const k of ["command", "file_path", "notebook_path", "url", "pattern"])
    if (typeof t.input[k] === "string" || typeof i[k] === "string") return t.input[k] === i[k]
  return true
}

const EDIT_TOOLS = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit"])

/** Diff de una edición de Claude: el `structuredPatch` de la respuesta, o lo deducido de la entrada. */
export function claudeDiff(name: string, input: Loose, response: unknown): FileDiff[] | null {
  if (!EDIT_TOOLS.has(name)) return null
  const r = (response ?? {}) as Loose
  const path = String(r.filePath ?? input.file_path ?? input.notebook_path ?? "")
  const patch = r.structuredPatch as Hunk[] | undefined
  if (Array.isArray(patch)) return [withCounts(path, patch)]
  if (typeof input.old_string === "string" && typeof input.new_string === "string")
    return [
      withCounts(path, [
        {
          oldStart: 1,
          newStart: 1,
          lines: [
            ...input.old_string.split("\n").map((l) => `-${l}`),
            ...input.new_string.split("\n").map((l) => `+${l}`),
          ],
        },
      ]),
    ]
  if (typeof input.content === "string")
    return [
      withCounts(path, [
        { oldStart: 0, newStart: 1, lines: input.content.split("\n").map((l) => `+${l}`) },
      ]),
    ]
  return null
}

function withCounts(path: string, hunks: Hunk[]): FileDiff {
  let added = 0
  let removed = 0
  for (const h of hunks)
    for (const l of h.lines) {
      if (l.startsWith("+")) added++
      else if (l.startsWith("-")) removed++
    }
  return { path, hunks, added, removed }
}

/** Un diff unificado en texto (Codex) a hunks. */
export function fromUnified(path: string, diff: string): FileDiff {
  const hunks: Hunk[] = []
  let current: Hunk | null = null
  for (const line of diff.split("\n")) {
    const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line)
    if (m) {
      current = { oldStart: Number(m[1]), newStart: Number(m[2]), lines: [] }
      hunks.push(current)
      continue
    }
    if (line.startsWith("---") || line.startsWith("+++") || line.startsWith("diff ")) continue
    if (!/^[ +-]/.test(line)) continue
    if (!current) {
      current = { oldStart: 1, newStart: 1, lines: [] }
      hunks.push(current)
    }
    current.lines.push(line)
  }
  return withCounts(path, hunks)
}

// --- lo que resume el panel lateral -------------------------------------------------

export type Todo = { content: string; status: string; activeForm?: string }

export type Ledger = {
  /** Etapa del método y sus documentos (ADR-0021), si la tarea se trabaja con él. */
  stage: { stage: string; ceremony: string | null } | null
  docs: { doc: string; version: number; ok: boolean; key: string }[]
  waiting: Approval[]
  files: { path: string; added: number; removed: number; key: string }[]
  tasks: { display_id: string; title: string; id: string; created: boolean; key: string }[]
  notes: { text: string; at: string; key: string }[]
  todos: Todo[] | null
  model: string | null
  effort: string | null
  suggestion: string | null
}

export function buildLedger(items: ChatItem[], events: EventNotification[]): Ledger {
  const files = new Map<string, Ledger["files"][number]>()
  const tasks = new Map<string, Ledger["tasks"][number]>()
  const notes: Ledger["notes"] = []
  const waiting: Approval[] = []
  let todos: Todo[] | null = null
  let stage: Ledger["stage"] = null
  const docs = new Map<string, Ledger["docs"][number]>()
  for (const it of items) {
    if (it.kind === "method" && it.event === "started") stage = { stage: it.text, ceremony: null }
    if (it.kind === "method" && it.event === "stage")
      stage = { stage: it.to, ceremony: it.ceremony }
    if (it.kind === "method" && it.event === "doc")
      docs.set(it.doc, { doc: it.doc, version: it.version, ok: it.ok, key: it.key })
    if (it.kind === "approval" && it.decision === null) waiting.push(it)
    if (it.kind !== "tool") continue
    if (it.approval && it.approval.decision === null) waiting.push(it.approval)
    for (const d of it.diff ?? []) {
      const old = files.get(d.path)
      files.set(d.path, {
        path: d.path,
        added: (old?.added ?? 0) + d.added,
        removed: (old?.removed ?? 0) + d.removed,
        key: it.key,
      })
    }
    if (it.name === "TodoWrite" && Array.isArray(it.input.todos)) todos = it.input.todos as Todo[]
    const keel = keelResult(it)
    if (keel?.item)
      tasks.set(keel.item.id, {
        ...keel.item,
        created:
          it.name === "mcp__keel__task_create" || (tasks.get(keel.item.id)?.created ?? false),
        key: it.key,
      })
    if (it.name === "mcp__keel__note_add" && it.state === "done")
      notes.push({
        text: firstLine(String(it.input.content_markdown ?? "")),
        at: it.started_at,
        key: it.key,
      })
  }
  let model: string | null = null
  let effort: string | null = null
  let suggestion: string | null = null
  for (const e of [...events].sort((a, b) => a.event_seq - b.event_seq)) {
    const p = (e.payload ?? {}) as Loose
    if (e.kind === "sdk.system" && p.subtype === "init" && typeof p.model === "string")
      model = p.model
    if (e.kind === "run.model_changed") {
      const to = (p.to ?? {}) as Loose
      model = String(to.model)
      if (to.effort) effort = String(to.effort)
    }
    if (e.kind.startsWith("hook.") && (p.effort as Loose | undefined)?.level)
      effort = String((p.effort as Loose).level)
    if (e.kind === "codex.app.thread/started") {
      const t = (p.thread ?? {}) as Loose
      if (typeof t.model === "string") model = t.model
      if (typeof t.reasoningEffort === "string") effort = t.reasoningEffort
    }
    // Una sugerencia vale hasta que el humano escribe algo.
    if (e.kind === "sdk.prompt_suggestion" && typeof p.suggestion === "string")
      suggestion = p.suggestion.trim() || null
    if (e.kind === "run.user_message" || e.kind === "run.prompt") suggestion = null
  }
  return {
    stage,
    docs: [...docs.values()],
    waiting,
    files: [...files.values()],
    tasks: [...tasks.values()],
    notes,
    todos,
    model,
    effort,
    suggestion,
  }
}

/** Lo que devolvió una tool de Keel, si trae una tarea (`task_create`, `task_current`…). */
export function keelResult(t: ToolCall): {
  item: { id: string; display_id: string; title: string; lifecycle?: string; kind?: string } | null
  raw: unknown
} | null {
  if (!t.name.startsWith("mcp__keel__") || t.state !== "done") return null
  const raw = parseMaybe(mcpText(t.response))
  const r = (raw ?? {}) as Loose
  const item = (r.item ?? (typeof r.display_id === "string" ? r : null)) as Loose | null
  return {
    item:
      item && typeof item.display_id === "string"
        ? {
            id: String(item.id),
            display_id: item.display_id,
            title: String(item.title ?? ""),
            ...(typeof item.lifecycle === "string" ? { lifecycle: item.lifecycle } : {}),
            ...(typeof item.kind === "string" ? { kind: item.kind } : {}),
          }
        : null,
    raw,
  }
}

/** La respuesta de una tool MCP llega como texto o como bloques `{type:"text"}`. */
function mcpText(response: unknown): unknown {
  if (Array.isArray(response)) {
    const t = (response as Loose[]).find((c) => c.type === "text")
    return t ? t.text : response
  }
  const r = response as Loose | null
  if (r && Array.isArray(r.content)) return mcpText(r.content)
  return response
}

function parseMaybe(v: unknown): unknown {
  if (typeof v !== "string") return v
  try {
    return JSON.parse(v)
  } catch {
    return v
  }
}

// --- texto para las tarjetas ----------------------------------------------------------

export const EFFORT_LABEL: Record<string, string> = {
  low: "bajo",
  medium: "medio",
  high: "alto",
  xhigh: "muy alto",
  max: "máx",
}

/** `claude-opus-5-5` → `Opus 5.5`; un alias o un id desconocido se deja como está. */
export function modelLabel(id: string, known: { value: string; display_name: string }[] = []) {
  const hit = known.find((m) => m.value === id)
  if (hit) return hit.display_name
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/.exec(id)
  if (m) {
    const name = (m[1] as string).charAt(0).toUpperCase() + (m[1] as string).slice(1)
    return `${name} ${m[2]}${m[3] ? `.${m[3]}` : ""}`
  }
  return id
}

export function basename(path: string): string {
  return path.split(/[\\/]/).pop() || path
}

export function firstLine(s: string): string {
  return (
    s
      .split("\n")
      .map((l) => l.replace(/^#+\s*/, "").trim())
      .find(Boolean) ?? ""
  )
}

export function text(v: unknown, max = 160): string {
  const s = typeof v === "string" ? v : JSON.stringify(v)
  return s && s.length > max ? `${s.slice(0, max)}…` : (s ?? "")
}

/** Lo legible de la entrada de una herramienta: el comando, la ruta o el patrón. */
export function inputLine(input: unknown): string {
  const i = (input ?? {}) as Loose
  for (const k of ["command", "file_path", "pattern", "url", "description", "prompt"])
    if (typeof i[k] === "string") return String(i[k])
  return text(input, 400)
}

/** Duración corta: `0,8 s`, `4,1 s`, `1 min 12 s`. */
export function duration(ms: number | null): string {
  if (ms === null) return ""
  if (ms < 1000) return `${ms} ms`
  const s = ms / 1000
  if (s < 60) return `${s.toFixed(1).replace(".", ",")} s`
  return `${Math.floor(s / 60)} min ${Math.round(s % 60)} s`
}

export function clock(fromIso: string, now: number): string {
  const s = Math.max(0, Math.floor((now - Date.parse(fromIso)) / 1000))
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`
}

/** Etiqueta de una opción sin el «(Recommended)» que añade el agente; y si lo traía. */
export function optionLabel(label: string): { text: string; recommended: boolean } {
  const m = /\s*\((recommended|recomendad[oa])\)\s*$/i.exec(label)
  return m
    ? { text: label.slice(0, m.index), recommended: true }
    : { text: label, recommended: false }
}

export function questionsOf(input: unknown): Question[] {
  const qs = ((input ?? {}) as Loose).questions
  return Array.isArray(qs) ? (qs as Question[]) : []
}

/** Las tools del método: su efecto ya se ve como evento de Keel, la tarjeta sobra. */
export const METHOD_TOOLS = new Set([
  "mcp__keel__stage_current",
  "mcp__keel__stage_advance",
  "mcp__keel__task_doc_put",
  "mcp__keel__task_doc_get",
  "mcp__keel__task_docs_list",
  "mcp__keel__verify_run",
  "mcp__keel__project_profile",
])

export const STAGE_LABEL: Record<string, string> = {
  brief: "Brief",
  design: "Diseño",
  implement: "Implementar",
  review: "Revisión",
  close: "Cierre",
}
export const DOC_LABEL: Record<string, string> = {
  brief: "Brief",
  spec: "Spec",
  design: "Diseño",
  tasks: "Tareas",
  story: "Story",
  qa: "QA",
}
