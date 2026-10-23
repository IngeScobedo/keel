import type { EventNotification, Methods } from "@keel/core"
import {
  ArrowLeft,
  Check,
  ChevronRight,
  FileCode2,
  FileText,
  GitBranch,
  MessageSquare,
  ShieldCheck,
} from "lucide-react"
import { useEffect, useState } from "react"
import { mutationMeta } from "./client.js"
import { demoActivity, demoDiff } from "./fixtures.js"
import { LiveTaskActions } from "./LiveTaskActions.js"
import {
  actorLabel,
  formatCost,
  type Run,
  summarizeEvent,
  type TaskDetails,
  type WorkItem,
} from "./model.js"
import { Button, Empty, Hint, Modal, Status, Tabs } from "./ui.js"
import type { useWorkspace } from "./useWorkspace.js"

type Call = ReturnType<typeof useWorkspace>["call"]
type Detail = ReturnType<(typeof Methods)["work_items.get"]["result"]["parse"]>

const taskTabs = ["Activity", "Plan", "Checklist", "Evidence", "Notes", "Diff"] as const
export function Inspector({
  task,
  details,
  runs,
  demo,
  events,
  onBack,
  onRun,
  onUpdate,
  notes,
  onAddNote,
  call,
}: {
  task: WorkItem
  details?: TaskDetails
  runs: Run[]
  demo: boolean
  events: EventNotification[]
  onBack: () => void
  onRun: (run: Run) => void
  onUpdate: (task: WorkItem) => void
  notes: { id: string; text: string }[]
  onAddNote: (text: string) => void
  /** Sólo en modo live: lectura y acciones contra el daemon. */
  call?: Call
}) {
  const [tab, setTab] = useState<(typeof taskTabs)[number]>("Activity")
  const [draft, setDraft] = useState("")
  const [checks, setChecks] = useState([true, true, false, false, false])
  const [confirmDone, setConfirmDone] = useState(false)
  const taskRuns = runs.filter((run) => run.work_item_id === task.id)
  const liveEvents = events.filter(
    (event) => event.run_id && taskRuns.some((run) => run.id === event.run_id),
  )
  const current = taskRuns[0]
  const canComplete = demo && task.lifecycle === "needs_review"
  const [detail, setDetail] = useState<Detail | null>(null)
  const [liveError, setLiveError] = useState("")
  // Se relee al llegar una nota o un cambio de esta tarea; el evento sólo avisa.
  const touches = events.filter(
    (e) =>
      (e.kind === "note.added" &&
        (e.payload as { work_item_id?: string } | null)?.work_item_id === task.id) ||
      (e.kind.startsWith("work_item.") && (e.payload as { id?: string } | null)?.id === task.id),
  ).length
  // biome-ignore lint/correctness/useExhaustiveDependencies: `touches` y la revisión sólo disparan la relectura.
  useEffect(() => {
    if (demo || !call) return
    call("work_items.get", { work_item_id: task.id })
      .then(setDetail)
      .catch((e: unknown) => setLiveError(e instanceof Error ? e.message : String(e)))
  }, [demo, call, task.id, task.revision, touches])
  async function post() {
    const text = draft.trim()
    if (!text) return
    if (demo || !call) {
      onAddNote(text)
      setDraft("")
      return
    }
    try {
      await call("notes.add", { ...mutationMeta(), work_item_id: task.id, content_markdown: text })
      setDraft("")
      setLiveError("")
    } catch (e) {
      setLiveError(e instanceof Error ? e.message : String(e))
    }
  }
  const daemonNotes = detail?.notes ?? []
  return (
    <div className="page inspector-page">
      <aside className="task-properties">
        <Button variant="ghost" icon={ArrowLeft} onClick={onBack}>
          Board
        </Button>
        <dl>
          <dt>Key</dt>
          <dd className="mono">{task.display_id}</dd>
          <dt>Kind</dt>
          <dd>{demo ? "Feature" : "No disponible"}</dd>
          <dt>Status</dt>
          <dd>
            <Status state={task.visual_state} />
          </dd>
          <dt>Lifecycle</dt>
          <dd>{task.lifecycle}</dd>
          <dt>Priority</dt>
          <dd>{demo ? "High" : "No disponible"}</dd>
          <dt>Assignee</dt>
          <dd>{details?.assignee ?? "Unassigned"}</dd>
          <dt>Repo</dt>
          <dd>{details?.repo ?? "No disponible"}</dd>
          <dt>Labels</dt>
          <dd className="tags">
            {details?.labels.map((label) => (
              <span key={label} className="tag">
                {label}
              </span>
            ))}
          </dd>
        </dl>
        <section>
          <h3>Budget</h3>
          <p className="mono">{formatCost(current)}</p>
          {demo && (
            <>
              <progress value={current?.total_cost_micro_usd ?? 0} max={10_000_000} />
              <Hint>Ejemplo · cap de $10.00, no aplicado al daemon.</Hint>
            </>
          )}
        </section>
        <section>
          <h3>Git anchor</h3>
          {demo ? (
            <>
              <code>
                <GitBranch size={12} /> keel/{task.display_id}-auth-retry
              </code>
              <p className="mono muted">base 3e1d9c0 · main</p>
              <p className="mono wrap">.keel/worktrees/{task.display_id}-a9</p>
            </>
          ) : (
            <Hint>El protocolo aún no entrega el manifest de worktrees.</Hint>
          )}
        </section>
        {!demo && call && <LiveTaskActions task={task} runs={taskRuns} call={call} onRun={onRun} />}
        <section>
          <h3>Human review</h3>
          <Button icon={ShieldCheck} disabled={!canComplete} onClick={() => setConfirmDone(true)}>
            Approve & close
          </Button>
          {!demo && <Hint>El cierre humano (needs_review → done) aún no tiene comando.</Hint>}
        </section>
      </aside>
      <section className="task-main">
        <div className="breadcrumbs">
          <button type="button" onClick={onBack}>
            {demo ? "keel-api" : "Board"}
          </button>
          <ChevronRight size={12} />
          <span className="mono">{task.display_id}</span>
        </div>
        <h1>{task.title}</h1>
        <p className="task-spec">
          {demo
            ? (details?.spec ?? "")
            : detail
              ? detail.spec_markdown || "Sin especificación."
              : "Cargando…"}
        </p>
        {task.lifecycle === "blocked" && (
          <div className="callout" data-state="blocked">
            <strong>Waiting for contract · {details?.contract?.name ?? "dependencia"}</strong>
            <p>
              El consumidor necesita una versión validada en ready_for_mock. La tarea conserva su
              bloqueo.
            </p>
            {demo && <code>checkout_api v1 · draft → ready_for_mock</code>}
          </div>
        )}
        {liveError && (
          <p className="error-banner" role="alert">
            {liveError}
          </p>
        )}
        <Tabs values={taskTabs} active={tab} onChange={setTab} />
        {tab === "Activity" && (
          <>
            <div className="comment-form">
              <span className="avatar">YO</span>
              <input
                aria-label={demo ? "Comentario local" : "Nota para la tarea"}
                placeholder={demo ? "Write a local note…" : "Escribe una nota (queda a tu nombre)…"}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") void post()
                }}
              />
              <Button onClick={() => void post()} disabled={!draft.trim()}>
                Post
              </Button>
            </div>
            {demo && <Hint>Notas de esta sesión · aún no se guardan en el daemon.</Hint>}
            {!demo &&
              daemonNotes.map((note) => {
                const who = actorLabel(note.author)
                return (
                  <article className="activity-row" key={note.id} data-testid="note">
                    <span className="role" data-actor={who.role}>
                      {who.role === "human" ? "human" : who.role === "external" ? "ext" : "agent"}
                    </span>
                    <div>
                      <strong title={note.author}>{who.label}</strong>
                      <p>{note.content_markdown}</p>
                    </div>
                    <time>{new Date(note.created_at).toLocaleTimeString()}</time>
                  </article>
                )
              })}
            {notes.map((note) => (
              <article className="activity-row" key={note.id}>
                <span className="role">human</span>
                <div>
                  <strong>Tú</strong>
                  <p>{note.text}</p>
                </div>
                <time>now</time>
              </article>
            ))}
            {demo
              ? demoActivity.map((entry) => (
                  <article className="activity-row" key={entry.time + entry.actor}>
                    <span className="role">{entry.role}</span>
                    <div>
                      <strong className={entry.role === "human" ? "" : "mono"}>
                        {entry.actor}
                      </strong>
                      <p>{entry.text}</p>
                    </div>
                    <time>{entry.time}</time>
                  </article>
                ))
              : liveEvents.length
                ? liveEvents.flatMap((event) => {
                    const s = summarizeEvent(event)
                    if (!s || event.kind === "note.added") return []
                    return [
                      <article className="activity-row" key={event.event_seq}>
                        <span className="mono muted">#{event.event_seq}</span>
                        <div>
                          <strong>{s.title}</strong>
                          {s.detail && <p className="mono text-block">{s.detail}</p>}
                        </div>
                        <time>{new Date(event.received_at).toLocaleTimeString()}</time>
                      </article>,
                    ]
                  })
                : daemonNotes.length === 0 && (
                    <Empty title="Sin actividad de ejecución">
                      Arranca un run desde el panel de la izquierda.
                    </Empty>
                  )}
          </>
        )}
        {tab === "Plan" &&
          (demo ? (
            <div className="plan-document">
              <h2>Plan rev 2 · contrato congelado</h2>
              <div className="change-stepper">
                {["Brief", "Design", "Implement", "Review", "Canon"].map((step, i) => (
                  <span key={step} className={i < 3 ? "complete" : ""}>
                    {i < 2 ? "✓" : i + 1} {step}
                  </span>
                ))}
              </div>
              <section className="callout">
                <h3>A · Implement & test</h3>
                <p>Frontend engineer and QA engineer · disjoint file scopes.</p>
                <code>src/auth/client.ts · src/http/retry.ts</code>
              </section>
              <section className="callout">
                <h3>B · Adversarial review</h3>
                <p>Cross-model reviewer, read-only · after A.</p>
              </section>
              <section className="callout">
                <h3>C · Human gate & integration</h3>
                <p>
                  Review evidence, approve diff, integrate branch and promote canonical decisions.
                </p>
              </section>
              <Hint>Plan ilustrativo del canvas; no ejecuta workers.</Hint>
            </div>
          ) : (
            <Empty title="Plan aún no disponible">Hace falta el endpoint de lectura del DAG.</Empty>
          ))}
        {tab === "Checklist" &&
          (demo ? (
            <div className="checklist">
              {[
                "Inspect refreshToken callers",
                "Define bounded retry contract",
                "Implement jittered backoff",
                "Run independent regression checks",
                "Attach review evidence",
              ].map((label, index) => (
                <label key={label}>
                  <input
                    type="checkbox"
                    checked={checks[index] ?? false}
                    onChange={(e) =>
                      setChecks((old) =>
                        old.map((value, i) => (i === index ? e.target.checked : value)),
                      )
                    }
                  />
                  {label}
                </label>
              ))}
              <Hint>Checklist local de ejemplo.</Hint>
            </div>
          ) : (
            <Empty title="Sin checklist">El snapshot no entrega criterios de aceptación.</Empty>
          ))}
        {tab === "Evidence" &&
          (demo ? (
            <div className="evidence">
              <div className="callout" data-state="succeeded">
                <ShieldCheck size={18} />
                <strong>QA · PASS</strong>
                <p>Fixture de ejemplo · reviewer independiente</p>
              </div>
              {[
                "vitest · 21 passed, 0 failed",
                "typecheck · no errors",
                "auth-client-before-after.png",
              ].map((label) => (
                <div className="evidence-row" key={label}>
                  <FileText size={16} />
                  <span>{label}</span>
                  <span className="mono muted">base 3e1d9c0</span>
                </div>
              ))}
            </div>
          ) : (
            <Empty title="Sin evidencia publicada">
              Las afirmaciones del agente requieren verificación independiente.
            </Empty>
          ))}
        {tab === "Notes" && (
          <>
            <h2>Session notes</h2>
            <div className="comment-form">
              <MessageSquare size={15} />
              <textarea
                aria-label="Nueva nota"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder="Decisiones, preguntas y siguientes pasos…"
              />
              <Button onClick={() => void post()} disabled={!draft.trim()}>
                Add note
              </Button>
            </div>
            {!demo &&
              daemonNotes.map((note) => (
                <p className="note" key={note.id}>
                  <strong title={note.author}>{actorLabel(note.author).label}: </strong>
                  {note.content_markdown}
                </p>
              ))}
            {demo && notes.length
              ? notes.map((note) => (
                  <p className="note" key={note.id}>
                    {note.text}
                  </p>
                ))
              : (demo || daemonNotes.length === 0) && <Empty title="Sin notas" />}
            {demo && <Hint>Las notas son locales y se reinician al recargar.</Hint>}
          </>
        )}
        {tab === "Diff" &&
          (demo ? (
            <>
              <div className="diff-heading">
                <FileCode2 size={15} />
                src/auth/client.ts <span className="added">+14</span>
                <span className="deleted">−3</span>
              </div>
              <pre className="diff">
                {demoDiff.split("\n").map((line) => (
                  <span
                    className={
                      line.startsWith("+") ? "added" : line.startsWith("-") ? "deleted" : ""
                    }
                    key={line}
                  >
                    {line}
                    {"\n"}
                  </span>
                ))}
              </pre>
              <Hint>Diff ilustrativo · no se está leyendo tu repositorio.</Hint>
            </>
          ) : (
            <Empty title="Diff no disponible">El daemon todavía no implementa diff.read.</Empty>
          ))}
      </section>
      <aside className="task-runs">
        <header>
          Runs <span className="mono muted">{taskRuns.length}</span>
        </header>
        {taskRuns.map((run) => (
          <button type="button" className="run-card" key={run.id} onClick={() => onRun(run)}>
            <span>
              <strong className="mono">{run.id}</strong>
              <Status state={run.visual_state} />
            </span>
            <p>
              {run.purpose} · {demo ? "implementer → tester → reviewer" : "provider runtime"}
            </p>
            <small className="mono">{formatCost(run)}</small>
            {run.end_reason && <p className="deleted">{run.end_reason}</p>}
          </button>
        ))}
        {taskRuns.length === 0 && <Hint>Sin runs para esta tarea.</Hint>}
      </aside>
      {confirmDone && (
        <Modal title="Cerrar tarea revisada" onClose={() => setConfirmDone(false)}>
          <p>
            Confirma que revisaste la evidencia y el diff de <strong>{task.display_id}</strong>.
            Esta acción humana cerrará la tarea de ejemplo.
          </p>
          <div className="modal-actions">
            <Button onClick={() => setConfirmDone(false)}>Volver</Button>
            <Button
              variant="primary"
              icon={Check}
              onClick={() => {
                onUpdate({
                  ...task,
                  lifecycle: "done",
                  board_status: "completed",
                  visual_state: "succeeded",
                  revision: task.revision + 1,
                })
                setConfirmDone(false)
              }}
            >
              Confirmar cierre
            </Button>
          </div>
        </Modal>
      )}
    </div>
  )
}
