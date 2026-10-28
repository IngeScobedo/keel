import { shellCommand } from "@keel/core"
import {
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  FilePlus2,
  FileSearch,
  ListChecks,
  NotebookPen,
  Play,
  Search,
  SquarePlus,
  Telescope,
  X,
} from "lucide-react"
import { type ReactNode, useEffect, useState } from "react"
import { TableWithChart, tableFromOutput } from "./Chart.js"
import {
  basename,
  clock,
  duration,
  type FileDiff,
  firstLine,
  keelResult,
  type Todo,
  type ToolCall,
  text,
} from "./chat-model.js"
import { mutationMeta } from "./client.js"
import { InfraCard } from "./InfraCard.js"
import type { useWorkspace } from "./useWorkspace.js"

type Call = ReturnType<typeof useWorkspace>["call"]
export type Density = "story" | "balanced" | "raw"
type Loose = Record<string, unknown>

/** Lo que busca o lee: se agrupa en «Exploró el código» (ADR-0020 §1). */
export const EXPLORE_TOOLS = new Set(["Read", "Grep", "Glob", "LS", "WebFetch", "WebSearch"])
const KEEL_READS = new Set([
  "mcp__keel__task_current",
  "mcp__keel__task_get",
  "mcp__keel__tasks_list",
  "mcp__keel__context_search",
  "mcp__keel__context_project",
])

export function isExplore(t: ToolCall): boolean {
  return EXPLORE_TOOLS.has(t.name) || KEEL_READS.has(t.name)
}

/** Acción de dominio de Keel o de la checklist del agente: entra con destello. */
export function isKeelAction(t: ToolCall): boolean {
  return (t.name.startsWith("mcp__keel__") && !KEEL_READS.has(t.name)) || t.name === "TodoWrite"
}

/** Una tarjeta por intención; cerrada con su resumen y el detalle a un clic. */
export function ToolCard({
  t,
  density,
  call,
  onOpenTask,
  fresh,
}: {
  t: ToolCall
  density: Density
  call?: Call
  onOpenTask?: (id: string) => void
  /** Llegó con el run en vivo: anima la entrada. */
  fresh?: boolean
}) {
  // ADR-0031 §5: lo que abrió una ejecución de infraestructura se ve como su tarjeta.
  if (t.infra) return <InfraCard r={t.infra} {...(call ? { call } : {})} />
  if (isKeelAction(t))
    return (
      <KeelCard t={t} fresh={fresh ?? false} onOpenTask={onOpenTask} {...(call ? { call } : {})} />
    )
  const lines = (t.diff ?? []).reduce((n, d) => n + d.added + d.removed, 0)
  const startOpen =
    density === "raw" ||
    t.state === "failed" ||
    (t.diff !== null && lines > 0 && lines <= 24 && density === "balanced")
  return <Card t={t} startOpen={startOpen} {...(call ? { call } : {})} />
}

function Card({ t, startOpen, call }: { t: ToolCall; startOpen: boolean; call?: Call }) {
  const [open, setOpen] = useState(startOpen)
  useEffect(() => setOpen(startOpen), [startOpen])
  const head = cardHead(t)
  return (
    <div className="rc-card" data-state={t.state} data-testid="chat-tool" data-tool={t.name}>
      <button
        type="button"
        className="rc-card-head"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className={`rc-tag ${head.tone}`}>{head.tag}</span>
        <span className="rc-card-title">{head.title}</span>
        {head.sub && <span className="rc-card-sub mono">{head.sub}</span>}
        <span className="rc-card-meta mono">
          <Meta t={t} />
        </span>
        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
      </button>
      {!open && head.summary && (
        <p className={`rc-card-summary ${t.state === "failed" ? "error" : ""}`}>
          {t.state === "done" ? <Check size={12} /> : t.state === "failed" ? <X size={12} /> : null}
          {head.summary}
        </p>
      )}
      {open && <CardBody t={t} {...(call ? { call } : {})} />}
    </div>
  )
}

/** Tiempo vivo mientras corre; al terminar, salida y duración. */
function Meta({ t }: { t: ToolCall }) {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    if (t.state !== "running") return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [t.state])
  if (t.approval && t.approval.decision === null) return <>esperando permiso</>
  if (t.state === "running") return <span className="rc-live">{clock(t.started_at, now)}</span>
  const parts: ReactNode[] = []
  // Lo que decidiste sigue a la vista en la tarjeta.
  if (t.approval?.decision)
    parts.push(
      t.approval.decision === "approved"
        ? "aprobado · "
        : t.approval.decision === "expired"
          ? "venció · "
          : "negado · ",
    )
  if (t.diff)
    for (const d of t.diff)
      parts.push(
        <span key={d.path}>
          <span className="added">+{d.added}</span> <span className="removed">
            −{d.removed}
          </span>{" "}
        </span>,
      )
  const exit = (t.response as Loose | undefined)?.exit_code
  if (typeof exit === "number") parts.push(`exit ${exit} · `)
  else if (t.name === "Bash" && t.state === "failed") parts.push(`${exitOf(t.error)} · `)
  parts.push(duration(t.duration_ms))
  return <>{parts}</>
}

function exitOf(error: string | null): string {
  const m = /exit code (\d+)/i.exec(error ?? "")
  return m ? `exit ${m[1]}` : "falló"
}

type Head = { tag: string; tone: string; title: string; sub?: string; summary?: string }

function cardHead(t: ToolCall): Head {
  const i = t.input
  const r = (t.response ?? {}) as Loose
  switch (t.name) {
    case "Bash": {
      const out = String(r.stdout ?? "")
      const cmd = shellCommand(i) ?? ""
      return {
        tag: "BASH",
        tone: "bash",
        title: String(i.description ?? "") || cmd,
        ...(i.description ? { sub: text(cmd, 80) } : {}),
        summary:
          t.state === "failed"
            ? lastLines(t.error ?? "", 1)
            : t.state === "done"
              ? lastLines(out, 1) || "sin salida"
              : "",
      }
    }
    case "Read": {
      const file = (r.file ?? {}) as Loose
      const start = Number(file.startLine ?? i.offset ?? 1)
      const n = Number(file.numLines ?? 0)
      const size = typeof file.content === "string" ? kb(file.content.length) : ""
      return {
        tag: "READ",
        tone: "read",
        title: basename(String(i.file_path ?? "")),
        sub: n ? `L${start}–${start + n - 1}${size ? ` · ${size}` : ""}` : "",
      }
    }
    case "Grep":
    case "Glob": {
      const count =
        r.numMatches ?? r.numFiles ?? (Array.isArray(r.filenames) ? r.filenames.length : null)
      const where = i.path ? ` en ${basename(String(i.path))}` : ""
      return {
        tag: t.name === "Grep" ? "GREP" : "GLOB",
        tone: "read",
        title: `${t.name === "Grep" ? "Buscó" : "Archivos"} «${String(i.pattern ?? "")}»${where}`,
        ...(count !== null && count !== undefined
          ? { sub: `${count} ${r.numMatches !== undefined ? "coincidencias" : "archivos"}` }
          : {}),
      }
    }
    case "Edit":
    case "MultiEdit":
    case "Write":
    case "NotebookEdit": {
      const paths = (t.diff ?? []).map((d) => d.path)
      const path = paths.join(", ") || String(i.file_path ?? i.notebook_path ?? "")
      return {
        tag: t.name === "Write" ? "WRITE" : "EDIT",
        tone: "edit",
        title: shortPath(path),
        ...(t.state === "failed" ? { summary: lastLines(t.error ?? "", 1) } : {}),
      }
    }
    case "Task":
    case "Agent":
      return {
        tag: "AGENTE",
        tone: "agent",
        title: `${String(i.subagent_type ?? "agente")} · ${String(i.description ?? "")}`,
        ...(t.state === "done" ? { summary: firstLine(responseText(t.response)) } : {}),
      }
    case "WebFetch":
    case "WebSearch":
      return {
        tag: t.name === "WebFetch" ? "WEB" : "BUSCA",
        tone: "read",
        title: String(i.url ?? i.query ?? ""),
      }
    default: {
      const mcp = /^mcp__([^_]+(?:_[^_]+)*)__(.+)$/.exec(t.name)
      if (mcp)
        return {
          tag: "MCP",
          tone: "mcp",
          title: `${mcp[1]} · ${mcp[2]}`,
          ...(t.state === "failed" ? { summary: lastLines(t.error ?? "", 1) } : {}),
        }
      return { tag: t.name.toUpperCase().slice(0, 10), tone: "mcp", title: text(t.input, 80) }
    }
  }
}

function CardBody({ t, call }: { t: ToolCall; call?: Call }) {
  if (t.diff?.length)
    return (
      <div className="rc-card-body">
        {t.diff.map((d) => (
          <DiffView key={d.path} diff={d} />
        ))}
        {t.error && <pre className="rc-error">{t.error}</pre>}
      </div>
    )
  if (t.name === "Bash") {
    const r = (t.response ?? {}) as Loose
    const out = [r.stdout, r.stderr].filter((x) => typeof x === "string" && x).join("\n")
    return (
      <div className="rc-card-body">
        <pre className="rc-term">
          <span className="rc-prompt">$ </span>
          {shellCommand(t.input) ?? ""}
          {"\n"}
          {t.state === "failed" ? tail(t.error ?? out, 40) : out ? tail(out, 200) : ""}
        </pre>
      </div>
    )
  }
  if (t.name === "Read") {
    const file = ((t.response as Loose | undefined)?.file ?? {}) as Loose
    const start = Number(file.startLine ?? 1)
    const content = typeof file.content === "string" ? file.content : null
    return (
      <div className="rc-card-body">
        <p className="rc-path mono">{String(t.input.file_path ?? "")}</p>
        {content !== null && (
          <pre className="rc-code">
            {content
              .split("\n")
              .slice(0, 400)
              .map((l, n) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: líneas de un archivo estático
                <span key={n} className="rc-line">
                  <span className="rc-ln">{start + n}</span>
                  {l}
                  {"\n"}
                </span>
              ))}
          </pre>
        )}
      </div>
    )
  }
  const raw = t.response
  const table = raw === undefined ? null : tableFromOutput(raw)
  return (
    <div className="rc-card-body">
      <h4>Entrada</h4>
      <pre>{JSON.stringify(t.input, null, 2)}</pre>
      {t.error && <pre className="rc-error">{t.error}</pre>}
      {raw !== undefined &&
        (table ? (
          <TableWithChart table={table} {...(call ? { call } : {})} />
        ) : (
          <>
            <h4>Salida</h4>
            <pre>{typeof raw === "string" ? raw : JSON.stringify(raw, null, 2)}</pre>
          </>
        ))}
    </div>
  )
}

/** Diff unificado con números de línea y el contexto que trae el hunk. */
export function DiffView({ diff }: { diff: FileDiff }) {
  return (
    <div className="rc-diff" data-testid="diff">
      {diff.hunks.map((h) => {
        let oldN = h.oldStart
        let newN = h.newStart
        return (
          <div key={`${h.oldStart}:${h.newStart}`} className="rc-hunk">
            <div className="rc-hunk-head mono">
              @@ −{h.oldStart} +{h.newStart} @@ <span>{shortPath(diff.path)}</span>
            </div>
            {h.lines.map((l, n) => {
              const sign = l[0] ?? " "
              // El contexto avanza las dos numeraciones; se muestra la nueva.
              const ln = sign === "-" ? oldN : newN
              if (sign !== "+") oldN++
              if (sign !== "-") newN++
              const cls = sign === "+" ? "add" : sign === "-" ? "del" : "ctx"
              return (
                // biome-ignore lint/suspicious/noArrayIndexKey: el orden del hunk es fijo
                <div key={n} className={`rc-dl ${cls}`}>
                  <span className="rc-ln">{ln}</span>
                  <span className="rc-sign">{sign === " " ? "" : sign}</span>
                  <span className="rc-src">{l.slice(1)}</span>
                </div>
              )
            })}
          </div>
        )
      })}
    </div>
  )
}

/** Varias lecturas y búsquedas seguidas, en una línea (ADR-0020 §1). */
export function ExploreGroup({
  tools,
  density,
  call,
}: {
  tools: ToolCall[]
  density: Density
  call?: Call
}) {
  const [open, setOpen] = useState(density === "raw")
  useEffect(() => setOpen(density === "raw"), [density])
  const reads = tools.filter((t) => t.name === "Read" || KEEL_READS.has(t.name)).length
  const searches = tools.length - reads
  const ms = tools.reduce((s, t) => s + (t.duration_ms ?? 0), 0)
  const files = [
    ...new Set(
      tools
        .filter((t) => t.name === "Read" && typeof t.input.file_path === "string")
        .map((t) => basename(String(t.input.file_path))),
    ),
  ]
  const running = tools.some((t) => t.state === "running")
  return (
    <div className="rc-group" data-testid="chat-explore">
      <button
        type="button"
        className="rc-group-head"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <Telescope size={14} />
        <strong>{running ? "Explorando el código" : "Exploró el código"}</strong>
        <span className="muted">
          {[
            reads ? `${reads} ${reads === 1 ? "lectura" : "lecturas"}` : "",
            searches ? `${searches} ${searches === 1 ? "búsqueda" : "búsquedas"}` : "",
            ms ? duration(ms) : "",
          ]
            .filter(Boolean)
            .join(" · ")}
        </span>
        <span className="rc-chips">
          {files.slice(0, 3).map((f) => (
            <code key={f}>{f}</code>
          ))}
          {files.length > 3 && <code>+{files.length - 3}</code>}
        </span>
        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
      </button>
      {open && (
        <div className="rc-group-body">
          {tools.map((t) => (
            <ToolCard key={t.key} t={t} density={density} {...(call ? { call } : {})} />
          ))}
        </div>
      )}
    </div>
  )
}

/**
 * Lo que el agente hizo en Keel o en su checklist (ADR-0020 §1): resalta al
 * llegar, sin robar el foco ni mover la vista, y abre la entidad sin salir.
 */
function KeelCard({
  t,
  fresh,
  onOpenTask,
  call,
}: {
  t: ToolCall
  fresh: boolean
  onOpenTask?: ((id: string) => void) | undefined
  call?: Call
}) {
  const res = keelResult(t)
  const item = res?.item
  // ADR-0024 §2: «Trabajar» empieza el método de la tarea que nació aquí.
  const [work, setWork] = useState<"idle" | "busy" | "started" | string>("idle")
  async function startWork(id: string) {
    if (!call) return
    setWork("busy")
    try {
      await call("tasks.work", { ...mutationMeta(), work_item_id: id })
      setWork("started")
    } catch (e) {
      setWork(e instanceof Error ? e.message : String(e))
    }
  }
  let icon = <SquarePlus size={15} />
  let action = t.name.replace(/^mcp__keel__/, "").replaceAll("_", " ")
  let body: ReactNode = null
  if (t.name === "TodoWrite") {
    const todos = (Array.isArray(t.input.todos) ? t.input.todos : []) as Todo[]
    const done = todos.filter((x) => x.status === "completed").length
    const doing = todos.find((x) => x.status === "in_progress")
    icon = <ListChecks size={15} />
    action = "Actualizó su checklist"
    body = (
      <div className="rc-keel-row">
        <span>{doing ? (doing.activeForm ?? doing.content) : (todos.at(-1)?.content ?? "")}</span>
        <span className="rc-progress mono" title={`${done} de ${todos.length}`}>
          {done} / {todos.length}
          <progress value={done} max={Math.max(1, todos.length)} />
        </span>
      </div>
    )
  } else if (t.name === "mcp__keel__task_create") {
    action = "Creó una tarea"
    body = item ? (
      <div className="rc-keel-row">
        <span>
          <span className="mono muted">{item.display_id}</span> <strong>{item.title}</strong>{" "}
          {typeof t.input.priority === "string" && t.input.priority !== "medium" && (
            <span className={`rc-pill priority-${t.input.priority}`}>{t.input.priority}</span>
          )}
          {item.kind && <span className="rc-pill">{item.kind}</span>}
        </span>
        {call && work !== "started" && (
          <button
            type="button"
            className="button primary"
            disabled={work === "busy"}
            onClick={() => void startWork(item.id)}
          >
            <Play size={13} /> Trabajar
          </button>
        )}
        {work === "started" && <span className="rc-pill">trabajando</span>}
        {onOpenTask && (
          <button type="button" className="button" onClick={() => onOpenTask(item.id)}>
            <FileSearch size={13} /> Abrir al lado
          </button>
        )}
        {work !== "idle" && work !== "busy" && work !== "started" && (
          <span className="error">{work}</span>
        )}
      </div>
    ) : (
      <span>{String(t.input.title ?? "")}</span>
    )
  } else if (t.name === "mcp__keel__note_add") {
    icon = <NotebookPen size={15} />
    action = "Agregó una nota a la tarea"
    body = <span>{firstLine(String(t.input.content_markdown ?? ""))}</span>
  } else if (t.name.startsWith("mcp__keel__git_")) {
    icon = <FilePlus2 size={15} />
    action =
      t.name === "mcp__keel__git_propose" ? "Propuso cambios de git" : `git · ${action.slice(4)}`
  }
  return (
    <div
      className={`rc-keel ${fresh ? "fresh" : ""}`}
      data-state={t.state}
      data-testid="chat-keel"
      data-tool={t.name}
    >
      <span className="rc-keel-icon">
        {t.name === "TodoWrite" ? icon : t.state === "failed" ? <X size={15} /> : icon}
      </span>
      <div className="rc-keel-main">
        <span className="rc-keel-action">
          {action}
          {t.state === "running" && <span className="muted"> · …</span>}
        </span>
        {body}
        {t.state === "failed" && <span className="error">{lastLines(t.error ?? "", 1)}</span>}
      </div>
      <span className="rc-card-meta mono">{t.name.startsWith("mcp__") ? t.name : ""}</span>
    </div>
  )
}

/** Densidad «Historia»: una línea por grupo de acciones (ADR-0020 §1). */
export function StoryLine({ tools }: { tools: ToolCall[] }) {
  const explored = new Set(
    tools.filter(isExplore).map((t) => String(t.input.file_path ?? t.input.pattern ?? t.key)),
  ).size
  const edits = tools.filter((t) => t.diff)
  const added = edits.reduce((s, t) => s + (t.diff ?? []).reduce((a, d) => a + d.added, 0), 0)
  const removed = edits.reduce((s, t) => s + (t.diff ?? []).reduce((a, d) => a + d.removed, 0), 0)
  const commands = tools.filter((t) => t.name === "Bash")
  const failed = commands.filter((t) => t.state === "failed").length
  const todos = [...tools].reverse().find((t) => t.name === "TodoWrite")
  const list = (todos?.input.todos ?? []) as Todo[]
  const keel = tools.filter((t) => t.name.startsWith("mcp__keel__") && !KEEL_READS.has(t.name))
  const agents = tools.filter((t) => t.name === "Task" || t.name === "Agent").length
  return (
    <p className="rc-story" data-testid="chat-story">
      {explored > 0 && (
        <span>
          <Search size={12} /> exploró {explored}
        </span>
      )}
      {edits.length > 0 && (
        <span>
          <FilePlus2 size={12} /> editó{" "}
          {new Set(edits.flatMap((t) => (t.diff ?? []).map((d) => d.path))).size} ·{" "}
          <span className="added">+{added}</span> <span className="removed">−{removed}</span>
        </span>
      )}
      {commands.length > 0 && (
        <span className={failed ? "error" : ""}>
          {failed ? <X size={12} /> : <Check size={12} />} {commands.length}{" "}
          {commands.length === 1 ? "comando" : "comandos"}
          {failed ? ` · ${failed} falló` : ""}
        </span>
      )}
      {agents > 0 && (
        <span>
          <Bot size={12} /> {agents} {agents === 1 ? "subagente" : "subagentes"}
        </span>
      )}
      {todos && (
        <span className="accent">
          <ListChecks size={12} /> checklist {list.filter((x) => x.status === "completed").length}/
          {list.length}
        </span>
      )}
      {keel.map((t) => (
        <span key={t.key} className="accent">
          <SquarePlus size={12} /> {keelLabel(t)}
        </span>
      ))}
    </p>
  )
}

/** Cómo se nombra una acción de Keel en una línea: la tarea, la nota, git. */
function keelLabel(t: ToolCall): string {
  const id = keelResult(t)?.item?.display_id
  if (id) return id
  if (t.name === "mcp__keel__note_add") return "nota"
  if (t.name.startsWith("mcp__keel__git_")) return "git"
  return t.name.replace("mcp__keel__", "").replaceAll("_", " ")
}

function responseText(r: unknown): string {
  if (typeof r === "string") return r
  const o = (r ?? {}) as Loose
  if (Array.isArray(o.content))
    return (o.content as Loose[])
      .filter((c) => c.type === "text")
      .map((c) => String(c.text))
      .join("\n")
  return ""
}

function lastLines(s: string, n: number): string {
  return s
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(-n)
    .join(" · ")
}

function tail(s: string, n: number): string {
  const lines = s.split("\n")
  return lines.length > n ? `… ${lines.length - n} líneas antes\n${lines.slice(-n).join("\n")}` : s
}

function kb(chars: number): string {
  return chars < 1024 ? `${chars} B` : `${(chars / 1024).toFixed(1).replace(".", ",")} KB`
}

/** Las dos últimas partes de la ruta: suficiente para reconocer el archivo. */
export function shortPath(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean)
  return parts.length > 3 ? `…/${parts.slice(-3).join("/")}` : path
}
