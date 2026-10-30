/**
 * ADR-0043 §6: Entregas. Una columna por rama del flujo (development → stage → main):
 * lo que entró y falta promover, el último deploy de cada entorno, las PR abiertas y la
 * siguiente promoción con su gate y el «todavía no, y por qué» arriba. Canvas: página 21.
 */
import type { DeliveryStatus, GithubRun } from "@keel/core"
import { ArrowRight, GitBranch, GitPullRequest, RefreshCw, Rocket, Workflow } from "lucide-react"
import { useCallback, useEffect, useState } from "react"
import { mutationMeta } from "./client.js"
import { CommitRuns, PipelineCard, PrCard } from "./GitHub.js"
import { ago } from "./RunLedger.js"
import { Button, Empty, Hint, Modal } from "./ui.js"
import type { useWorkspace } from "./useWorkspace.js"
import "./Delivery.css"

type Call = ReturnType<typeof useWorkspace>["call"]
type Promotion = DeliveryStatus["promotions"][number]

const entering = (p: Promotion) => p.pending.length

function runTone(r: GithubRun): "running" | "succeeded" | "failed" | "queued" {
  if (r.status !== "completed") return r.status === "queued" ? "queued" : "running"
  return r.conclusion === "success" ? "succeeded" : "failed"
}

export function Delivery({ call }: { call: Call }) {
  const [st, setSt] = useState<DeliveryStatus | null>(null)
  const [error, setError] = useState("")
  const [loading, setLoading] = useState(false)
  const [openPr, setOpenPr] = useState<number | null>(null)
  const [openRun, setOpenRun] = useState<number | null>(null)
  const [promo, setPromo] = useState<Promotion | null>(null)
  const [promoted, setPromoted] = useState<{ sha: string; from: string; to: string } | null>(null)
  const load = useCallback(async () => {
    setLoading(true)
    try {
      setSt(await call("delivery.status", {}))
      setError("")
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [call])
  useEffect(() => {
    void load()
    const t = setInterval(() => void load(), 15_000)
    return () => clearInterval(t)
  }, [load])

  async function confirmFlow() {
    if (!st?.flow) return
    try {
      const view = await call("projects.profile_get", {})
      await call("projects.profile_set", {
        ...mutationMeta(),
        profile: { ...view.profile, flow: st.flow },
      })
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  if (!st)
    return (
      <div className="page delivery-page">
        <div className="toolbar">
          <h1>Entregas</h1>
        </div>
        {error ? <p className="error-banner">{error}</p> : <Hint>Leyendo el flujo…</Hint>}
      </div>
    )
  if (!st.flow)
    return (
      <div className="page delivery-page">
        <div className="toolbar">
          <h1>Entregas</h1>
        </div>
        <Empty title="Este proyecto no tiene un flujo de ramas reconocible">
          Keel lo detecta de .github/workflows y de la historia de merges (PRs y promociones como
          «promueve development a stage»).
        </Empty>
      </div>
    )
  const flow = st.flow
  return (
    <div className="page delivery-page" data-testid="delivery">
      <div className="toolbar">
        <h1>Entregas</h1>
        <span className="muted mono">
          {[flow.work_base, ...flow.promotions.map((p) => p.to)].join(" → ")}
        </span>
        <div className="toolbar-spacer" />
        <Button icon={RefreshCw} disabled={loading} onClick={() => void load()}>
          {loading ? "Actualizando…" : "Actualizar"}
        </Button>
      </div>
      {st.flow_source === "detected" && (
        <div className="delivery-banner" data-testid="delivery-detected">
          <span>
            Flujo detectado: {flow.evidence.slice(0, 3).join(" · ")}. Confírmalo para que Keel lo
            use como regla del proyecto.
          </span>
          <Button variant="primary" onClick={() => void confirmFlow()}>
            Confirmar flujo
          </Button>
        </div>
      )}
      {(st.fetch_error || st.gh_error || error) && (
        <p className="error-banner" role="alert">
          {[
            error,
            st.fetch_error && `git fetch: ${st.fetch_error}`,
            st.gh_error && `GitHub: ${st.gh_error}`,
          ]
            .filter(Boolean)
            .join(" · ")}
        </p>
      )}
      <div className="delivery-cols">
        {st.branches.map((b, i) => {
          const next = st.promotions.find((p) => p.from === b.name) ?? null
          const incoming = st.promotions.find((p) => p.to === b.name) ?? null
          return (
            <section key={b.name} className="delivery-col" data-testid={`delivery-${b.name}`}>
              <header>
                <GitBranch size={15} />
                <strong className="mono">{b.name}</strong>
                <span className="gh-spacer" />
                <span className="muted">{i === 0 ? "base de las PR" : (b.environment ?? "")}</span>
              </header>
              {b.head && (
                <p className="delivery-head mono muted" title={b.head.subject}>
                  {b.head.sha.slice(0, 7)} · {b.head.subject} · {ago(b.head.date)}
                </p>
              )}
              {i === 0 && st.open_prs && (
                <>
                  <h3>PR abiertas hacia {b.name}</h3>
                  {st.open_prs.length === 0 && <Hint>Ninguna.</Hint>}
                  {st.open_prs.map((pr) => {
                    const failed = pr.checks.some(
                      (c) =>
                        c.status === "completed" &&
                        !["success", "neutral", "skipped"].includes(c.conclusion ?? ""),
                    )
                    const running = pr.checks.some((c) => c.status !== "completed")
                    return (
                      <button
                        type="button"
                        key={pr.number}
                        className="delivery-item"
                        onClick={() => setOpenPr(pr.number)}
                      >
                        <span
                          className={`gh-dot ${failed ? "failed" : running ? "running" : "succeeded"}`}
                        />
                        <GitPullRequest size={13} />
                        <span className="delivery-text">
                          #{pr.number} {pr.title}
                        </span>
                        <span className="mono muted">
                          {pr.review_decision === "approved"
                            ? "aprobada"
                            : pr.review_decision === "review_required"
                              ? "falta review"
                              : running
                                ? "CI…"
                                : ""}
                        </span>
                      </button>
                    )
                  })}
                </>
              )}
              {b.runs.length > 0 && (
                <>
                  <h3>{i === 0 ? "Workflows" : "Último deploy"}</h3>
                  {b.runs.map((r) => (
                    <button
                      type="button"
                      key={r.id}
                      className="delivery-item"
                      data-tone={runTone(r)}
                      onClick={() => setOpenRun(r.id)}
                    >
                      <span className={`gh-dot ${runTone(r)}`} />
                      <Workflow size={13} />
                      <span className="delivery-text">
                        {r.workflow} · {r.sha.slice(0, 7)}
                      </span>
                      <span className="mono muted">
                        {r.status === "completed" ? ago(r.updated_at) : "corriendo"}
                      </span>
                    </button>
                  ))}
                </>
              )}
              {next && (
                <>
                  <h3>
                    En {b.name}, sin promover a {next.to}
                  </h3>
                  {next.pending.length === 0 && <Hint>Nada.</Hint>}
                  {next.pending.slice(0, 8).map((c) => (
                    <p key={c.sha} className="delivery-item static">
                      <span className="gh-dot succeeded" />
                      <span className="delivery-text">
                        {c.pr ? `#${c.pr} ` : ""}
                        {c.title}
                      </span>
                      <span className="mono muted">{c.sha.slice(0, 7)}</span>
                    </p>
                  ))}
                  {next.pending.length > 8 && <Hint>+{next.pending.length - 8} más</Hint>}
                </>
              )}
              <div className="gh-spacer" />
              {next && (
                <div
                  className="delivery-gate"
                  data-ready={next.blocked_by.length === 0 || undefined}
                  data-testid={`promote-${next.from}-${next.to}`}
                >
                  {next.blocked_by.length > 0 ? (
                    <p>
                      <strong>Todavía no:</strong> {next.blocked_by.join(" · ")}
                    </p>
                  ) : (
                    <p>
                      Entra{entering(next) === 1 ? "" : "n"} {entering(next)}{" "}
                      {next.pending.some((c) => c.pr)
                        ? "PR"
                        : entering(next) === 1
                          ? "commit"
                          : "commits"}
                      . Al empujar a {next.to}{" "}
                      {next.workflows.length
                        ? `corre ${next.workflows.join(" y ")}`
                        : "no corre ningún workflow"}
                      .
                    </p>
                  )}
                  <Button
                    variant={next.blocked_by.length ? "default" : "primary"}
                    icon={next.environment === "prod" ? Rocket : ArrowRight}
                    disabled={next.blocked_by.length > 0}
                    onClick={() => setPromo(next)}
                  >
                    Promover {next.from} → {next.to}
                  </Button>
                </div>
              )}
              {!next && incoming && (
                <Hint>
                  Lo que entra aquí viene de {incoming.from}
                  {incoming.environment === "prod" ? ", con el gate de producción" : ""}.
                </Hint>
              )}
            </section>
          )
        })}
      </div>
      {promoted && (
        <section className="delivery-after" data-testid="delivery-promoted">
          <p>
            Promoviste {promoted.from} → {promoted.to} ·{" "}
            <span className="mono">{promoted.sha.slice(0, 7)}</span>
          </p>
          <CommitRuns call={call} sha={promoted.sha} />
        </section>
      )}
      {promo && (
        <PromoteDialog
          call={call}
          promo={promo}
          onClose={() => setPromo(null)}
          onDone={(r) => {
            setPromo(null)
            setPromoted(r)
            void load()
          }}
        />
      )}
      {openPr !== null && (
        <Modal title={`PR #${openPr}`} onClose={() => setOpenPr(null)} wide>
          <PrCard call={call} number={openPr} />
        </Modal>
      )}
      {openRun !== null && (
        <Modal title="Workflow" onClose={() => setOpenRun(null)} wide>
          <PipelineCard call={call} runId={openRun} />
        </Modal>
      )}
    </div>
  )
}

/**
 * El plan de la promoción antes de aprobarla: qué entra, qué workflow dispara y con qué
 * mensaje. A producción se confirma escribiendo el nombre de la rama (ADR-0026).
 */
function PromoteDialog({
  call,
  promo,
  onClose,
  onDone,
}: {
  call: Call
  promo: Promotion
  onClose: () => void
  onDone: (r: { sha: string; from: string; to: string }) => void
}) {
  const prod = promo.environment === "prod"
  const [typed, setTyped] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [conflicts, setConflicts] = useState<string[]>([])
  async function go() {
    if (!promo.from_sha || !promo.to_sha) return
    setBusy(true)
    setError("")
    try {
      onDone(
        await call("delivery.promote", {
          ...mutationMeta(),
          from: promo.from,
          to: promo.to,
          from_sha: promo.from_sha,
          to_sha: promo.to_sha,
          ...(prod ? { confirm_prod: true } : {}),
        }),
      )
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      const c = (e as { rpc?: { details?: { conflicts?: string[] } } }).rpc?.details?.conflicts
      setConflicts(c ?? [])
    } finally {
      setBusy(false)
    }
  }
  return (
    <Modal title={`Promover ${promo.from} → ${promo.to}`} onClose={onClose}>
      <div className="delivery-plan" data-testid="promote-dialog">
        <p className="muted">
          Merge de <span className="mono">{promo.from_sha?.slice(0, 7)}</span> en{" "}
          <span className="mono">
            {promo.to} ({promo.to_sha?.slice(0, 7)})
          </span>{" "}
          con el mensaje <span className="mono">«{promo.message}»</span>. Sin checkout: tu copia
          local no se toca. Nunca force push.
        </p>
        <ul>
          {promo.pending.slice(0, 12).map((c) => (
            <li key={c.sha}>
              <span className="mono muted">{c.sha.slice(0, 7)}</span> {c.pr ? `#${c.pr} ` : ""}
              {c.title}
            </li>
          ))}
        </ul>
        <p>
          {promo.workflows.length
            ? `Al empujar a ${promo.to} corre ${promo.workflows.join(" y ")}; lo verás aquí paso a paso.`
            : `Al empujar a ${promo.to} no corre ningún workflow.`}
        </p>
        {prod && (
          <label className="delivery-confirm">
            Es producción. Escribe <strong className="mono">{promo.to}</strong> para confirmar:
            <input
              aria-label="Confirmar rama de producción"
              className="mono"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
            />
          </label>
        )}
        {error && <p className="deleted">{error}</p>}
        {conflicts.length > 0 && (
          <ul className="mono deleted">
            {conflicts.map((f) => (
              <li key={f}>{f}</li>
            ))}
          </ul>
        )}
        <div className="modal-actions">
          <Button onClick={onClose}>Cancelar</Button>
          <Button
            variant="primary"
            icon={prod ? Rocket : ArrowRight}
            disabled={busy || (prod && typed.trim() !== promo.to)}
            onClick={() => void go()}
          >
            {busy ? "Promoviendo…" : `Promover a ${promo.to}`}
          </Button>
        </div>
      </div>
    </Modal>
  )
}
