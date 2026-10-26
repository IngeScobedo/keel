import type {
  AgentScopeSchema,
  ApprovalViewSchema,
  PairingViewSchema,
  RunRequestViewSchema,
} from "@keel/core"
import { Check, Hand, Inbox as InboxIcon, Play, Plug, ShieldAlert } from "lucide-react"
import { useCallback, useEffect, useState } from "react"
import { ApprovalActions } from "./ApprovalActions.js"
import { mutationMeta } from "./client.js"
import { GitPlanCard } from "./GitPlanCard.js"
import { actorLabel, formatCost, type Run, type WorkItem } from "./model.js"
import { Button, Empty, Hint, Modal, Status } from "./ui.js"
import type { useWorkspace } from "./useWorkspace.js"

type Approval = ReturnType<typeof ApprovalViewSchema.parse>
type Pairing = ReturnType<typeof PairingViewSchema.parse>
type RunRequest = ReturnType<typeof RunRequestViewSchema.parse>
type Scope = ReturnType<typeof AgentScopeSchema.parse>
type Call = ReturnType<typeof useWorkspace>["call"]

const SCOPES: { id: Scope; label: string }[] = [
  { id: "tasks:read", label: "Leer tareas" },
  { id: "tasks:write", label: "Crear tareas" },
  { id: "notes:write", label: "Escribir notas" },
  { id: "runs:request", label: "Pedir runs" },
  { id: "resources:use", label: "Usar conexiones (BD, SSH, Terraform)" },
]

/** Lo que el humano necesita ver para decidir: el comando, si lo hay; si no, la entrada. */
function operationText(operation: unknown): { tool: string; body: string } {
  const op = (operation ?? {}) as { tool?: string; input?: Record<string, unknown> }
  const input = op.input ?? {}
  const body =
    typeof input.command === "string"
      ? input.command
      : typeof input.file_path === "string"
        ? String(input.file_path)
        : JSON.stringify(input, null, 2)
  return { tool: op.tool ?? "?", body }
}

/**
 * Inbox contra el daemon: aprobaciones del gate, sesiones externas que piden
 * entrar (ADR-0009 §4) y peticiones de run de agentes (§5). Todo se lee del
 * daemon; los eventos sólo avisan de que hay que volver a leer.
 */
export function LiveInbox({
  call,
  tick,
  tasks,
  runs,
  onTask,
  onRun,
}: {
  call: Call
  tick: number
  tasks: WorkItem[]
  runs: Run[]
  onTask: (task: WorkItem) => void
  onRun: (run: Run) => void
}) {
  const [approvals, setApprovals] = useState<Approval[]>([])
  const [pairings, setPairings] = useState<Pairing[]>([])
  const [requests, setRequests] = useState<RunRequest[]>([])
  const [category, setCategory] = useState("Everything")
  const [error, setError] = useState("")
  const [now, setNow] = useState(Date.now)
  const [pairForm, setPairForm] = useState<{
    pairing: Pairing
    task: string
    scopes: Scope[]
  } | null>(null)
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async () => {
    try {
      const [a, p, r] = await Promise.all([
        call("approvals.list", {}),
        call("session.pairings_list", { state: "pending" }),
        call("runs.requests_list", { state: "pending" }),
      ])
      setApprovals(a.approvals)
      setPairings(p.pairings)
      setRequests(r.requests)
    } catch (e) {
      setError(e instanceof Error ? e.message : "No se pudo leer el Inbox")
    }
  }, [call])
  // biome-ignore lint/correctness/useExhaustiveDependencies: `tick` sólo dispara la relectura.
  useEffect(() => {
    void refresh()
  }, [refresh, tick])
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])

  async function act(work: () => Promise<unknown>) {
    if (busy) return
    setBusy(true)
    setError("")
    try {
      await work()
    } catch (e) {
      setError(e instanceof Error ? e.message : "El daemon rechazó la acción")
    } finally {
      setBusy(false)
      await refresh()
    }
  }
  const task = (id: string | null) => tasks.find((t) => t.id === id)
  const reviews = tasks.filter((t) => t.lifecycle === "needs_review")
  const live = approvals.filter((a) => !a.expires_at || Date.parse(a.expires_at) > now)
  const counts: Record<string, number> = {
    Everything: live.length + pairings.length + requests.length + reviews.length,
    Approvals: live.length,
    Sessions: pairings.length,
    Requests: requests.length,
    Reviews: reviews.length,
  }
  const show = (c: string) => category === "Everything" || category === c

  return (
    <div className="page">
      <div className="toolbar">
        <h1>Inbox</h1>
        <span className="mono muted">{counts.Everything} pendientes</span>
      </div>
      <div className="inbox-layout">
        <aside className="inbox-nav">
          {(["Everything", "Approvals", "Sessions", "Requests", "Reviews"] as const).map((c) => (
            <button
              type="button"
              key={c}
              className={category === c ? "active" : ""}
              onClick={() => setCategory(c)}
            >
              {c === "Approvals" ? (
                <Hand size={15} />
              ) : c === "Sessions" ? (
                <Plug size={15} />
              ) : c === "Requests" ? (
                <Play size={15} />
              ) : c === "Reviews" ? (
                <ShieldAlert size={15} />
              ) : (
                <InboxIcon size={15} />
              )}
              <span>{c}</span>
              <small>{counts[c]}</small>
            </button>
          ))}
        </aside>
        <section className="inbox-main">
          {error && (
            <p className="error-banner" role="alert">
              {error}
            </p>
          )}
          {show("Approvals") && (
            <>
              <header className="section-header">
                <Hand size={12} className="amber" />
                <strong>Aprobaciones</strong>
                <span className="muted">el agente espera por ti; el tiempo nunca aprueba</span>
              </header>
              {live.map((approval) => {
                const op = operationText(approval.operation)
                const left = approval.expires_at
                  ? Math.max(0, Math.ceil((Date.parse(approval.expires_at) - now) / 1000))
                  : null
                const t = task(approval.work_item_id)
                return (
                  <article className="approval expanded" key={approval.id} data-testid="approval">
                    <div className="approval-heading">
                      <strong>{op.tool}</strong>
                      <span className="mono muted">{t?.display_id ?? approval.work_item_id}</span>
                      <span className="mono muted">
                        {left === null ? "sin límite" : `${left}s`}
                      </span>
                    </div>
                    <div className="approval-body">
                      {op.tool === "git.plan" ? (
                        <GitPlanCard
                          input={(approval.operation as { input?: unknown } | null)?.input}
                          approvalId={approval.id}
                          operationHash={approval.operation_hash}
                          call={call}
                          pending
                        />
                      ) : (
                        <>
                          <pre>{op.body}</pre>
                          <p className="mono muted">
                            run {approval.run_id} · hash {approval.operation_hash.slice(0, 12)}
                          </p>
                          {/* Una pregunta del agente se contesta con sus opciones, en el chat (ADR-0020 §7). */}
                          {op.tool === "AskUserQuestion" ||
                          op.tool === "ExitPlanMode" ||
                          op.tool === "stage.gate" ||
                          op.tool === "setup.request" ? (
                            <Button
                              variant="primary"
                              onClick={() => {
                                const r = runs.find((x) => x.id === approval.run_id)
                                if (r) onRun(r)
                              }}
                            >
                              {op.tool === "AskUserQuestion"
                                ? "Contestar en el chat"
                                : op.tool === "stage.gate"
                                  ? "Decidir el gate en el chat"
                                  : op.tool === "setup.request"
                                    ? "Ver lo que pide en el chat"
                                    : "Revisar el plan en el chat"}
                            </Button>
                          ) : (
                            <ApprovalActions
                              approvalId={approval.id}
                              operationHash={approval.operation_hash}
                              tool={op.tool}
                              input={(approval.operation as { input?: unknown } | null)?.input}
                              call={call}
                              onDone={() => void refresh()}
                            />
                          )}
                        </>
                      )}
                    </div>
                  </article>
                )
              })}
              {live.length === 0 && <Empty title="Sin aprobaciones pendientes" />}
            </>
          )}
          {show("Sessions") && (
            <>
              <header className="section-header">
                <Plug size={12} className="amber" />
                <strong>Sesiones externas</strong>
                <span className="muted">agentes abiertos a mano que piden entrar</span>
              </header>
              {pairings.map((pairing) => (
                <article className="approval expanded" key={pairing.id} data-testid="pairing">
                  <div className="approval-heading">
                    <strong>{pairing.client_name}</strong>
                    <span className="mono">código {pairing.code}</span>
                  </div>
                  <div className="approval-body">
                    <p className="mono muted">{pairing.cwd ?? "sin cwd"}</p>
                    <Hint>
                      Compara el código con el que muestra el agente. Aprobar le da identidad de
                      agente, nunca la tuya.
                    </Hint>
                    <div className="approval-actions">
                      <Button
                        variant="primary"
                        disabled={busy}
                        onClick={() =>
                          setPairForm({ pairing, task: "", scopes: SCOPES.map((s) => s.id) })
                        }
                      >
                        Revisar y aprobar
                      </Button>
                      <Button
                        variant="danger"
                        disabled={busy}
                        onClick={() =>
                          void act(() =>
                            call("session.pair_resolve", {
                              ...mutationMeta(),
                              pairing_id: pairing.id,
                              decision: "reject",
                            }),
                          )
                        }
                      >
                        Rechazar
                      </Button>
                    </div>
                  </div>
                </article>
              ))}
              {pairings.length === 0 && <Empty title="Ninguna sesión esperando" />}
            </>
          )}
          {show("Requests") && (
            <>
              <header className="section-header">
                <Play size={12} className="amber" />
                <strong>Peticiones de run</strong>
                <span className="muted">un agente pide arrancar trabajo; tú decides</span>
              </header>
              {requests.map((request) => {
                const t = task(request.work_item_id)
                return (
                  <article className="approval expanded" key={request.id} data-testid="run-request">
                    <div className="approval-heading">
                      <strong>
                        {request.purpose} · {t?.display_id ?? request.work_item_id}
                      </strong>
                      <span className="role">{actorLabel(request.requested_by).label}</span>
                    </div>
                    <div className="approval-body">
                      <p>{t?.title}</p>
                      <p>
                        <strong>Motivo:</strong> {request.reason}
                      </p>
                      {request.prompt && <pre>{request.prompt}</pre>}
                      <div className="approval-actions">
                        <Button
                          variant="primary"
                          disabled={busy}
                          onClick={() =>
                            void act(async () => {
                              const done = await call("runs.request_resolve", {
                                ...mutationMeta(),
                                run_request_id: request.id,
                                decision: "approve",
                              })
                              if (done.run) onRun(done.run)
                            })
                          }
                        >
                          Arrancar run
                        </Button>
                        <Button
                          variant="danger"
                          disabled={busy}
                          onClick={() =>
                            void act(() =>
                              call("runs.request_resolve", {
                                ...mutationMeta(),
                                run_request_id: request.id,
                                decision: "reject",
                              }),
                            )
                          }
                        >
                          Rechazar
                        </Button>
                      </div>
                    </div>
                  </article>
                )
              })}
              {requests.length === 0 && <Empty title="Sin peticiones de run" />}
            </>
          )}
          {show("Reviews") && (
            <>
              <header className="section-header">
                <ShieldAlert size={13} className="amber" />
                <strong>Revisiones</strong>
                <span className="muted">tareas en needs_review</span>
              </header>
              {reviews.map((t) => (
                <div className="review-row" key={t.id}>
                  <Status state={t.visual_state} dot />
                  <span className="mono muted">{t.display_id}</span>
                  <strong>{t.title}</strong>
                  <span className="mono muted">
                    {formatCost(runs.find((run) => run.work_item_id === t.id))}
                  </span>
                  <Button onClick={() => onTask(t)}>Abrir</Button>
                </div>
              ))}
              {reviews.length === 0 && <Empty title="Sin tareas para revisar" />}
            </>
          )}
        </section>
      </div>
      {pairForm && (
        <Modal title="Aprobar sesión externa" onClose={() => setPairForm(null)}>
          <p>
            <strong>{pairForm.pairing.client_name}</strong> · código{" "}
            <span className="mono">{pairForm.pairing.code}</span>
          </p>
          <label>
            Tarea vinculada
            <select
              value={pairForm.task}
              onChange={(e) => setPairForm({ ...pairForm, task: e.target.value })}
            >
              <option value="">Sin tarea (sólo lectura del proyecto y crear tareas)</option>
              {tasks.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.display_id} · {t.title}
                </option>
              ))}
            </select>
          </label>
          <fieldset className="scope-list">
            <legend>Permisos</legend>
            {SCOPES.map((s) => (
              <label key={s.id}>
                <input
                  type="checkbox"
                  checked={pairForm.scopes.includes(s.id)}
                  onChange={(e) =>
                    setPairForm({
                      ...pairForm,
                      scopes: e.target.checked
                        ? [...pairForm.scopes, s.id]
                        : pairForm.scopes.filter((x) => x !== s.id),
                    })
                  }
                />
                {s.label} <span className="mono muted">{s.id}</span>
              </label>
            ))}
          </fieldset>
          <Hint>La sesión actúa como agente y su vínculo termina cuando se desconecta.</Hint>
          <div className="modal-actions">
            <Button onClick={() => setPairForm(null)}>Volver</Button>
            <Button
              variant="primary"
              icon={Check}
              disabled={busy || pairForm.scopes.length === 0}
              onClick={() => {
                const f = pairForm
                setPairForm(null)
                void act(() =>
                  call("session.pair_resolve", {
                    ...mutationMeta(),
                    pairing_id: f.pairing.id,
                    decision: "approve",
                    scopes: f.scopes,
                    ...(f.task ? { work_item_id: f.task } : {}),
                  }),
                )
              }}
            >
              Aprobar sesión
            </Button>
          </div>
        </Modal>
      )}
    </div>
  )
}
