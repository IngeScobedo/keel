/**
 * La tarea como superficie de foco (ADR-0034 §5): al centro lo que pasa (la
 * conversación, la actividad, el plan y la checklist), a la izquierda el trabajo y a la
 * derecha un cajón con el contexto que se abre solo cuando algo pide al humano.
 */
import type { EventNotification, Methods, TaskDocKind, TaskFlowView } from "@keel/core"
import {
  ArrowRight,
  Check,
  ChevronRight,
  Circle,
  FileCode2,
  FileText,
  GitBranch,
  Hand,
  ListChecks,
  MessageSquare,
  Network,
  Play,
  ScrollText,
  ShieldCheck,
  StickyNote,
} from "lucide-react"
import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react"
import { ApprovalCard } from "./ApprovalCard.js"
import type { Approval, FileDiff } from "./chat-model.js"
import { STAGE_LABEL } from "./chat-model.js"
import { mutationMeta } from "./client.js"
import { DesignSessionCard, DesignStart } from "./DesignSession.js"
import { EvidencePanel } from "./Evidence.js"
import { PrCard } from "./GitHub.js"
import { GitPlanCard } from "./GitPlanCard.js"
import { MarkdownPreview } from "./Markdown.js"
import { GateCard } from "./MethodCards.js"
import { actorLabel, formatCost, type Run, summarizeEvent, type WorkItem } from "./model.js"
import { ResearchPanel } from "./Research.js"
import { RunChat } from "./RunChat.js"
import { workspaceOf } from "./RunView.js"
import { TaskWork } from "./TaskWork.js"
import { DiffView } from "./ToolCards.js"
import { useTaskHistory } from "./task-history.js"
import {
  attentionKey,
  checklistOf,
  dagOf,
  isLive,
  lanesOf,
  type NextAction,
  nextAction,
  splitUnified,
} from "./task-model.js"
import { Button, Segmented, SidePanel, Tabs, TextArea } from "./ui/index.js"
import { Empty, Hint, Modal, Status } from "./ui.js"
import { Trail, useOpenDetail, usePlaceState } from "./useNav.js"
import type { useWorkspace } from "./useWorkspace.js"
import "./TaskFocus.css"

type Call = ReturnType<typeof useWorkspace>["call"]
type Detail = ReturnType<(typeof Methods)["work_items.get"]["result"]["parse"]>
type ApprovalView = ReturnType<
  (typeof Methods)["approvals.list"]["result"]["parse"]
>["approvals"][number]
/** Preguntas del agente: se contestan en la conversación, no desde el cajón. */
const QUESTION_TOOLS = new Set(["AskUserQuestion", "ExitPlanMode"])
type Doc = { kind: TaskDocKind; version: number; content_markdown?: string }

const CENTER = ["Conversación", "Actividad", "Plan", "Checklist", "Investigación"] as const
type Center = (typeof CENTER)[number]
const SECTIONS = ["decidir", "diff", "notas", "evidencia", "documentos", "runs"] as const
type Section = (typeof SECTIONS)[number]
const SECTION_LABEL: Record<Section, string> = {
  decidir: "Por decidir",
  diff: "Cambios",
  notas: "Notas",
  evidencia: "Evidencia",
  documentos: "Documentos",
  runs: "Runs",
}
const SECTION_ICON = {
  decidir: Hand,
  diff: FileCode2,
  notas: StickyNote,
  evidencia: ShieldCheck,
  documentos: ScrollText,
  runs: Play,
} as const

/** Motivos por los que el humano ya cerró el cajón: no se reabre por lo mismo. */
const dismissed = new Set<string>()

export function TaskFocus({
  task,
  runs,
  events: liveEvents,
  call,
  tasks,
  onRun,
  onOpenTask,
  waitingYou,
  onCloseTask,
}: {
  task: WorkItem
  runs: Run[]
  events: EventNotification[]
  call: Call
  tasks: WorkItem[]
  onRun: (run: Run) => void
  onOpenTask: (item: WorkItem) => void
  waitingYou?: Set<string>
  onCloseTask?: () => void
}) {
  // Los ids son ULID: ordenados, el primero es el más reciente. El orden de `runs` mezcla
  // el snapshot y lo que llegó después.
  const history = useTaskHistory(call, task.id, liveEvents)
  const events = history.events
  const taskRuns = runs
    .filter((r) => r.work_item_id === task.id)
    .sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0))
  const latest = taskRuns[0]
  const current = taskRuns.find(isLive) ?? latest
  const subtasks = tasks.filter((t) => t.parent_work_item_id === task.id)
  // Se relee al llegar algo de esta tarea; el evento sólo avisa.
  const runIds = new Set(taskRuns.map((r) => r.id))
  const mine = (e: EventNotification) => {
    const p = e.payload as { work_item_id?: string; id?: string } | null
    return (
      p?.work_item_id === task.id ||
      p?.id === task.id ||
      (e.run_id !== null && runIds.has(e.run_id))
    )
  }
  const touches = events.filter(mine).length
  const [flow, setFlow] = useState<TaskFlowView | null>(null)
  const [detail, setDetail] = useState<Detail | null>(null)
  const [pending, setPending] = useState<ApprovalView[]>([])
  const [docs, setDocs] = useState<Partial<Record<TaskDocKind, Doc>>>({})
  const [error, setError] = useState("")
  // biome-ignore lint/correctness/useExhaustiveDependencies: `touches` y la revisión sólo disparan la relectura.
  useEffect(() => {
    let alive = true
    const fail = (e: unknown) => alive && setError(e instanceof Error ? e.message : String(e))
    call("work_items.get", { work_item_id: task.id })
      .then((r) => alive && setDetail(r))
      .catch(fail)
    call("tasks.flow", { work_item_id: task.id })
      .then((r) => alive && setFlow(r.flow))
      .catch(() => alive && setFlow(null))
    call("approvals.list", {})
      .then((r) => alive && setPending(r.approvals.filter((a) => a.work_item_id === task.id)))
      .catch(() => {})
    call("task_docs.list", { work_item_id: task.id })
      .then(async (r) => {
        const wanted = r.docs.filter((d) => ["spec", "tasks", "qa"].includes(d.kind))
        const full = await Promise.all(
          wanted.map((d) =>
            call("task_docs.get", { work_item_id: task.id, kind: d.kind }).then((g) => g.doc),
          ),
        )
        const all: Partial<Record<TaskDocKind, Doc>> = {}
        for (const d of r.docs) all[d.kind] = { kind: d.kind, version: d.version }
        for (const d of full) if (d) all[d.kind] = d as Doc
        if (alive) setDocs(all)
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [call, task.id, task.revision, touches])

  const action = nextAction(task, flow, taskRuns, pending.length)
  const hasPlan = Boolean(task.feature) || docs.tasks?.content_markdown !== undefined
  const hasChecklist = docs.spec?.content_markdown !== undefined
  const center = CENTER.filter(
    (c) =>
      (c !== "Plan" || hasPlan) &&
      (c !== "Checklist" || hasChecklist) &&
      (c !== "Investigación" || task.kind === "research"),
  )
  const [tab, setTab] = usePlaceState<Center>("tab", latest ? "Conversación" : "Actividad")
  const active = center.includes(tab) ? tab : "Actividad"
  const [section, setSection] = usePlaceState<Section | null>("drawer", null)
  // El cajón se abre solo con lo que pide al humano y no está en el hilo.
  const attention = attentionKey(flow)
  // biome-ignore lint/correctness/useExhaustiveDependencies: sólo al cambiar el motivo.
  useEffect(() => {
    if (attention && !dismissed.has(attention)) setSection("decidir")
  }, [attention])
  const closeDrawer = () => {
    if (attention) dismissed.add(attention)
    setSection(null)
  }
  const go = (a: NextAction) => {
    if (a.kind === "plan" || a.kind === "decide") setSection("decidir")
    else if (a.kind === "close") onCloseTask?.()
    else if (a.kind === "work" && !latest)
      document.querySelector<HTMLElement>("[data-testid=task-work] textarea")?.focus()
    else setTab("Conversación")
  }
  const counts: Partial<Record<Section, number>> = {
    decidir: pending.length,
    notas: detail?.notes.length ?? 0,
    documentos: Object.keys(docs).length,
    runs: taskRuns.length,
  }

  return (
    <div className="page task-focus" data-testid="task-focus">
      <header className="tf-head">
        <Trail />
        <div className="tf-title">
          <h1>{task.title}</h1>
          <Status state={task.visual_state} />
          {task.stage && (
            <span className="tf-stage" title="Etapa del método">
              {STAGE_LABEL[task.stage] ?? task.stage}
            </span>
          )}
          <span className="tf-spacer" />
          {/* Sin conversación, la acción es el compositor de la izquierda: no se duplica. */}
          {action.kind !== "none" && !(action.kind === "work" && !latest) && (
            <Button
              variant={action.kind === "watch" ? "default" : "primary"}
              icon={action.kind === "work" ? Play : ArrowRight}
              onClick={() => go(action)}
              data-testid="next-action"
            >
              {action.label}
            </Button>
          )}
        </div>
        {detail?.spec_markdown && (
          <div className="task-spec tf-spec">
            <MarkdownPreview
              text={detail.spec_markdown}
              title={`Especificación · ${task.display_id}`}
              maxHeight={72}
            />
          </div>
        )}
      </header>
      {error && (
        <p className="error-banner" role="alert">
          {error}
        </p>
      )}
      <div className="tf-body" data-panel={section !== null || undefined}>
        <aside className="tf-work" aria-label="Trabajo">
          {/* Trabajar no saca de la tarea: el run nuevo se ve en su conversación. */}
          <TaskWork
            task={task}
            runs={taskRuns}
            call={call}
            onRun={() => setTab("Conversación")}
            composer={!latest}
          />
          <WorkFacts task={task} runs={taskRuns} events={events} call={call} />
          {task.feature && (
            <SubtaskLanes
              call={call}
              parentId={task.id}
              subtasks={subtasks}
              runs={runs}
              events={events}
              waitingYou={waitingYou}
              onOpen={onOpenTask}
              feature={task.feature}
            />
          )}
          {task.lifecycle !== "done" && <DesignStart task={task} events={events} call={call} />}
          {onCloseTask && task.lifecycle !== "done" && task.lifecycle !== "running" && (
            <section className="tf-section">
              <h3>Revisión humana</h3>
              <Button icon={ShieldCheck} size="sm" onClick={onCloseTask}>
                Cerrar a mano
              </Button>
              <Hint>Para trabajo hecho fuera de Keel, con motivo y evidencia (ADR-0027).</Hint>
            </section>
          )}
        </aside>
        <main className="tf-thread">
          <Tabs
            values={center}
            active={active}
            onChange={setTab}
            labels={{
              Checklist: hasChecklist ? (
                <ChecklistLabel docs={docs} subtasks={subtasks} />
              ) : (
                "Checklist"
              ),
            }}
          />
          <div className="tf-panel" data-tab={active}>
            {/* ADR-0044: una sesión que espera al humano no depende de la pestaña. */}
            <DesignSessionCard task={task} events={events} call={call} />
            {active === "Conversación" && history.more && (
              <Button
                size="sm"
                variant="ghost"
                data-testid="history-more"
                disabled={history.loading}
                onClick={history.loadOlder}
              >
                Cargar lo anterior
              </Button>
            )}
            {active === "Conversación" &&
              (current ? (
                <Thread
                  run={current}
                  runs={runs}
                  events={events}
                  task={task}
                  call={call}
                  onOpenTask={onOpenTask}
                  tasks={tasks}
                />
              ) : (
                <Empty title="Todavía no hay conversación">
                  Escribe qué necesitas a la izquierda y pulsa Trabajar: Keel empieza por el brief.
                </Empty>
              ))}
            {active === "Actividad" && (
              <Activity task={task} detail={detail} events={events.filter(mine)} call={call} />
            )}
            {active === "Plan" && (
              <PlanDag
                tasksMd={docs.tasks?.content_markdown ?? null}
                subtasks={subtasks}
                onOpen={onOpenTask}
                waitingYou={waitingYou}
              />
            )}
            {active === "Checklist" && docs.spec?.content_markdown !== undefined && (
              <Checklist
                specMd={docs.spec.content_markdown}
                tasksMd={docs.tasks?.content_markdown ?? null}
                qaMd={docs.qa?.content_markdown ?? null}
                subtasks={subtasks}
              />
            )}
            {active === "Investigación" && (
              <ResearchPanel call={call} workItemId={task.id} tick={touches} />
            )}
          </div>
        </main>
        {section && (
          <SidePanel title={SECTION_LABEL[section]} onClose={closeDrawer}>
            {section === "decidir" && <Decide pending={pending} call={call} />}
            {section === "diff" && <Changes task={task} run={current} call={call} />}
            {section === "notas" && <Notes task={task} detail={detail} call={call} />}
            {section === "evidencia" && (
              <EvidencePanel call={call} workItemId={task.id} tick={touches} />
            )}
            {section === "documentos" && <Documents task={task} docs={docs} call={call} />}
            {section === "runs" && <RunList runs={taskRuns} onRun={onRun} />}
          </SidePanel>
        )}
        <nav className="tf-rail" aria-label="Contexto">
          {SECTIONS.map((s) => {
            const Icon = SECTION_ICON[s]
            const n = counts[s] ?? 0
            return (
              <button
                type="button"
                key={s}
                className="tf-rail-button"
                aria-label={SECTION_LABEL[s]}
                title={SECTION_LABEL[s]}
                aria-pressed={section === s}
                data-attention={(s === "decidir" && n > 0) || undefined}
                onClick={() => (section === s ? closeDrawer() : setSection(s))}
              >
                <Icon size={16} aria-hidden />
                {n > 0 && <span className="tf-rail-count">{n}</span>}
              </button>
            )
          })}
        </nav>
      </div>
    </div>
  )
}

/** Dónde trabaja la tarea: rama, worktree, base y lo que lleva gastado con su `cost_kind`. */
function WorkFacts({
  task,
  runs,
  events,
  call,
}: {
  task: WorkItem
  runs: Run[]
  events: EventNotification[]
  call: Call
}) {
  const latest = runs[0]
  const [status, setStatus] = useState<{
    worktree: string
    branch: string | null
    files: number
  } | null>(null)
  const runKey = latest?.id ?? ""
  // biome-ignore lint/correctness/useExhaustiveDependencies: el estado del run sólo dispara la relectura.
  useEffect(() => {
    if (!runKey) return
    let alive = true
    call("git.status", { run_id: runKey })
      .then(
        (s) =>
          alive && setStatus({ worktree: s.worktree, branch: s.branch, files: s.files.length }),
      )
      .catch(() => alive && setStatus(null))
    return () => {
      alive = false
    }
  }, [call, runKey, latest?.status, task.revision])
  if (!latest) return null
  const where = workspaceOf(
    latest,
    events.filter((e) => e.run_id === latest.id),
  )
  const known = runs.filter((r) => r.cost_kind !== "unknown" && r.total_cost_micro_usd !== null)
  const total = known.reduce((s, r) => s + (r.total_cost_micro_usd ?? 0), 0)
  const kind = known.some((r) => r.cost_kind === "estimated") ? "estimated" : "observed"
  return (
    <section className="tf-section tf-facts">
      <h3>Repo</h3>
      <dl>
        <dt>Rama</dt>
        <dd className="mono" title={where.base ? `base ${where.base}` : undefined}>
          <GitBranch size={12} aria-hidden /> {status?.branch ?? where.branch ?? where.label}
        </dd>
        {status && (
          <>
            <dt>Worktree</dt>
            <dd className="mono tf-path" title={status.worktree}>
              {status.worktree.split("/").slice(-2).join("/")}
            </dd>
            <dt>Sin confirmar</dt>
            <dd>
              {status.files === 0
                ? "nada"
                : `${status.files} archivo${status.files === 1 ? "" : "s"}`}
            </dd>
          </>
        )}
        {where.base && (
          <>
            <dt>Base</dt>
            <dd className="mono">{where.base}</dd>
          </>
        )}
        <dt>Costo</dt>
        <dd>
          {known.length === 0
            ? "desconocido"
            : formatCost({ total_cost_micro_usd: total, cost_kind: kind })}
          {known.length < runs.length && (
            <span className="muted"> · {runs.length - known.length} sin dato</span>
          )}
        </dd>
      </dl>
    </section>
  )
}

/** Las subtareas trabajando en paneles; las encoladas plegadas; las hechas en una línea. */
type FeatureLanes = ReturnType<(typeof Methods)["features.lanes"]["result"]["parse"]>

/** Por qué no arranca una subtarea en cola (ADR-0039 §2). */
const WAIT_LABEL: Record<string, string> = {
  waiting_limit: "espera lugar",
  waiting_lane: "espera su carril",
  waiting_deps: "espera dependencias",
  ready: "lista",
}

function SubtaskLanes({
  call,
  parentId,
  subtasks,
  runs,
  events,
  waitingYou,
  onOpen,
  feature,
}: {
  call: Call
  parentId: string
  subtasks: WorkItem[]
  runs: Run[]
  events: EventNotification[]
  waitingYou: Set<string> | undefined
  onOpen: (item: WorkItem) => void
  feature: NonNullable<WorkItem["feature"]>
}) {
  const lanes = lanesOf(subtasks, runs, waitingYou)
  // ADR-0039: los carriles y por qué espera cada una; se relee cuando algo cambia.
  const [lane, setLane] = useState<FeatureLanes | null>(null)
  const signature = `${subtasks.map((x) => x.lifecycle).join()}|${runs.filter(isLive).length}`
  // biome-ignore lint/correctness/useExhaustiveDependencies: la firma sólo dispara la relectura.
  useEffect(() => {
    let alive = true
    call("features.lanes", { work_item_id: parentId })
      .then((r) => alive && setLane(r))
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [call, parentId, signature])
  const why = (id: string) => lane?.subtasks.find((x) => x.id === id)
  const waitingLimit = lane?.subtasks.filter((x) => x.state === "waiting_limit").length ?? 0
  return (
    <section className="tf-section" data-testid="feature-plan">
      <h3>
        Subtareas · {feature.done}/{feature.total} integradas
      </h3>
      <p className="mono muted tf-small">
        {feature.branch}
        {feature.auto_integrate ? " · se integran solas" : " · cada integración te pregunta"}
      </p>
      {lane && (
        <p className="muted tf-small" data-testid="feature-lanes">
          {lane.lanes.length} carril{lane.lanes.length === 1 ? "" : "es"} · {lane.live_runs} de{" "}
          {lane.max_concurrent_runs} run{lane.max_concurrent_runs === 1 ? "" : "s"} en uso
          {waitingLimit > 0 &&
            ` · ${waitingLimit} lista${waitingLimit === 1 ? "" : "s"} esperando lugar: subir el límite (Ajustes) es tu decisión`}
        </p>
      )}
      <div className="tf-lanes">
        {[...lanes.waiting, ...lanes.working].map((s) => {
          const waiting = lanes.waiting.includes(s)
          return (
            <button
              type="button"
              key={s.id}
              className="tf-subtask"
              data-lane={waiting ? "waiting" : "working"}
              onClick={() => onOpen(s)}
            >
              <span className="tf-subtask-head">
                <Status state={s.visual_state} dot />
                <span className="mono muted">{s.subtask?.key ?? s.display_id}</span>
                {waiting && (
                  <span className="rc-pill needs-you">
                    {waitingYou?.has(s.id) ? "espera tu decisión" : "espera tu revisión"}
                  </span>
                )}
              </span>
              <strong>{s.title}</strong>
              <span className="muted tf-small">
                {s.stage ? (STAGE_LABEL[s.stage] ?? s.stage) : s.lifecycle}
                {!waiting && (
                  <>
                    {" · "}
                    <LastAction
                      runs={runs.filter((r) => r.work_item_id === s.id)}
                      events={events}
                    />
                  </>
                )}
              </span>
            </button>
          )
        })}
      </div>
      {lanes.queued.length > 0 && (
        <details className="tf-queued" data-testid="subtask-queue">
          <summary>
            <ChevronRight size={12} aria-hidden /> En cola · {lanes.queued.length}
          </summary>
          {lanes.queued.map((s) => (
            <button type="button" key={s.id} className="subtask-row" onClick={() => onOpen(s)}>
              <Status state={s.visual_state} dot />
              <span className="mono muted">{s.subtask?.key ?? s.display_id}</span>
              <span>{s.title}</span>
              {why(s.id) && WAIT_LABEL[why(s.id)?.state ?? ""] && (
                <span className="rc-pill" data-testid="subtask-wait" data-state={why(s.id)?.state}>
                  {WAIT_LABEL[why(s.id)?.state ?? ""]}
                  {why(s.id)?.waiting_for ? ` · ${why(s.id)?.waiting_for}` : ""}
                </span>
              )}
            </button>
          ))}
        </details>
      )}
      {lanes.done.length > 0 && (
        <p className="muted tf-small">
          <Check size={12} aria-hidden /> Integradas:{" "}
          {lanes.done.map((s) => s.subtask?.key ?? s.display_id).join(", ")}
        </p>
      )}
    </section>
  )
}

/** Cuánto lleva el run vivo de una subtarea. */
function LastAction({ runs, events }: { runs: Run[]; events: EventNotification[] }) {
  const live = runs.find(isLive)
  const started = live
    ? events.find((e) => e.kind === "run.created" && e.run_id === live.id)?.received_at
    : undefined
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    if (!live) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [live])
  if (!started) return <>esperando</>
  const s = Math.max(0, Math.floor((now - Date.parse(started)) / 1000))
  return (
    <>
      trabajando {Math.floor(s / 60)}:{String(s % 60).padStart(2, "0")}
    </>
  )
}

/** La conversación de la tarea: la cadena de runs que termina en el actual. */
function Thread({
  run,
  runs,
  events,
  task,
  call,
  onOpenTask,
  tasks,
}: {
  run: Run
  runs: Run[]
  events: EventNotification[]
  task: WorkItem
  call: Call
  onOpenTask: (item: WorkItem) => void
  tasks: WorkItem[]
}) {
  const chain = new Set<string>([run.id])
  for (let r: Run | undefined = run; r?.parent_run_id; ) {
    chain.add(r.parent_run_id)
    const parent: string = r.parent_run_id
    r = runs.find((x) => x.id === parent)
  }
  return (
    <div className="tf-chat">
      <RunChat
        events={events.filter((e) => e.run_id !== null && chain.has(e.run_id))}
        run={run}
        running={isLive(run)}
        density="balanced"
        task={task}
        call={call}
        onTask={(id) => {
          const item = tasks.find((t) => t.id === id)
          if (item) onOpenTask(item)
        }}
      />
    </div>
  )
}

/** Notas y lo que pasó, con el Markdown del agente renderizado. */
function Activity({
  task,
  detail,
  events,
  call,
}: {
  task: WorkItem
  detail: Detail | null
  events: EventNotification[]
  call: Call
}) {
  const rows = [
    ...(detail?.notes ?? []).map((n) => ({ at: n.created_at, kind: "note" as const, n })),
    ...events.flatMap((e) => {
      const s = summarizeEvent(e)
      return s && e.kind !== "note.added"
        ? [{ at: e.received_at, kind: "event" as const, e, s }]
        : []
    }),
  ].sort((a, b) => a.at.localeCompare(b.at))
  return (
    <div className="tf-activity">
      <NoteForm task={task} call={call} />
      {rows.length === 0 && <Empty title="Sin actividad todavía" />}
      {rows.map((r) =>
        r.kind === "note" ? (
          <article className="activity-row" key={r.n.id} data-testid="note">
            <span className="role" data-actor={actorLabel(r.n.author).role}>
              {actorLabel(r.n.author).role === "human" ? "human" : "agent"}
            </span>
            <div>
              <strong title={r.n.author}>{actorLabel(r.n.author).label}</strong>
              <MarkdownPreview
                text={r.n.content_markdown}
                title={`Nota de ${actorLabel(r.n.author).label} · ${task.display_id}`}
              />
            </div>
            <time>{new Date(r.n.created_at).toLocaleTimeString()}</time>
          </article>
        ) : (
          <article className="activity-row" key={r.e.event_seq}>
            <span className="mono muted">#{r.e.event_seq}</span>
            <div>
              <strong>{r.s.title}</strong>
              {r.s.markdown ? (
                <MarkdownPreview
                  text={r.s.markdown}
                  title={`${r.s.title} · ${task.display_id} · #${r.e.event_seq}`}
                />
              ) : (
                r.s.detail && <p className="mono text-block">{r.s.detail}</p>
              )}
            </div>
            <time>{new Date(r.e.received_at).toLocaleTimeString()}</time>
          </article>
        ),
      )}
    </div>
  )
}

/** Una nota en Markdown, a nombre del humano. Ctrl/⌘+Enter publica. */
function NoteForm({ task, call }: { task: WorkItem; call: Call }) {
  const [draft, setDraft] = useState("")
  const [error, setError] = useState("")
  async function post() {
    const text = draft.trim()
    if (!text) return
    try {
      await call("notes.add", { ...mutationMeta(), work_item_id: task.id, content_markdown: text })
      setDraft("")
      setError("")
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }
  return (
    <div className="comment-form">
      <TextArea
        aria-label="Nota para la tarea"
        placeholder="Escribe una nota en Markdown (queda a tu nombre)…"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter") void post()
        }}
      />
      <Button onClick={() => void post()} disabled={!draft.trim()}>
        Post
      </Button>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </div>
  )
}

function Notes({ task, detail, call }: { task: WorkItem; detail: Detail | null; call: Call }) {
  return (
    <div className="tf-drawer-list">
      <NoteForm task={task} call={call} />
      {(detail?.notes ?? []).length === 0 && <Hint>Sin notas.</Hint>}
      {[...(detail?.notes ?? [])].reverse().map((n) => (
        <article key={n.id} className="tf-note">
          <strong>{actorLabel(n.author).label}</strong>
          <MarkdownPreview text={n.content_markdown} title={`Nota · ${task.display_id}`} />
        </article>
      ))}
    </div>
  )
}

/** Lo que espera al humano en esta tarea: planes de git, gates y permisos. */
function Decide({ pending, call }: { pending: ApprovalView[]; call: Call }) {
  if (pending.length === 0) return <Empty title="Nada por decidir" />
  return (
    <div className="tf-drawer-list">
      {pending.map((a) => {
        const op = (a.operation ?? {}) as { tool?: string; input?: unknown }
        const tool = op.tool ?? "?"
        if (tool === "git.plan")
          return (
            <GitPlanCard
              key={a.id}
              input={op.input}
              approvalId={a.id}
              operationHash={a.operation_hash}
              call={call}
              pending
            />
          )
        const approval: Approval = {
          kind: "approval",
          key: a.id,
          approval_id: a.id,
          operation_hash: a.operation_hash,
          tool,
          input: op.input,
          expires_at: a.expires_at,
          decision: null,
          answers: null,
          reason: null,
          plan: null,
        }
        if (tool === "stage.gate")
          return <GateCard key={a.id} a={approval} call={call} active={false} />
        if (QUESTION_TOOLS.has(tool))
          return (
            <Hint key={a.id}>El agente te hizo una pregunta: contéstala en la conversación.</Hint>
          )
        return <ApprovalCard key={a.id} a={approval} call={call} active={false} />
      })}
    </div>
  )
}

type TaskChanges = ReturnType<(typeof Methods)["tasks.changes"]["result"]["parse"]>

/**
 * Lo que cambió la tarea contra su base: la historia de commits, las PR y el diff por
 * archivo. Mientras vive el worktree, en vivo; después de mergear y cerrar, lo que Keel
 * guardó antes de liberarlo.
 */
function Changes({ task, run, call }: { task: WorkItem; run: Run | undefined; call: Call }) {
  const [c, setC] = useState<TaskChanges | null>(null)
  const [error, setError] = useState("")
  const [prOpen, setPrOpen] = useState<number | null>(null)
  // En una feature: «todo» o una subtarea (T1…), que filtra la historia y el diff.
  const [only, setOnly] = useState<string | null>(null)
  // biome-ignore lint/correctness/useExhaustiveDependencies: el estado del run sólo dispara la relectura.
  useEffect(() => {
    let alive = true
    call("tasks.changes", { work_item_id: task.id })
      .then((d) => alive && setC(d))
      .catch((e: unknown) => alive && setError(e instanceof Error ? e.message : String(e)))
    return () => {
      alive = false
    }
  }, [call, task.id, task.revision, run?.status])
  if (error) return <Hint>{error}</Hint>
  if (!c) return <Hint>Leyendo los cambios…</Hint>
  if (c.source === "none") return <Empty title="Esta tarea todavía no cambió nada" />
  const sub = only ? (c.subtasks.find((x) => x.key === only) ?? null) : null
  const subPaths = sub ? new Set(sub.files.map((f) => f.path)) : null
  const files: FileDiff[] = splitUnified(c.diff).filter((f) => !subPaths || subPaths.has(f.path))
  const stats = subPaths ? c.files.filter((f) => subPaths.has(f.path)) : c.files
  const commits = only ? c.commits.filter((k) => k.subtask_key === only) : c.commits
  const add = stats.reduce((s, f) => s + f.additions, 0)
  const del = stats.reduce((s, f) => s + f.deletions, 0)
  return (
    <div className="tf-drawer-list tf-changes" data-testid="task-changes" data-source={c.source}>
      <p className="muted tf-changes-head">
        <GitBranch size={12} aria-hidden /> <span className="mono">{c.branch ?? "—"}</span>
        {c.base_sha && c.head_sha && (
          <span className="mono">
            {" "}
            · {c.base_sha.slice(0, 7)}..{c.head_sha.slice(0, 7)}
          </span>
        )}
        {" · "}
        {c.source === "record"
          ? `guardado ${c.captured_at ? new Date(c.captured_at).toLocaleString() : ""} (ya se liberó)`
          : c.source === "branch"
            ? "en vivo, de la rama de la feature"
            : "en vivo, del worktree"}
      </p>
      {c.pull_requests.length > 0 && (
        <p className="tf-changes-prs">
          {c.pull_requests.map((p) => (
            <Button key={p.number} variant="ghost" onClick={() => setPrOpen(p.number)}>
              PR #{p.number}
            </Button>
          ))}
        </p>
      )}
      {c.subtasks.length > 0 && (
        <>
          <h4>
            Subtareas · {c.subtasks.filter((x) => x.integrated_sha).length} de {c.subtasks.length}{" "}
            integradas
          </h4>
          <Segmented
            aria-label="Ver cambios de"
            size="sm"
            mono
            value={only ?? "todo"}
            onChange={(v) => setOnly(v === "todo" ? null : v)}
            options={[
              { value: "todo", label: "Todo" },
              ...c.subtasks.map((x) => ({ value: x.key, label: x.key, title: x.title })),
            ]}
          />
          <ul className="tf-subchanges" data-testid="feature-subtasks">
            {c.subtasks.map((x) => {
              const a = x.files.reduce((s, f) => s + f.additions, 0)
              const d = x.files.reduce((s, f) => s + f.deletions, 0)
              return (
                <li key={x.id} data-active={only === x.key || undefined}>
                  <button type="button" onClick={() => setOnly(only === x.key ? null : x.key)}>
                    <span className="mono">{x.key}</span>
                    <span className="tf-commit-subject">{x.title}</span>
                    <span className="mono muted">
                      {x.integrated_sha ? `integrada ${x.integrated_sha.slice(0, 7)}` : x.lifecycle}
                    </span>
                    <span className="mono">
                      <span className="added">+{a}</span> <span className="deleted">−{d}</span>
                    </span>
                  </button>
                </li>
              )
            })}
          </ul>
        </>
      )}
      <h4>
        Historia{only ? ` de ${only}` : ""} · {commits.length} commit
        {commits.length === 1 ? "" : "s"}
      </h4>
      {commits.length === 0 && <Hint>Sin commits todavía: lo de abajo aún no se confirma.</Hint>}
      <ol className="tf-commits">
        {commits.map((k) => (
          <li key={k.sha}>
            <span className="mono muted">
              {k.subtask_key && !only ? `${k.subtask_key} · ` : ""}
              {k.sha.slice(0, 7)}
            </span>
            <span className="tf-commit-subject">{k.subject}</span>
            <span className="muted">
              {k.author} · {new Date(k.date).toLocaleDateString()} · {k.files.length} archivo
              {k.files.length === 1 ? "" : "s"}
            </span>
          </li>
        ))}
      </ol>
      <h4>
        Diff{only ? ` de ${only}` : " contra la base"} · {stats.length} archivo
        {stats.length === 1 ? "" : "s"} · <span className="added">+{add}</span>{" "}
        <span className="deleted">−{del}</span>
      </h4>
      {c.truncated && <Hint>El diff es muy grande: se muestra el principio.</Hint>}
      {files.map((f) => (
        <details key={f.path} className="tf-file" open={files.length <= 3}>
          <summary className="mono">
            {f.path} <span className="added">+{f.added}</span>{" "}
            <span className="deleted">−{f.removed}</span>
          </summary>
          <DiffView diff={f} />
        </details>
      ))}
      {prOpen !== null && (
        <Modal title={`PR #${prOpen}`} onClose={() => setPrOpen(null)} wide>
          <PrCard call={call} number={prOpen} />
        </Modal>
      )}
    </div>
  )
}

const DOC_LABEL: Record<TaskDocKind, string> = {
  brief: "Brief",
  spec: "Spec",
  design: "Diseño",
  tasks: "Plan de tareas",
  story: "Historia",
  qa: "QA",
}

/** Los documentos del método; abrir uno es un detalle encima, y «atrás» lo cierra. */
function Documents({
  task,
  docs,
  call,
}: {
  task: WorkItem
  docs: Partial<Record<TaskDocKind, Doc>>
  call: Call
}) {
  const open = useOpenDetail()
  const list = Object.values(docs)
  if (list.length === 0) return <Empty title="Sin documentos del método" />
  return (
    <div className="tf-drawer-list">
      {list.map((d) => (
        <button
          type="button"
          key={d.kind}
          className="tf-doc"
          onClick={async () => {
            const full =
              d.content_markdown ??
              (await call("task_docs.get", { work_item_id: task.id, kind: d.kind })).doc
                ?.content_markdown ??
              ""
            open?.({
              kind: "markdown",
              title: `${DOC_LABEL[d.kind]} · ${task.display_id} · v${d.version}`,
              text: full,
            })
          }}
        >
          <FileText size={14} aria-hidden />
          <span>{DOC_LABEL[d.kind]}</span>
          <span className="mono muted">v{d.version}</span>
        </button>
      ))}
    </div>
  )
}

function RunList({ runs, onRun }: { runs: Run[]; onRun: (run: Run) => void }) {
  if (runs.length === 0) return <Empty title="Sin runs" />
  return (
    <div className="tf-drawer-list">
      {runs.map((r) => (
        <button type="button" className="run-card" key={r.id} onClick={() => onRun(r)}>
          <span>
            <strong className="mono">{r.id}</strong>
            <Status state={r.visual_state} />
          </span>
          <p>{r.purpose}</p>
          <small className="mono">{formatCost(r)}</small>
          {r.end_reason && <p className="deleted">{r.end_reason}</p>}
        </button>
      ))}
    </div>
  )
}

function ChecklistLabel({
  docs,
  subtasks,
}: {
  docs: Partial<Record<TaskDocKind, Doc>>
  subtasks: WorkItem[]
}) {
  const lines = checklistOf(
    docs.spec?.content_markdown ?? "",
    docs.tasks?.content_markdown ?? null,
    subtasks,
    docs.qa?.content_markdown ?? null,
  )
  return (
    <>
      Checklist{" "}
      <span className="tf-tab-count">
        {lines.filter((l) => l.done).length}/{lines.length}
      </span>
    </>
  )
}

/** Un renglón por requisito del spec, marcado por lo que Keel comprobó. */
function Checklist({
  specMd,
  tasksMd,
  qaMd,
  subtasks,
}: {
  specMd: string
  tasksMd: string | null
  qaMd: string | null
  subtasks: WorkItem[]
}) {
  const lines = checklistOf(specMd, tasksMd, subtasks, qaMd)
  if (lines.length === 0) return <Empty title="El spec no tiene requisitos R<n>" />
  return (
    <ul className="tf-checklist" data-testid="checklist">
      {lines.map((l) => (
        <li key={l.id} data-done={l.done || undefined}>
          {l.done ? <Check size={14} aria-hidden /> : <Circle size={14} aria-hidden />}
          <span className="mono">{l.id}</span>
          <span className="tf-check-title">{l.title || "sin título"}</span>
          <span className="muted tf-small">
            {l.scenarios} escenario{l.scenarios === 1 ? "" : "s"} · {l.why}
          </span>
        </li>
      ))}
      <li className="tf-check-foot">
        <ListChecks size={13} aria-hidden /> La marca Keel: subtareas integradas o el veredicto del
        QA. El agente no la escribe.
      </li>
    </ul>
  )
}

/** El plan de la feature como DAG: fases en columnas y flechas por dependencia. */
function PlanDag({
  tasksMd,
  subtasks,
  onOpen,
  waitingYou,
}: {
  tasksMd: string | null
  subtasks: WorkItem[]
  onOpen: (item: WorkItem) => void
  waitingYou: Set<string> | undefined
}) {
  const box = useRef<HTMLDivElement>(null)
  const [paths, setPaths] = useState<{ d: string; key: string }[]>([])
  const dag = tasksMd ? dagOf(tasksMd, subtasks) : null
  const edgeKey = dag?.edges.map((e) => `${e.from}>${e.to}`).join(",") ?? ""
  // biome-ignore lint/correctness/useExhaustiveDependencies: las aristas y el tamaño deciden el dibujo.
  useLayoutEffect(() => {
    const el = box.current
    if (!el || !dag) return
    const draw = () => {
      const base = el.getBoundingClientRect()
      const at = (k: string) => el.querySelector(`[data-node="${k}"]`)?.getBoundingClientRect()
      setPaths(
        dag.edges.flatMap((e) => {
          const a = at(e.from)
          const b = at(e.to)
          if (!a || !b) return []
          const x1 = a.right - base.left
          const y1 = a.top + a.height / 2 - base.top
          const x2 = b.left - base.left
          const y2 = b.top + b.height / 2 - base.top
          const mid = (x1 + x2) / 2
          return [
            { key: `${e.from}>${e.to}`, d: `M${x1},${y1} C${mid},${y1} ${mid},${y2} ${x2},${y2}` },
          ]
        }),
      )
    }
    draw()
    const ro = new ResizeObserver(draw)
    ro.observe(el)
    return () => ro.disconnect()
  }, [edgeKey, subtasks.length])
  if (!dag || dag.phases.length === 0)
    return (
      <Empty title="Sin plan todavía" icon={Network}>
        El plan de tareas nace en el diseño de una feature (ADR-0022).
      </Empty>
    )
  return (
    <div className="tf-dag" ref={box} data-testid="plan-dag">
      <svg className="tf-dag-edges" aria-hidden="true">
        {paths.map((p) => (
          <path key={p.key} d={p.d} />
        ))}
      </svg>
      {dag.phases.map((ph) => (
        <section key={ph.phase} className="tf-dag-phase">
          <h4>
            Fase {ph.phase}
            {ph.title ? ` · ${ph.title}` : ""}
          </h4>
          {ph.nodes.map((n) => (
            <DagNode
              key={n.key}
              node={n}
              onOpen={onOpen}
              waiting={n.item ? waitingYou?.has(n.item.id) : false}
            >
              {n.frontier.length > 0 && (
                <span className="mono muted tf-small">{n.frontier.join(" · ")}</span>
              )}
            </DagNode>
          ))}
        </section>
      ))}
    </div>
  )
}

function DagNode({
  node,
  onOpen,
  waiting,
  children,
}: {
  node: ReturnType<typeof dagOf>["phases"][number]["nodes"][number]
  onOpen: (item: WorkItem) => void
  waiting: boolean | undefined
  children?: ReactNode
}) {
  const item = node.item
  return (
    <button
      type="button"
      className="tf-dag-node"
      data-node={node.key}
      data-state={item?.visual_state ?? "queued"}
      disabled={!item}
      onClick={() => item && onOpen(item)}
    >
      <span className="tf-dag-node-head">
        {item ? <Status state={item.visual_state} dot /> : <Circle size={10} aria-hidden />}
        <span className="mono">{node.key}</span>
        {node.requirements.length > 0 && (
          <span className="mono muted">{node.requirements.join(" ")}</span>
        )}
        {waiting && (
          <MessageSquare size={12} className="tf-waiting" aria-label="espera tu decisión" />
        )}
      </span>
      <strong>{node.title}</strong>
      {children}
      {!item && <span className="muted tf-small">no nació como subtarea</span>}
    </button>
  )
}
