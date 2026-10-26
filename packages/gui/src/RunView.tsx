import type { EventNotification, VisualState } from "@keel/core"
import { ArrowLeft, Bot, ChevronDown, ChevronRight, GitBranch, Search } from "lucide-react"
import { useEffect, useState } from "react"
import { MODES } from "./Composer.js"
import { clock } from "./chat-model.js"
import { mutationMeta } from "./client.js"
import { demoTools } from "./fixtures.js"
import { formatCost, type Run, type WorkItem } from "./model.js"
import { Operations } from "./Operations.js"
import { RunChat } from "./RunChat.js"
import type { Density } from "./ToolCards.js"
import { Button, Empty, Hint, Status, Tabs } from "./ui.js"
import type { useWorkspace } from "./useWorkspace.js"

const TERMINAL = new Set(["completed", "failed", "cancelled", "interrupted"])
const ISOLATION_LABEL = {
  sandbox: "aislado",
  provider: "sandbox del proveedor",
  os_user: "usuario propio",
  none: "sin aislar",
} as const
const ISOLATION_HINT = {
  sandbox:
    "Bubblewrap de Keel: sólo escribe en su worktree y no ve la puerta humana (ADR-0018 §3).",
  provider:
    "El sandbox propio del proveedor; que oculte la puerta humana no está verificado. La frontera es el gate.",
  os_user: "Corre con un usuario del sistema propio (ADR-0018 §4).",
  none: "Sin aislamiento: su shell puede hacer lo que tú. La frontera es el gate de aprobaciones.",
} as const

export function RunsList({
  runs,
  tasks,
  onRun,
}: {
  runs: Run[]
  tasks: WorkItem[]
  onRun: (run: Run) => void
}) {
  return (
    <div className="page">
      <div className="toolbar">
        <h1>Runs</h1>
        <span className="muted mono">{runs.length} executions</span>
      </div>
      <div className="padded">
        <table>
          <thead>
            <tr>
              <th>Run</th>
              <th>Task</th>
              <th>Purpose</th>
              <th>Status</th>
              <th>Cost</th>
            </tr>
          </thead>
          <tbody>
            {runs.map((run) => (
              <tr key={run.id}>
                <td>
                  <button type="button" className="text-link mono" onClick={() => onRun(run)}>
                    {run.id}
                  </button>
                </td>
                <td>
                  {tasks.find((task) => task.id === run.work_item_id)?.display_id ??
                    run.work_item_id}
                </td>
                <td>{run.purpose}</td>
                <td>
                  <Status state={run.visual_state} />
                </td>
                <td className="mono">{formatCost(run)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {runs.length === 0 && (
          <Empty title="No runs yet">
            Las ejecuciones aparecerán aquí al iniciarlas desde el daemon.
          </Empty>
        )}
      </div>
    </div>
  )
}
const runTabs = ["Agents", "Timeline", "Operaciones", "Cost"] as const

type RunViewProps = {
  run: Run
  task?: WorkItem
  demo: boolean
  events: EventNotification[]
  onBack: () => void
  onTask: () => void
  call?: ReturnType<typeof useWorkspace>["call"]
  /** Para mostrar la cadena de runs de una conversación (ADR-0019 §3). */
  runs?: Run[]
  onRun?: (run: Run) => void
  /** Abrir otra tarea (la que creó el agente) desde el chat. */
  onOpenTask?: (id: string) => void
}

/** Con daemon, el run es un chat de foco (ADR-0020); sin él, la vista de ejemplo. */
export function RunView(props: RunViewProps) {
  return props.demo ? <DemoRunView {...props} /> : <LiveRunView {...props} />
}

const liveTabs = ["Chat", "Operaciones", "Costo", "Eventos"] as const
const DENSITIES: { id: Density; label: string }[] = [
  { id: "story", label: "Historia" },
  { id: "balanced", label: "Equilibrada" },
  { id: "raw", label: "Cruda" },
]
const DENSITY_KEY = "keel-density"
function initialDensity(): Density {
  try {
    const v = localStorage.getItem(DENSITY_KEY)
    return v === "story" || v === "raw" ? v : "balanced"
  } catch {
    return "balanced"
  }
}

function LiveRunView({
  run,
  task,
  events,
  onBack,
  onTask,
  call,
  runs,
  onRun,
  onOpenTask,
}: RunViewProps) {
  const [tab, setTab] = useState<(typeof liveTabs)[number]>("Chat")
  const [density, setDensity] = useState<Density>(initialDensity)
  const [stopError, setStopError] = useState("")
  const [query, setQuery] = useState("")
  const runEvents = events.filter((event) => event.run_id === run.id)
  // La conversación es la cadena de runs: los padres primero, este al final.
  const chain = new Set<string>([run.id])
  for (let r: Run | undefined = run; r?.parent_run_id; ) {
    chain.add(r.parent_run_id)
    const parentId: string = r.parent_run_id
    r = runs?.find((x) => x.id === parentId)
  }
  const chainEvents = events.filter((e) => e.run_id !== null && chain.has(e.run_id))
  const where = workspaceOf(run, runEvents)
  const running = !TERMINAL.has(run.status)
  // ADR-0021: Keel sigue la conversación en otro run al cambiar de etapa; la vista lo sigue.
  const child = runs?.find((r) => r.parent_run_id === run.id)
  useEffect(() => {
    if (child && onRun) onRun(child)
  }, [child, onRun])
  const mode = run.options?.permission_mode ?? "ask"
  const started = runEvents.find((e) => e.kind === "run.created")?.received_at ?? null
  return (
    <div className="page run-page run-focus">
      <header className="rc-head">
        <Button variant="ghost" icon={ArrowLeft} onClick={onBack} aria-label="Runs" />
        <button type="button" className="text-link mono" onClick={onTask}>
          {task?.display_id ?? "Task"}
        </button>
        <h1 title={task?.title}>{task?.title ?? run.work_item_id}</h1>
        <span className="mono muted rc-runid" data-testid="run-id" title="Run">
          {run.id}
        </span>
        <span className="rc-branch mono" title={where.base ? `base ${where.base}` : undefined}>
          <GitBranch size={12} />
          {where.branch ?? where.label}
        </span>
        {run.isolation && (
          <span
            className={`mode-badge isolation-${run.isolation}`}
            data-testid="isolation"
            title={ISOLATION_HINT[run.isolation]}
          >
            {ISOLATION_LABEL[run.isolation]}
          </span>
        )}
        <div className="toolbar-spacer" />
        <RunClock run={run} started={started} />
        <span className={`mode-badge ${mode}`} data-testid="run-mode">
          {MODES.find((m) => m.id === mode)?.label ?? mode}
        </span>
        <div className="segmented" title="Densidad">
          {DENSITIES.map((d) => (
            <button
              key={d.id}
              type="button"
              className="button"
              aria-pressed={density === d.id}
              onClick={() => {
                setDensity(d.id)
                try {
                  localStorage.setItem(DENSITY_KEY, d.id)
                } catch {
                  /* Preferencia no crítica. */
                }
              }}
            >
              {d.label}
            </button>
          ))}
        </div>
        <Button
          variant="danger"
          disabled={!call || !running}
          onClick={() =>
            call?.("runs.cancel", { ...mutationMeta(), run_id: run.id }).catch((e: unknown) =>
              setStopError(e instanceof Error ? e.message : String(e)),
            )
          }
        >
          Detener
        </Button>
      </header>
      <div className="rc-tabs">
        <Tabs values={liveTabs} active={tab} onChange={setTab} />
      </div>
      {stopError && (
        <p className="error-banner" role="alert">
          {stopError}
        </p>
      )}
      {tab === "Chat" && (
        <RunChat
          events={chainEvents}
          run={run}
          running={running}
          density={density}
          {...(task ? { task } : {})}
          {...(call ? { call } : {})}
          {...(onRun ? { onContinued: onRun } : {})}
          {...(onOpenTask ? { onTask: onOpenTask } : {})}
        />
      )}
      {tab === "Operaciones" &&
        (call ? (
          <div className="padded">
            <Operations call={call} runId={run.id} version={runEvents.length} />
          </div>
        ) : (
          <Empty title="Conecta el daemon para ver las operaciones" />
        ))}
      {tab === "Costo" && <CostView run={run} demo={false} />}
      {tab === "Eventos" && (
        <div className="padded">
          <label className="search-field">
            <Search size={14} />
            <input
              aria-label="Buscar eventos"
              placeholder="Buscar en los eventos…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </label>
          <div className="timeline">
            {runEvents.flatMap((event) => {
              const detail = JSON.stringify(event.payload, null, 2)
              if (!`${event.kind} ${detail}`.toLowerCase().includes(query.toLowerCase())) return []
              return [
                <article key={event.event_seq} data-testid="timeline-row">
                  <span className="mono muted">#{event.event_seq}</span>
                  <div>
                    <strong>{event.kind}</strong>
                    <pre>{detail}</pre>
                  </div>
                  <time className="mono muted">
                    {new Date(event.received_at).toLocaleTimeString()}
                  </time>
                </article>,
              ]
            })}
            {runEvents.length === 0 && <Empty title="Sin eventos recibidos para este run" />}
          </div>
        </div>
      )}
    </div>
  )
}

/** «Trabajando · 02:14» mientras corre; el estado al terminar. */
function RunClock({ run, started }: { run: Run; started: string | null }) {
  const [now, setNow] = useState(Date.now)
  const running = !TERMINAL.has(run.status)
  useEffect(() => {
    if (!running) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [running])
  if (run.visual_state === "running" && started)
    return (
      <span className="rc-clock" data-state="running">
        <span className="rc-pulse" /> Trabajando · {clock(started, now)}
      </span>
    )
  return <Status state={run.visual_state} />
}

function CostView({ run, demo }: { run: Run; demo: boolean }) {
  return (
    <div className="cost-view">
      <h2>Usage & budget</h2>
      <strong>{formatCost(run)}</strong>
      <p className="muted">
        cost_kind: <code>{run.cost_kind}</code>
      </p>
      <div className="callout">
        <h3>
          {run.cost_kind === "unknown"
            ? "El proveedor no ha publicado un importe"
            : run.cost_kind === "estimated"
              ? "Estimación del runtime"
              : "Costo observado"}
        </h3>
        <p>
          El costo conserva su procedencia. Una cuota de suscripción no se interpreta como costo por
          llamada conocido.
        </p>
      </div>
      {demo && (
        <>
          <h3>Ejemplo de watchdog</h3>
          <progress value={run.total_cost_micro_usd ?? 0} max={2_500_000} />
          <p className="mono">{formatCost(run)} / $2.50 cap de ejemplo</p>
          <Hint>El watchdog no está implementado en el backend actual.</Hint>
        </>
      )}
    </div>
  )
}

function DemoRunView({ run, task, demo, events, onBack, onTask, call }: RunViewProps) {
  const [tab, setTab] = useState<(typeof runTabs)[number]>(demo ? "Agents" : "Timeline")
  const [stopError, setStopError] = useState("")
  const [query, setQuery] = useState("")
  const [expanded, setExpanded] = useState("tool-4")
  const [workersOpen, setWorkersOpen] = useState(true)
  const tools = demoTools.filter((tool) =>
    `${tool.name} ${tool.label}`.toLowerCase().includes(query.toLowerCase()),
  )
  const runEvents = events.filter((event) => event.run_id === run.id)
  const where = workspaceOf(run, runEvents)
  return (
    <div className="page run-page">
      <div className="toolbar">
        <Button variant="ghost" icon={ArrowLeft} onClick={onBack}>
          Runs
        </Button>
        <button type="button" className="text-link mono" onClick={onTask}>
          {task?.display_id ?? "Task"}
        </button>
        <ChevronRight size={12} />
        <span className="mono">{run.id}</span>
        <Status state={run.visual_state} />
        {run.isolation && (
          <span
            className={`mode-badge isolation-${run.isolation}`}
            data-testid="isolation"
            title={ISOLATION_HINT[run.isolation]}
          >
            {ISOLATION_LABEL[run.isolation]}
          </span>
        )}
        {run.options && (
          <span
            className={`mode-badge ${run.options.permission_mode}`}
            title={`modelo ${run.options.model ?? "del perfil"} · turnos ${run.options.max_turns ?? "—"}`}
          >
            {run.options.permission_mode === "bypass"
              ? "BYPASS · sin permisos"
              : run.options.permission_mode}
          </span>
        )}
        <div className="toolbar-spacer" />
        {demo || !call ? (
          <Button disabled title="Sólo con el daemon conectado">
            Stop run
          </Button>
        ) : (
          <Button
            variant="danger"
            disabled={TERMINAL.has(run.status)}
            onClick={() =>
              call("runs.cancel", { ...mutationMeta(), run_id: run.id }).catch((e: unknown) =>
                setStopError(e instanceof Error ? e.message : String(e)),
              )
            }
          >
            Stop run
          </Button>
        )}
      </div>
      {stopError && (
        <p className="error-banner" role="alert">
          {stopError}
        </p>
      )}
      <div className="run-summary">
        <div>
          <small>RUN</small>
          <code>{run.id}</code>
        </div>
        <div>
          <small>TASK</small>
          <span>{task?.title ?? run.work_item_id}</span>
        </div>
        <div>
          <small>BASE</small>
          <code>{demo ? "3e1d9c0" : (where.base ?? where.label)}</code>
        </div>
        <div>
          <small>BRANCH</small>
          <code>
            <GitBranch size={12} />
            {demo ? "keel/KEEL-142-auth-retry" : (where.branch ?? where.label)}
          </code>
        </div>
        <div>
          <small>COST</small>
          <code>{formatCost(run)}</code>
        </div>
      </div>
      <div className="run-layout">
        <aside className="run-plan">
          <header>
            Plan <span className="muted mono">{demo ? "rev 2" : "—"}</span>
          </header>
          {demo ? (
            <>
              <h3>STEPS · DEPENDENCIES</h3>
              {[
                "A · implementer + tester",
                "B · reviewer (after A)",
                "C · integrator (after B)",
              ].map((step, index) => (
                <div className="lane-step" key={step}>
                  <span className="mono muted">{index + 1}</span>
                  <div>
                    <Status
                      state={index === 0 ? "succeeded" : index === 1 ? run.visual_state : "queued"}
                      dot
                    />
                    {step}
                    <small>{index === 0 ? "claude-sonnet · gpt-codex" : "read-only review"}</small>
                  </div>
                </div>
              ))}
              <section>
                <h3>REVISIONS</h3>
                <p className="mono">rev 2 · 14:03</p>
                <p>Added tester in wave A: change touches auth. Planner escalated to Opus.</p>
                <p className="mono">rev 1 · 14:02</p>
                <p>Initial: implementer → reviewer.</p>
              </section>
              <Hint>Datos ilustrativos.</Hint>
            </>
          ) : (
            <Hint>El DAG y los nodos requieren un endpoint de lectura.</Hint>
          )}
        </aside>
        <section className="run-main">
          <div className="run-tabs">
            <Tabs values={runTabs} active={tab} onChange={setTab} />
            <label className="search-field">
              <Search size={14} />
              <input
                aria-label="Buscar tool calls"
                placeholder="Search tool calls, agents, files…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </label>
          </div>
          {tab === "Agents" &&
            (demo ? (
              <div className="agent-tree">
                <div className="tree-row root-agent">
                  <ChevronDown size={13} />
                  <Status state={run.visual_state} dot />
                  <strong className="mono">agent_7c21e</strong>
                  <span className="role">orchestrator</span>
                  <span className="mono muted">claude-opus</span>
                </div>
                <button
                  type="button"
                  className="tree-row worker-agent"
                  aria-expanded={workersOpen}
                  onClick={() => setWorkersOpen((value) => !value)}
                >
                  {workersOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                  <Status state="succeeded" dot />
                  <strong className="mono">agent_9b04d</strong>
                  <span className="role">implementer</span>
                  <span className="mono muted">claude-sonnet · parent certain</span>
                </button>
                {workersOpen &&
                  tools.map((tool) => (
                    <div key={tool.id}>
                      <button
                        type="button"
                        className={`tree-row tool-row ${expanded === tool.id ? "selected" : ""}`}
                        aria-expanded={expanded === tool.id}
                        onClick={() => setExpanded((old) => (old === tool.id ? "" : tool.id))}
                      >
                        {expanded === tool.id ? (
                          <ChevronDown size={12} />
                        ) : (
                          <ChevronRight size={12} />
                        )}
                        <Status state={tool.state as VisualState} dot />
                        <code className="muted tool-name">{tool.name}</code>
                        <span className={tool.state === "failed" ? "deleted" : ""}>
                          {tool.label}
                        </span>
                        <time className="mono muted">{tool.wall}</time>
                      </button>
                      {expanded === tool.id && (
                        <div className="tool-detail">
                          <div className="tool-timings">
                            <span>wall_ms: {tool.wall}</span>
                            <span>duration_ms: {tool.duration}</span>
                            <span>fixture · ejemplo</span>
                          </div>
                          <h3>INPUT</h3>
                          <pre>{tool.input}</pre>
                          <h3>OUTPUT</h3>
                          <pre>{tool.output}</pre>
                        </div>
                      )}
                    </div>
                  ))}
                <div className="tree-row worker-agent">
                  <ChevronRight size={13} />
                  <Status state="succeeded" dot />
                  <strong className="mono">agent_c4e10</strong>
                  <span className="role">tester</span>
                  <span className="mono muted">gpt-codex</span>
                </div>
                <div className="tree-row worker-agent">
                  <ChevronRight size={13} />
                  <Status state={run.visual_state} dot />
                  <strong className="mono">agent_1a7f3</strong>
                  <span className="role">reviewer</span>
                  <span className="mono muted">gpt-codex</span>
                </div>
                {tools.length === 0 && <Empty title="No matching tool calls" />}
              </div>
            ) : (
              <Empty title="Árbol pendiente de integración" icon={Bot}>
                El daemon sólo publica IDs de nodos. En Timeline puedes ver los eventos recibidos.
              </Empty>
            ))}
          {tab === "Timeline" && (
            <div className="timeline">
              {demo
                ? demoTools
                    .filter((tool) =>
                      `${tool.label} ${tool.name}`.toLowerCase().includes(query.toLowerCase()),
                    )
                    .map((tool, index) => (
                      <article key={tool.id}>
                        <span className="mono muted">14:{String(4 + index).padStart(2, "0")}</span>
                        <Status state={tool.state as VisualState} dot />
                        <div>
                          <strong>{tool.label}</strong>
                          <p className="muted">{tool.output}</p>
                        </div>
                        <code>{tool.wall}</code>
                      </article>
                    ))
                : runEvents.flatMap((event) => {
                    const title = event.kind
                    const detail = JSON.stringify(event.payload, null, 2)
                    if (!`${title} ${detail}`.toLowerCase().includes(query.toLowerCase())) return []
                    return [
                      <article key={event.event_seq} data-testid="timeline-row">
                        <span className="mono muted">#{event.event_seq}</span>
                        <div>
                          <strong>{title}</strong>
                          <pre>{detail}</pre>
                        </div>
                        <time className="mono muted">
                          {new Date(event.received_at).toLocaleTimeString()}
                        </time>
                      </article>,
                    ]
                  })}
              {!demo && runEvents.length === 0 && (
                <Empty title="Sin eventos recibidos para este run" />
              )}
            </div>
          )}
          {tab === "Operaciones" &&
            (call ? (
              <Operations call={call} runId={run.id} version={runEvents.length} />
            ) : (
              <Empty title="Conecta el daemon para ver las operaciones" />
            ))}
          {tab === "Cost" && <CostView run={run} demo={demo} />}
        </section>
      </div>
    </div>
  )
}

/** Dónde corrió: el worktree que anunció el daemon; un run que no ejecuta usa la raíz. */
function workspaceOf(
  run: Run,
  events: EventNotification[],
): { branch?: string; base?: string; label: string } {
  // Un run que continúa la conversación hereda el worktree del anterior (ADR-0019 §3).
  const created = events.find(
    (e) => e.kind === "worktree.created" || e.kind === "worktree.inherited",
  )?.payload as { branch_name?: string; base_sha?: string } | undefined
  if (created?.branch_name)
    return {
      branch: created.branch_name,
      label: "",
      ...(created.base_sha ? { base: created.base_sha.slice(0, 10) } : {}),
    }
  if (run.purpose !== "execute") return { label: "raíz del repo · sin worktree" }
  return { label: "preparando…" }
}
