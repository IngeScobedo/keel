import {
  Bot,
  ChevronDown,
  Filter,
  LayoutGrid,
  List,
  ListChecks,
  Plus,
  Search,
  SquarePlus,
} from "lucide-react"
import { useState } from "react"
import {
  COLUMNS,
  filterTasks,
  formatCost,
  type Run,
  type TaskDetails,
  type WorkItem,
} from "./model.js"
import { Button, Empty, Status } from "./ui.js"

export function TaskCard({
  item,
  details,
  runs,
  onSelect,
}: {
  item: WorkItem
  details?: TaskDetails
  runs: Run[]
  onSelect: () => void
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
    >
      <span className="card-top">
        <span className="mono card-id">
          <SquarePlus size={11} />
          {item.display_id}
        </span>
        <Status state={item.visual_state} />
      </span>
      <span className="card-title">{item.title}</span>
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
}: {
  tasks: WorkItem[]
  runs: Run[]
  details: Record<string, TaskDetails>
  onSelect: (item: WorkItem) => void
  onRun: (run: Run) => void
  onNew: () => void
  demo: boolean
}) {
  const [view, setView] = useState<"board" | "list">("board")
  const [query, setQuery] = useState("")
  const [needsYou, setNeedsYou] = useState(false)
  const [repo, setRepo] = useState("all")
  const visible = filterTasks(tasks, query, needsYou, repo)
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
          <select
            aria-label="Filtrar repositorio"
            value={repo}
            onChange={(e) => setRepo(e.target.value)}
            disabled={!demo}
          >
            <option value="all">All repos</option>
            <option value="backend">Backend</option>
            <option value="frontend">Frontend</option>
            <option value="docs">Docs</option>
          </select>
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
                  <section className="board-column" key={column.id} aria-label={column.label}>
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
                        <TaskCard
                          key={item.id}
                          item={item}
                          {...(details[item.id] ? { details: details[item.id] } : {})}
                          runs={runs}
                          onSelect={() => onSelect(item)}
                        />
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
