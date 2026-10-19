import type { EventNotification } from "@keel/core"
import { Check, Database, Hand, Inbox as InboxIcon, ShieldAlert, TriangleAlert } from "lucide-react"
import { useEffect, useState } from "react"
import { approvalCanResolve } from "./approvals.js"
import { type Approval, makeDemoApprovals } from "./fixtures.js"
import { formatCost, type Run, type WorkItem } from "./model.js"
import { Button, Empty, Hint, Modal, Status } from "./ui.js"

export function Inbox({
  demo,
  tasks,
  runs,
  events,
  onTask,
}: {
  demo: boolean
  tasks: WorkItem[]
  runs: Run[]
  events: EventNotification[]
  onTask: (task: WorkItem) => void
}) {
  const [approvals, setApprovals] = useState(makeDemoApprovals)
  const [category, setCategory] = useState("Everything")
  const [selected, setSelected] = useState("approval-terraform")
  const [confirmation, setConfirmation] = useState<{
    approval: Approval
    decision: "approved" | "denied"
  } | null>(null)
  const [now, setNow] = useState(Date.now)
  const [error, setError] = useState("")
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])
  const reviews = tasks.filter((task) => task.lifecycle === "needs_review")
  const pending = approvals.filter((item) => item.state === "pending")
  const liveApprovals = events.filter((event) => event.kind === "approval.requested")
  function resolve() {
    if (!confirmation) return
    const latest = approvals.find((approval) => approval.id === confirmation.approval.id)
    if (
      !latest ||
      latest.hash !== confirmation.approval.hash ||
      !approvalCanResolve(latest, Date.now(), demo)
    ) {
      setError("La aprobación expiró o cambió. Vuelve a revisar la operación.")
      setConfirmation(null)
      return
    }
    setApprovals((old) =>
      old.map((approval) =>
        approval.id === latest.id ? { ...approval, state: confirmation.decision } : approval,
      ),
    )
    setConfirmation(null)
    setError("")
  }
  return (
    <div className="page">
      <div className="toolbar">
        <h1>Inbox</h1>
        <span className="mono muted">
          {demo ? pending.length : liveApprovals.length} approvals · {reviews.length} reviews
        </span>
      </div>
      <div className="inbox-layout">
        <aside className="inbox-nav">
          {["Everything", "Approvals", "Reviews"].map((item) => (
            <button
              type="button"
              key={item}
              className={category === item ? "active" : ""}
              onClick={() => setCategory(item)}
            >
              {item === "Approvals" ? (
                <Hand size={15} />
              ) : item === "Reviews" ? (
                <ShieldAlert size={15} />
              ) : (
                <InboxIcon size={15} />
              )}
              <span>{item}</span>
              <small>
                {item === "Reviews" ? reviews.length : demo ? pending.length : liveApprovals.length}
              </small>
            </button>
          ))}
        </aside>
        <section className="inbox-main">
          {error && (
            <p className="error-banner" role="alert">
              {error}
            </p>
          )}
          {category !== "Reviews" && (
            <>
              <header className="section-header">
                <TriangleAlert size={12} className="amber" />
                <strong>Approvals</strong>
                <span className="muted">agents waiting for you</span>
              </header>
              {demo ? (
                approvals.map((approval) => {
                  const expired = approval.expiresAt <= now
                  const state = expired && approval.state === "pending" ? "expired" : approval.state
                  return (
                    <article
                      className={`approval ${selected === approval.id ? "expanded" : ""}`}
                      key={approval.id}
                    >
                      <button
                        type="button"
                        className="approval-heading"
                        aria-expanded={selected === approval.id}
                        onClick={() =>
                          setSelected((old) => (old === approval.id ? "" : approval.id))
                        }
                      >
                        <Database size={14} className="amber" />
                        <strong>{approval.title}</strong>
                        <span className="mono muted">
                          {state === "pending"
                            ? `${Math.ceil((approval.expiresAt - now) / 60_000)}m`
                            : state}
                        </span>
                      </button>
                      {selected === approval.id && (
                        <div className="approval-body">
                          <div className="tags">
                            <span className="role">infra · provider example</span>
                            <span className="tag">{approval.target}</span>
                            <span className="tag">ask</span>
                          </div>
                          <h3>BLAST RADIUS</h3>
                          <p className="mono">{approval.impact}</p>
                          <h3>DRY RUN OUTPUT</h3>
                          <pre>{approval.operation}</pre>
                          <div className="approval-actions">
                            <Button
                              variant="primary"
                              disabled={!approvalCanResolve(approval, now, demo)}
                              onClick={() => setConfirmation({ approval, decision: "approved" })}
                            >
                              Approve once
                            </Button>
                            <span className="mono muted">{approval.hash}</span>
                            <Button
                              variant="danger"
                              disabled={!approvalCanResolve(approval, now, demo)}
                              onClick={() => setConfirmation({ approval, decision: "denied" })}
                            >
                              Deny
                            </Button>
                          </div>
                          {expired && (
                            <Hint>Expired · requiere una nueva solicitud y un nuevo dry run.</Hint>
                          )}
                        </div>
                      )}
                    </article>
                  )
                })
              ) : (
                <>
                  <div className="callout" data-state="waiting_human">
                    <strong>Detalle de operación pendiente</strong>
                    <p>
                      El protocolo todavía no entrega target, parámetros y scope completos. La
                      aprobación permanecerá retenida hasta poder mostrar ese detalle.
                    </p>
                  </div>
                  {liveApprovals.map((event) => (
                    <article className="approval" key={event.event_seq}>
                      <div className="approval-body">
                        <strong>
                          {event.kind} · #{event.event_seq}
                        </strong>
                        <pre>{JSON.stringify(event.payload, null, 2)}</pre>
                        <Button disabled>Approve once</Button>
                      </div>
                    </article>
                  ))}
                  {liveApprovals.length === 0 && (
                    <Empty title="Sin solicitudes recibidas">
                      Las solicitudes nuevas aparecerán al recibir eventos del daemon.
                    </Empty>
                  )}
                </>
              )}
            </>
          )}
          {category !== "Approvals" && (
            <>
              <header className="section-header">
                <ShieldAlert size={13} className="amber" />
                <strong>Reviews</strong>
                <span className="muted">tasks in needs_review</span>
              </header>
              {reviews.map((task) => (
                <div className="review-row" key={task.id}>
                  <Status state={task.visual_state} dot />
                  <span className="mono muted">{task.display_id}</span>
                  <strong>{task.title}</strong>
                  <span className="mono muted">
                    {formatCost(runs.find((run) => run.work_item_id === task.id))}
                  </span>
                  <Button onClick={() => onTask(task)}>Open review</Button>
                </div>
              ))}
              {reviews.length === 0 && <Empty title="Sin tareas para revisar" />}
            </>
          )}
          <Hint>
            {demo
              ? "Prototipo: las decisiones cambian sólo estos ejemplos; no ejecutan operaciones."
              : "Los eventos recibidos no sustituyen una lista durable de aprobaciones pendientes."}
          </Hint>
        </section>
      </div>
      {confirmation && (
        <Modal
          title={
            confirmation.decision === "approved"
              ? "Confirmar aprobación única"
              : "Denegar operación"
          }
          onClose={() => setConfirmation(null)}
        >
          <p>
            <strong>{confirmation.approval.title}</strong>
          </p>
          <dl className="confirmation-scope">
            <dt>Target</dt>
            <dd className="mono">{confirmation.approval.target}</dd>
            <dt>Scope</dt>
            <dd>{confirmation.approval.scope}</dd>
            <dt>Operation hash</dt>
            <dd className="mono">{confirmation.approval.hash}</dd>
            <dt>Expires</dt>
            <dd>{new Date(confirmation.approval.expiresAt).toLocaleTimeString()}</dd>
          </dl>
          <pre>{confirmation.approval.operation}</pre>
          <Hint>Decisión sobre el ejemplo del diseño · no ejecuta infraestructura.</Hint>
          <div className="modal-actions">
            <Button onClick={() => setConfirmation(null)}>Volver</Button>
            <Button
              variant={confirmation.decision === "approved" ? "primary" : "danger"}
              icon={Check}
              onClick={resolve}
            >
              {confirmation.decision === "approved" ? "Confirmar approve once" : "Confirmar deny"}
            </Button>
          </div>
        </Modal>
      )}
    </div>
  )
}
