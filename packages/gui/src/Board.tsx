import {
  Bot,
  ChevronDown,
  Filter,
  Flag,
  LayoutGrid,
  List,
  ListChecks,
  Plus,
  Search,
  SquarePlus,
} from "lucide-react"
import { useState } from "react"
import { STAGE_LABEL } from "./chat-model.js"
import {
  type BoardColumn,
  COLUMNS,
  filterTasks,
  formatCost,
  moveTarget,
  type Run,
  type TaskDetails,
  type WorkItem,
} from "./model.js"
import { Select } from "./ui/index.js"
import { Button, Empty, Status } from "./ui.js"

export function TaskCard({
  item,
  details,
  runs,
  onSelect,
  onDragStart,
  waiting,
}: {
  item: WorkItem
  details?: TaskDetails
  runs: Run[]
  onSelect: () => void
  /** Lo que espera una decisión tuya: en esta tarea o en sus subtareas. */
  waiting?: { own: boolean; children: number } | undefined
  /** ADR-0006 §4: arrastrar pide la transición humana de la columna destino. */
  onDragStart?: (() => void) | undefined
}) {
  const run =
    runs.find((r) => r.work_item_id === item.id && r.status === "running") ??
    runs.find((r) => r.work_item_id === item.id)
  return (
    <button
      type="button"
      className="task-card"
      data-state={item.visual_state}
      onClick={onSelect}
      aria-label={`${item.display_id}: ${item.title}`}
      draggable={onDragStart !== undefined}
      onDragStart={(e) => {
        e.dataTransfer.setData("text/plain", item.id)
        e.dataTransfer.effectAllowed = "move"
        onDragStart?.()
      }}
    >
      <span className="card-top">
        <span className="mono card-id">
          <SquarePlus size={11} />
          {item.display_id}
        </span>
        {/* ADR-0022 §5: una feature que espera a sus hijas no está bloqueada por un problema. */}
        {item.feature && item.lifecycle === "blocked" ? (
          <Status state="queued" label="Esperando subtareas" />
        ) : (
          <Status state={item.visual_state} />
        )}
      </span>
      <span className="card-title">{item.title}</span>
      {(waiting?.own || (waiting?.children ?? 0) > 0) && (
        <span className="card-needs-you" data-testid="card-needs-you">
          <Flag size={11} />
          {waiting?.own
            ? "Espera tu decisión"
            : `${waiting?.children} subtarea${waiting?.children === 1 ? "" : "s"} espera${waiting?.children === 1 ? "" : "n"} tu decisión`}
        </span>
      )}
      {item.feature && <FeatureProgress feature={item.feature} />}
      {item.subtask && (
        <span className="card-stage mono" data-testid="card-subtask">
          {item.subtask.key} · fase {item.subtask.phase}
        </span>
      )}
      {item.stage && (
        <span className="card-stage" data-testid="card-stage">
          {STAGE_LABEL[item.stage] ?? item.stage}
          {item.ceremony ? ` · ${item.ceremony === "direct" ? "directo" : "formal"}` : ""}
        </span>
      )}
      {run?.status === "running" && (
        <span className="agent-strip">
          <Bot size={12} />
          <span>
            {details?.role ?? "agent"}
            <br />
            <span className="mono">
              {run.purpose} · {run.id.slice(-6)}
            </span>
          </span>
        </span>
      )}
      <span className="card-meta">
        <span className="avatar">{details?.assignee ?? "—"}</span>
        <ListChecks size={11} />
        <span className="mono">{details ? `${details.steps[0]}/${details.steps[1]}` : "—"}</span>
        {details && details.steps[1] > 0 && (
          <span className="tiny-progress">
            <span style={{ width: `${(details.steps[0] / details.steps[1]) * 100}%` }} />
          </span>
        )}
      </span>
      {run && <span className="card-cost mono">{formatCost(run)}</span>}
      {details?.contract && (
        <span className="contract-chip">
          ▣ {details.contract.name} v{details.contract.version} · waiting
        </span>
      )}
      <span className="tags">
        {details?.labels.map((label) => (
          <span className="tag" key={label}>
            <i data-label={label} />
            {label}
          </span>
        ))}
      </span>
    </button>
  )
}

/** ADR-0022 §5: el avance de la feature en su tarjeta; esperar a las hijas no es un problema. */
function FeatureProgress({ feature }: { feature: NonNullable<WorkItem["feature"]> }) {
  const pct = feature.total ? (feature.done / feature.total) * 100 : 0
  return (
    <span className="feature-progress" data-testid="feature-progress">
      <span className="mono">
        {feature.done}/{feature.total} subtareas
        {feature.phase !== null ? ` · fase ${feature.phase}` : ""}
      </span>
      <span className="tiny-progress">
        <span style={{ width: `${pct}%` }} />
      </span>
      <span className="muted">
        {feature.working > 0 ? `${feature.working} en curso` : ""}
        {/* Las que esperan su fase no esperan al humano: «en cola», no «esperando». */}
        {feature.blocked > 0 ? ` · ${feature.blocked} en cola` : ""}
      </span>
    </span>
  )
}

/** Las hijas plegadas bajo su feature (ADR-0022 §5). */
function SubtaskFold({
  items,
  onSelect,
  waitingYou,
}: {
  items: WorkItem[]
  onSelect: (item: WorkItem) => void
  waitingYou?: Set<string> | undefined
}) {
  // Abierto si alguna te espera: lo que te toca hacer no se esconde en un plegable.
  const anyWaiting = items.some((c) => waitingYou?.has(c.id))
  return (
    <details className="subtask-fold" data-testid="subtask-fold" open={anyWaiting}>
      <summary>{items.length} subtareas</summary>
      {items.map((c) => (
        <button type="button" key={c.id} className="subtask-row" onClick={() => onSelect(c)}>
          <Status state={c.visual_state} dot />
          <span className="mono muted">{c.subtask?.key ?? c.display_id}</span>
          <span>{c.title}</span>
          <span className={`rc-pill ${waitingYou?.has(c.id) ? "needs-you" : ""}`}>
            {waitingYou?.has(c.id)
              ? "espera tu decisión"
              : c.lifecycle === "done"
                ? "integrada"
                : c.lifecycle === "blocked"
                  ? "en cola"
                  : c.stage
                    ? (STAGE_LABEL[c.stage] ?? c.stage)
                    : c.lifecycle}
          </span>
        </button>
      ))}
    </details>
  )
}

export function ActiveRuns({
  runs,
  tasks,
  onRun,
}: {
  runs: Run[]
  tasks: WorkItem[]
  onRun: (run: Run) => void
}) {
  const active = runs.filter((run) =>
    ["running", "queued", "initializing", "paused", "waiting_human"].includes(run.status),
  )
  return (
    <aside className="active-runs">
      <header>
        Active runs <span className="mono muted">{active.length}</span>
      </header>
      {active.length === 0 ? (
        <p className="hint">No hay runs activos.</p>
      ) : (
        active.map((run) => (
          <button type="button" className="active-run" key={run.id} onClick={() => onRun(run)}>
            <span>
              <Status state={run.visual_state} dot />
              <strong className="mono">
                {tasks.find((t) => t.id === run.work_item_id)?.display_id ?? "Run"}
              </strong>
            </span>
            <code>
              {run.purpose} · {run.id.slice(-6)}
            </code>
            <small className="mono muted">{formatCost(run)}</small>
          </button>
        ))
      )}
    </aside>
  )
}

export function Board({
  tasks,
  runs,
  details,
  onSelect,
  onRun,
  onNew,
  demo,
  onTransition,
  onClose,
  waitingYou,
}: {
  tasks: WorkItem[]
  runs: Run[]
  details: Record<string, TaskDetails>
  onSelect: (item: WorkItem) => void
  onRun: (run: Run) => void
  onNew: () => void
  demo: boolean
  /** Con el daemon: pide la transición humana (`work_items.transition`). */
  onTransition?: (item: WorkItem, to: "planned") => Promise<void>
  /** ADR-0027: soltar en Done abre el cierre a mano. */
  onClose?: (item: WorkItem) => void
  /** Tareas con algo esperando una decisión tuya (aprobaciones pendientes). */
  waitingYou?: Set<string>
}) {
  const [dragging, setDragging] = useState<WorkItem | null>(null)
  const [over, setOver] = useState<BoardColumn | null>(null)
  const [moveNote, setMoveNote] = useState("")
  async function drop(column: BoardColumn) {
    const item = dragging
    setDragging(null)
    setOver(null)
    if (!item || !onTransition) return
    const t = moveTarget(item, column)
    if (!t) return
    if ("reason" in t) {
      setMoveNote(t.reason)
      return
    }
    if ("close" in t) {
      setMoveNote("")
      onClose?.(item)
      return
    }
    setMoveNote("")
    try {
      await onTransition(item, t.to)
    } catch (e) {
      setMoveNote(e instanceof Error ? e.message : String(e))
    }
  }
  const [view, setView] = useState<"board" | "list">("board")
  const [query, setQuery] = useState("")
  const [needsYou, setNeedsYou] = useState(false)
  const [repo, setRepo] = useState("all")
  // Las subtareas se pliegan bajo su feature; sueltas sólo si el padre no está.
  const ids = new Set(tasks.map((t) => t.id))
  const childrenOf = (id: string) => tasks.filter((t) => t.parent_work_item_id === id)
  const visible = filterTasks(tasks, query, needsYou, repo).filter(
    (t) => !t.parent_work_item_id || !ids.has(t.parent_work_item_id),
  )
  return (
    <div className="page board-page">
      <div className="toolbar">
        <h1>Board</h1>
        <div className="segmented">
          <Button
            icon={LayoutGrid}
            aria-pressed={view === "board"}
            onClick={() => setView("board")}
          >
            Board
          </Button>
          <Button icon={List} aria-pressed={view === "list"} onClick={() => setView("list")}>
            List
          </Button>
        </div>
        <span className="toolbar-separator" />
        <label className="select-label">
          <Filter size={13} />
          <Select
            aria-label="Filtrar repositorio"
            value={repo}
            onChange={(v) => setRepo(v)}
            disabled={!demo}
            options={[
              { value: "all", label: "All repos" },
              { value: "backend", label: "Backend" },
              { value: "frontend", label: "Frontend" },
              { value: "docs", label: "Docs" },
            ]}
          />
          <ChevronDown size={12} />
        </label>
        <Button aria-pressed={needsYou} onClick={() => setNeedsYou((v) => !v)}>
          Waiting for you
        </Button>
        <div className="toolbar-spacer" />
        <label className="search-field">
          <Search size={14} />
          <input
            aria-label="Filtrar tareas"
            placeholder="Filter tasks…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        <Button variant="primary" icon={Plus} onClick={onNew}>
          New task <kbd>C</kbd>
        </Button>
      </div>
      {moveNote && (
        <p className="move-note" role="status" data-testid="move-note">
          {moveNote}
          <button type="button" className="text-link" onClick={() => setMoveNote("")}>
            entendido
          </button>
        </p>
      )}
      <div className="board-layout">
        <section className="board-content" aria-label="Tablero de tareas">
          {visible.length === 0 ? (
            <Empty
              title={tasks.length ? "No tasks match your filters" : "Tu primera tarea empieza aquí"}
              icon={LayoutGrid}
            >
              {tasks.length ? (
                <Button
                  onClick={() => {
                    setQuery("")
                    setNeedsYou(false)
                    setRepo("all")
                  }}
                >
                  Clear filters
                </Button>
              ) : (
                <Button variant="primary" onClick={onNew}>
                  Crear tarea
                </Button>
              )}
            </Empty>
          ) : view === "board" ? (
            <div className="columns">
              {COLUMNS.map((column) => {
                const items = visible.filter(
                  (item) =>
                    item.board_status === column.id ||
                    (column.id === "backlog" && !COLUMNS.some((c) => c.id === item.board_status)),
                )
                return (
                  <section
                    className="board-column"
                    key={column.id}
                    aria-label={column.label}
                    data-drop={
                      dragging && over === column.id
                        ? (() => {
                            const t = moveTarget(dragging, column.id)
                            return t && ("to" in t || "close" in t) ? "ok" : t ? "no" : undefined
                          })()
                        : undefined
                    }
                    onDragOver={(e) => {
                      if (!dragging) return
                      e.preventDefault()
                      setOver(column.id)
                    }}
                    onDragLeave={() => setOver((o) => (o === column.id ? null : o))}
                    onDrop={(e) => {
                      e.preventDefault()
                      void drop(column.id)
                    }}
                  >
                    <header>
                      <span>
                        {column.label} <small className="mono muted">{items.length}</small>
                      </span>
                      <Button
                        variant="ghost"
                        icon={Plus}
                        aria-label={`Crear tarea desde ${column.label}`}
                        onClick={onNew}
                      />
                    </header>
                    <div className="card-list">
                      {items.map((item) => (
                        <div className="card-group" key={item.id}>
                          <TaskCard
                            item={item}
                            {...(details[item.id] ? { details: details[item.id] } : {})}
                            runs={runs}
                            onSelect={() => onSelect(item)}
                            {...(onTransition ? { onDragStart: () => setDragging(item) } : {})}
                            waiting={{
                              own: waitingYou?.has(item.id) ?? false,
                              children: childrenOf(item.id).filter((c) => waitingYou?.has(c.id))
                                .length,
                            }}
                          />
                          {item.feature && (
                            <SubtaskFold
                              items={childrenOf(item.id)}
                              onSelect={onSelect}
                              waitingYou={waitingYou}
                            />
                          )}
                        </div>
                      ))}
                      {items.length === 0 && <div className="empty-column">No tasks</div>}
                    </div>
                  </section>
                )
              })}
            </div>
          ) : (
            <div className="task-table">
              <table>
                <thead>
                  <tr>
                    <th>Task</th>
                    <th>Title</th>
                    <th>Status</th>
                    <th>Repo</th>
                    <th>Cost</th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map((item) => (
                    <tr key={item.id}>
                      <td className="mono muted">{item.display_id}</td>
                      <td>
                        <button type="button" className="text-link" onClick={() => onSelect(item)}>
                          {item.title}
                        </button>
                      </td>
                      <td>
                        <Status state={item.visual_state} />
                      </td>
                      <td>{details[item.id]?.repo ?? "No disponible"}</td>
                      <td className="mono">
                        {formatCost(runs.find((r) => r.work_item_id === item.id))}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
        <ActiveRuns tasks={tasks} runs={runs} onRun={onRun} />
      </div>
    </div>
  )
}
