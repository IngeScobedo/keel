/**
 * ADR-0043: GitHub dentro de Keel, por el `gh` del humano. La sesión y su inicio (el de
 * `gh`), la PR como tarjeta viva con su merge humano atado al sha que se vio, y los
 * runs de Actions paso a paso. Canvas: página 21.
 */
import type { GithubPr, GithubRun, GithubRunDetail, GithubStatus } from "@keel/core"
import {
  Check,
  Copy,
  ExternalLink,
  GitBranch,
  GitMerge,
  GitPullRequest,
  LogIn,
  RefreshCw,
  RotateCcw,
  Workflow,
} from "lucide-react"
import { useCallback, useEffect, useRef, useState } from "react"
import { mutationMeta } from "./client.js"
import { Button, Hint, Modal } from "./ui.js"
import type { useWorkspace } from "./useWorkspace.js"
import "./GitHub.css"

type Call = ReturnType<typeof useWorkspace>["call"]
type LoginState = { state: string; code: string | null; url: string | null; message: string | null }

/** El motivo de `gh` en un error del daemon: sin instalar, sin sesión, rechazado… */
export function ghKind(e: unknown): string | null {
  const d = (e as { rpc?: { details?: { gh?: string } } })?.rpc?.details
  return d?.gh ?? null
}
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e))

/** Abre una página de GitHub en el navegador del humano (lo hace el daemon). */
export function openGithub(call: Call, url: string) {
  void call("github.open", { url }).catch(() => {})
}

export function clockOf(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`
}

function useNow(active: boolean) {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    if (!active) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [active])
  return now
}

/** Pide algo cada `ms` mientras `active`; el primer pedido es inmediato. */
function usePoll(fn: () => Promise<void>, ms: number, active: boolean) {
  const ref = useRef(fn)
  ref.current = fn
  useEffect(() => {
    void ref.current()
    if (!active) return
    const t = setInterval(() => void ref.current(), ms)
    return () => clearInterval(t)
  }, [ms, active])
}

// --- la sesión ----------------------------------------------------------------------

/** Ajustes → Integraciones → GitHub (ADR-0043 §1). */
export function GithubSettings({ call }: { call: Call }) {
  const [status, setStatus] = useState<GithubStatus | null>(null)
  const [error, setError] = useState("")
  const [login, setLogin] = useState(false)
  const [protocol, setProtocol] = useState<"ssh" | "https">("ssh")
  const refresh = useCallback(
    async (fresh = false) => {
      setError("")
      try {
        setStatus(await call("github.status", fresh ? { fresh: true } : {}))
      } catch (e) {
        setError(msg(e))
      }
    },
    [call],
  )
  useEffect(() => {
    void refresh()
  }, [refresh])
  const account = status?.gh.accounts.find((a) => a.host === "github.com" && a.active)
  return (
    <section className="plugins gh-settings" data-testid="github-settings">
      <h2>
        <GitPullRequest size={15} /> GitHub
      </h2>
      <p className="muted">
        GitHub va por tu <code>gh</code>: el inicio de sesión es el de gh y el token queda en su
        almacén. Keel nunca lo lee ni lo guarda.
      </p>
      {error && <p className="deleted">{error}</p>}
      {status && !status.gh.installed && (
        <div className="gh-card" data-state="missing">
          <p>
            No encontré <code>gh</code>. Instálalo (<code>brew install gh</code>,{" "}
            <code>winget install GitHub.cli</code> o el paquete de tu distro) y vuelve a revisar.
          </p>
          <Button icon={RefreshCw} onClick={() => void refresh(true)}>
            Revisar otra vez
          </Button>
        </div>
      )}
      {status?.gh.installed && (
        <div className="gh-card" data-state={status.gh.ready ? "ready" : "login"}>
          <dl>
            <dt>gh</dt>
            <dd className="mono">{status.gh.version}</dd>
            <dt>Cuenta</dt>
            <dd className="mono" data-testid="github-account">
              {account?.ok ? `${account.login} · ${account.host}` : "sin sesión"}
            </dd>
            {account?.ok && (
              <>
                <dt>Protocolo de git</dt>
                <dd className="mono">{account.git_protocol ?? "—"}</dd>
                <dt>Scopes</dt>
                <dd className="mono">{account.scopes.join(", ") || "—"}</dd>
              </>
            )}
            {status.repo && (
              <>
                <dt>Repo del proyecto</dt>
                <dd className="mono">{status.repo.name_with_owner}</dd>
                <dt>Merge permitido</dt>
                <dd className="mono">{status.repo.merge_methods.join(" · ")}</dd>
              </>
            )}
            {status.repo_error && (
              <>
                <dt>Repo del proyecto</dt>
                <dd className="muted">{status.repo_error}</dd>
              </>
            )}
          </dl>
          <div className="gh-actions">
            {!status.gh.ready && (
              <fieldset className="segmented" aria-label="Protocolo de git">
                {(["ssh", "https"] as const).map((p) => (
                  <button
                    key={p}
                    type="button"
                    className="mono"
                    aria-pressed={protocol === p}
                    onClick={() => setProtocol(p)}
                  >
                    {p}
                  </button>
                ))}
              </fieldset>
            )}
            <Button
              variant={status.gh.ready ? "default" : "primary"}
              icon={LogIn}
              onClick={() => setLogin(true)}
            >
              {status.gh.ready ? "Iniciar sesión con otra cuenta" : "Iniciar sesión en GitHub"}
            </Button>
            <Button icon={RefreshCw} onClick={() => void refresh(true)}>
              Actualizar
            </Button>
          </div>
        </div>
      )}
      {login && (
        <GithubLogin
          call={call}
          protocol={protocol}
          onClose={() => setLogin(false)}
          onDone={() => {
            setLogin(false)
            void refresh(true)
          }}
        />
      )}
    </section>
  )
}

/**
 * El inicio de sesión de `gh`: Keel lo lanza y muestra el código que `gh` imprime. Se
 * autoriza en github.com; al terminar `gh`, Keel relee su estado.
 */
export function GithubLogin({
  call,
  protocol = "ssh",
  onClose,
  onDone,
}: {
  call: Call
  protocol?: "ssh" | "https"
  onClose: () => void
  onDone: () => void
}) {
  const [s, setS] = useState<LoginState | null>(null)
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState("")
  useEffect(() => {
    call("github.login", { ...mutationMeta(), git_protocol: protocol })
      .then(setS)
      .catch((e) => setError(msg(e)))
  }, [call, protocol])
  const waiting = s?.state === "waiting"
  usePoll(
    async () => {
      if (!waiting) return
      const next = await call("github.login_state", {})
      setS(next)
      if (next.state === "done") onDone()
    },
    1000,
    waiting,
  )
  return (
    <Modal
      title="Iniciar sesión en GitHub"
      onClose={() => {
        if (waiting) void call("github.login_cancel", { ...mutationMeta() }).catch(() => {})
        onClose()
      }}
    >
      <div className="gh-login" data-testid="github-login">
        {error && <p className="deleted">{error}</p>}
        {s?.state === "failed" && <p className="deleted">{s.message}</p>}
        {waiting && !s.code && <p className="muted">Esperando a gh…</p>}
        {waiting && s.code && (
          <>
            <p className="muted">1. Copia este código de un solo uso:</p>
            <div className="gh-code">
              <span className="mono" data-testid="github-login-code">
                {s.code}
              </span>
              <Button
                icon={copied ? Check : Copy}
                onClick={() => {
                  void navigator.clipboard?.writeText(s.code ?? "")
                  setCopied(true)
                }}
              >
                {copied ? "Copiado" : "Copiar"}
              </Button>
            </div>
            <p className="muted">2. Ábrelo y pégalo; autoriza con tu cuenta.</p>
            <Button
              variant="primary"
              icon={ExternalLink}
              onClick={() => openGithub(call, s.url ?? "https://github.com/login/device")}
            >
              Abrir github.com/login/device
            </Button>
            <p className="gh-waiting">
              <span className="gh-spin" /> gh espera a que autorices en el navegador…
            </p>
          </>
        )}
        <Hint>
          Lo corre tu gh (<code>gh auth login --web</code>). Al terminar, Keel relee{" "}
          <code>gh auth status</code>; el token nunca pasa por Keel.
        </Hint>
      </div>
    </Modal>
  )
}

/** Lo que una tarjeta muestra cuando `gh` no puede: instalarlo o iniciar sesión. */
function NeedsGh({ call, kind, onReady }: { call: Call; kind: string; onReady: () => void }) {
  const [login, setLogin] = useState(false)
  return (
    <div className="gh-needs" data-testid="github-needs-login">
      <GitPullRequest size={14} />
      <span>
        {kind === "missing"
          ? "Para ver esto en Keel hace falta gh instalado."
          : "Para ver la PR y sus checks aquí, inicia sesión en GitHub con gh."}
      </span>
      {kind !== "missing" && (
        <Button variant="primary" icon={LogIn} onClick={() => setLogin(true)}>
          Iniciar sesión en GitHub
        </Button>
      )}
      {login && (
        <GithubLogin
          call={call}
          onClose={() => setLogin(false)}
          onDone={() => {
            setLogin(false)
            onReady()
          }}
        />
      )}
    </div>
  )
}

// --- la PR ------------------------------------------------------------------------------

const METHOD_LABEL = { merge: "Merge commit", squash: "Squash and merge", rebase: "Rebase" }
const DONE = new Set(["completed", "success", "failure", "neutral", "skipped", "cancelled"])

function checkTone(c: GithubPr["checks"][number]): "running" | "succeeded" | "failed" | "queued" {
  if (c.status !== "completed") return c.status === "queued" ? "queued" : "running"
  return c.conclusion === "success" || c.conclusion === "neutral" || c.conclusion === "skipped"
    ? "succeeded"
    : "failed"
}

/**
 * La PR viva (ADR-0043 §3): estado, checks, review y archivos; merge con el método que
 * el repo permite, atado a la cabeza que se ve. Se refresca cada 5 s mientras algo corre.
 */
export function PrCard({ call, number, branch }: { call: Call; number?: number; branch?: string }) {
  const [pr, setPr] = useState<GithubPr | null>(null)
  const [needs, setNeeds] = useState<string | null>(null)
  const [error, setError] = useState("")
  const [methods, setMethods] = useState<("merge" | "squash" | "rebase")[]>([])
  const [method, setMethod] = useState<"merge" | "squash" | "rebase">("merge")
  const [subject, setSubject] = useState("")
  const [deleteBranch, setDeleteBranch] = useState(false)
  const [busy, setBusy] = useState(false)
  const [nonce, setNonce] = useState(0)
  const ref = number ?? branch
  const load = useCallback(async () => {
    if (ref === undefined) return
    try {
      const next = await call("github.pr", number ? { number } : { branch: branch as string })
      setPr(next)
      setNeeds(null)
    } catch (e) {
      const k = ghKind(e)
      if (k === "missing" || k === "unauthenticated") setNeeds(k)
      else setError(msg(e))
    }
  }, [call, number, branch, ref])
  useEffect(() => {
    call("github.status", {})
      .then((s) => {
        const m = s.repo?.merge_methods ?? ["merge", "squash", "rebase"]
        setMethods(m)
        setMethod((cur) => (m.includes(cur) ? cur : (m[0] ?? "merge")))
        setDeleteBranch(s.repo?.delete_branch_on_merge ?? false)
      })
      .catch(() => {})
  }, [call])
  const open = pr?.state === "open"
  const running = pr?.checks.some((c) => !DONE.has(c.status)) ?? false
  // biome-ignore lint/correctness/useExhaustiveDependencies: nonce fuerza la relectura tras iniciar sesión.
  useEffect(() => {
    void load()
  }, [load, nonce])
  usePoll(load, running ? 5_000 : 60_000, open || pr === null)
  useEffect(() => {
    if (pr && !subject) setSubject(`${pr.title} (#${pr.number})`)
  }, [pr, subject])
  if (needs)
    return (
      <div className="gh-pr" data-testid="github-pr">
        <NeedsGh call={call} kind={needs} onReady={() => setNonce((n) => n + 1)} />
      </div>
    )
  if (!pr) return error ? <p className="deleted">{error}</p> : null
  const failed = pr.checks.filter((c) => checkTone(c) === "failed").length
  async function merge() {
    if (!pr) return
    setBusy(true)
    setError("")
    try {
      setPr(
        await call("github.pr_merge", {
          ...mutationMeta(),
          number: pr.number,
          method,
          head_sha: pr.head_sha,
          ...(method !== "rebase" && subject.trim() ? { subject: subject.trim() } : {}),
          delete_branch: deleteBranch,
        }),
      )
    } catch (e) {
      setError(msg(e))
      if (ghKind(e) === "rejected") await load()
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="gh-pr" data-testid="github-pr" data-state={pr.state}>
      <header className="gh-pr-head">
        {pr.state === "merged" ? (
          <GitMerge size={16} className="gh-merged" />
        ) : (
          <GitPullRequest size={16} className={pr.state === "open" ? "gh-open" : "gh-closed"} />
        )}
        <span className="mono muted">#{pr.number}</span>
        <strong className="gh-pr-title">{pr.title}</strong>
        <span className={`gh-pill gh-${pr.state}`}>
          {pr.draft
            ? "borrador"
            : { open: "abierta", merged: "mergeada", closed: "cerrada" }[pr.state]}
        </span>
        <span className="gh-spacer" />
        <span className="mono muted gh-branches">
          {pr.base} ← {pr.head}
        </span>
        <button
          type="button"
          className="ui-icon-button"
          aria-label="Abrir en GitHub"
          title="Abrir en GitHub"
          onClick={() => openGithub(call, pr.url)}
        >
          <ExternalLink size={13} />
        </button>
      </header>
      <div className="gh-pr-body">
        <ul className="gh-checks" aria-label="Checks">
          {pr.checks.length === 0 && <li className="muted">Sin checks en esta PR.</li>}
          {pr.checks.map((c) => (
            <li key={`${c.workflow}:${c.name}`} data-tone={checkTone(c)}>
              <span className={`gh-dot ${checkTone(c)}`} />
              <span>
                {c.workflow ? `${c.workflow} · ` : ""}
                {c.name}
              </span>
              <span className="gh-spacer" />
              <CheckClock c={c} />
            </li>
          ))}
          <li data-tone={pr.review_decision === "approved" ? "succeeded" : "queued"}>
            <span
              className={`gh-dot ${pr.review_decision === "approved" ? "succeeded" : pr.review_decision === "changes_requested" ? "failed" : "queued"}`}
            />
            <span>Review</span>
            <span className="gh-spacer" />
            <span className="mono muted">
              {pr.review_decision === "approved"
                ? "aprobada"
                : pr.review_decision === "changes_requested"
                  ? "cambios pedidos"
                  : pr.review_decision === "review_required"
                    ? "falta review"
                    : "sin review requerido"}
            </span>
          </li>
          {open && (
            <li>
              <span
                className={`gh-dot ${pr.mergeable === "conflicting" ? "failed" : "succeeded"}`}
              />
              <span>
                {pr.mergeable === "conflicting"
                  ? `Conflictos con ${pr.base}`
                  : pr.mergeable === "unknown"
                    ? "GitHub calcula si hay conflictos…"
                    : `Sin conflictos con ${pr.base}`}
              </span>
            </li>
          )}
        </ul>
        <div className="gh-files">
          <p className="muted">
            {pr.files.length} archivo{pr.files.length === 1 ? "" : "s"} ·{" "}
            <span className="added">+{pr.additions}</span>{" "}
            <span className="removed">−{pr.deletions}</span>
          </p>
          {pr.files.slice(0, 6).map((f) => (
            <p key={f.path} className="gh-file mono">
              <span title={f.path}>{f.path.split("/").at(-1)}</span>
              <span className="added">+{f.additions}</span>
              <span className="removed">−{f.deletions}</span>
            </p>
          ))}
          {pr.files.length > 6 && <p className="muted">+{pr.files.length - 6} más</p>}
        </div>
      </div>
      {open && (
        <footer className="gh-merge" data-testid="github-merge">
          <div className="gh-merge-row">
            <fieldset className="segmented" aria-label="Método de merge">
              {methods.map((m) => (
                <button
                  key={m}
                  type="button"
                  aria-pressed={method === m}
                  onClick={() => setMethod(m)}
                >
                  {METHOD_LABEL[m]}
                </button>
              ))}
            </fieldset>
            {method !== "rebase" && (
              <input
                aria-label="Título del commit de merge"
                className="mono gh-subject"
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
              />
            )}
            <label className="gh-check">
              <input
                type="checkbox"
                checked={deleteBranch}
                onChange={(e) => setDeleteBranch(e.target.checked)}
              />
              Borrar la rama
            </label>
            <Button
              variant="primary"
              icon={GitMerge}
              disabled={busy || pr.mergeable === "conflicting" || pr.draft}
              onClick={() => void merge()}
            >
              {busy ? "Mergeando…" : METHOD_LABEL[method]}
            </Button>
          </div>
          <p className="muted gh-note">
            Atado a <span className="mono">{pr.head_sha.slice(0, 7)}</span>: si alguien empuja a la
            rama, GitHub lo rechaza y la tarjeta muestra la nueva cabeza.
            {running ? " El CI sigue corriendo." : ""}
            {failed ? ` ${failed} check${failed === 1 ? "" : "s"} fallaron.` : ""}
          </p>
          {error && <p className="deleted">{error}</p>}
        </footer>
      )}
      {pr.state === "merged" && (
        <footer className="gh-merge done">
          <p>
            <Check size={13} /> Mergeada en <span className="mono">{pr.base}</span>
            {pr.merged_by ? ` por ${pr.merged_by}` : ""}.
          </p>
          <CommitRuns call={call} branch={pr.base} since={pr.merged_at} />
        </footer>
      )}
    </div>
  )
}

function CheckClock({ c }: { c: GithubPr["checks"][number] }) {
  const live = c.status !== "completed" && c.started_at !== null
  const now = useNow(live)
  if (c.started_at && c.completed_at)
    return (
      <span className="mono muted">
        {clockOf(Date.parse(c.completed_at) - Date.parse(c.started_at))}
      </span>
    )
  if (live && c.started_at)
    return <span className="mono gh-live">{clockOf(now - Date.parse(c.started_at))}</span>
  return <span className="mono muted">{c.status === "queued" ? "en cola" : ""}</span>
}

// --- Actions ---------------------------------------------------------------------------

/**
 * Los runs de un commit o de una rama desde un momento: lo que disparó un merge o una
 * promoción. Se buscan cada 5 s hasta que aparecen (GitHub tarda unos segundos).
 */
export function CommitRuns({
  call,
  sha,
  branch,
  since,
}: {
  call: Call
  sha?: string
  branch?: string
  since?: string | null
}) {
  const [runs, setRuns] = useState<GithubRun[] | null>(null)
  const [tries, setTries] = useState(0)
  const load = useCallback(async () => {
    try {
      const r = await call(
        "github.runs",
        sha ? { commit: sha } : { branch: branch as string, limit: 10 },
      )
      const after = since ? Date.parse(since) - 5_000 : 0
      setRuns(r.runs.filter((x) => Date.parse(x.created_at) >= after))
    } catch {
      setRuns([])
    } finally {
      setTries((n) => n + 1)
    }
  }, [call, sha, branch, since])
  // GitHub tarda unos segundos en registrar el run: se busca durante 30 s.
  const searching = (runs?.length ?? 0) === 0 && tries < 6
  usePoll(load, 5_000, searching)
  if (!runs) return null
  if (runs.length === 0)
    return (
      <p className="muted gh-note">
        {searching
          ? "Buscando los workflows que dispara…"
          : "Ningún workflow de GitHub Actions corre por esto."}
      </p>
    )
  return (
    <div className="gh-runs">
      {runs.map((r) => (
        <PipelineCard key={r.id} call={call} runId={r.id} />
      ))}
    </div>
  )
}

/** Un run de Actions, paso a paso (ADR-0043 §5). El log llega al terminar el paso. */
export function PipelineCard({ call, runId }: { call: Call; runId: number }) {
  const [run, setRun] = useState<GithubRunDetail | null>(null)
  const [tail, setTail] = useState<string | null>(null)
  const [error, setError] = useState("")
  const done = run?.status === "completed"
  const load = useCallback(async () => {
    try {
      setRun(await call("github.run", { id: runId }))
    } catch (e) {
      setError(msg(e))
    }
  }, [call, runId])
  usePoll(load, 5_000, !done)
  useEffect(() => {
    if (done && run?.conclusion === "failure" && tail === null)
      call("github.run_log", { id: runId })
        .then((r) => setTail(r.tail))
        .catch(() => setTail(""))
  }, [call, done, run?.conclusion, runId, tail])
  const now = useNow(!done)
  if (!run) return error ? <p className="deleted">{error}</p> : null
  const elapsed = (done ? Date.parse(run.updated_at) : now) - Date.parse(run.created_at)
  const tone = !done ? "running" : run.conclusion === "success" ? "succeeded" : "failed"
  const progress = run.typical_ms ? Math.min(0.97, elapsed / run.typical_ms) : null
  return (
    <div className="gh-run" data-testid="github-run" data-tone={tone}>
      <header>
        <Workflow size={15} className={`gh-tone-${tone}`} />
        <strong>{run.workflow}</strong>
        <span className={`gh-pill gh-${tone}`}>
          {!done
            ? "corriendo"
            : run.conclusion === "success"
              ? "verde"
              : (run.conclusion ?? "terminó")}
        </span>
        <span className="mono muted gh-trigger">
          {run.event} · {run.branch} · {run.sha.slice(0, 7)}
          {run.title ? ` · ${run.title}` : ""}
        </span>
        <span className="gh-spacer" />
        <span className={`mono ${done ? "muted" : "gh-live"}`}>
          {clockOf(elapsed)}
          {run.typical_ms ? ` · suele ${clockOf(run.typical_ms)}` : ""}
        </span>
      </header>
      {!done && progress !== null && (
        <div className="gh-progress">
          <span style={{ width: `${Math.round(progress * 100)}%` }} />
        </div>
      )}
      {run.jobs.map((j) => (
        <ol key={j.name} className="gh-steps" aria-label={`Pasos de ${j.name}`}>
          {run.jobs.length > 1 && (
            <li className="gh-job">
              <GitBranch size={12} /> {j.name}
            </li>
          )}
          {j.steps
            .filter(
              (s) => !/^(Set up job|Complete job|Post )/.test(s.name) || s.conclusion === "failure",
            )
            .map((s) => {
              const st =
                s.status !== "completed"
                  ? s.status === "in_progress"
                    ? "running"
                    : "queued"
                  : s.conclusion === "success" || s.conclusion === "skipped"
                    ? "succeeded"
                    : "failed"
              return (
                <li key={s.name} data-tone={st}>
                  <span className={`gh-dot ${st}`} />
                  <span>{s.name}</span>
                  <span className="gh-spacer" />
                  <StepClock
                    started={s.started_at}
                    completed={s.completed_at}
                    live={st === "running"}
                  />
                </li>
              )
            })}
        </ol>
      ))}
      {tail && (
        <pre className="gh-log" data-testid="github-run-log">
          {tail}
        </pre>
      )}
      <footer>
        <span className="muted gh-note">
          {done
            ? run.conclusion === "failure"
              ? "Falló: arriba, el final del log del paso."
              : "Terminó."
            : "El log de un paso llega al terminar."}
        </span>
        {done && run.conclusion === "failure" && (
          <Button
            icon={RotateCcw}
            onClick={() =>
              void call("github.run_rerun", { ...mutationMeta(), id: run.id, failed_only: true })
                .then(() => {
                  setTail(null)
                  return load()
                })
                .catch((e) => setError(msg(e)))
            }
          >
            Volver a correr lo fallido
          </Button>
        )}
        <Button icon={ExternalLink} onClick={() => openGithub(call, run.url)}>
          Ver en GitHub
        </Button>
      </footer>
      {error && <p className="deleted">{error}</p>}
    </div>
  )
}

function StepClock({
  started,
  completed,
  live,
}: {
  started: string | null
  completed: string | null
  live: boolean
}) {
  const now = useNow(live)
  if (!started) return <span className="mono muted" />
  const end = completed ? Date.parse(completed) : now
  return (
    <span className={`mono ${live ? "gh-live" : "muted"}`}>
      {clockOf(end - Date.parse(started))}
    </span>
  )
}

/**
 * ADR-0043 §3: el agente pidió mergear una PR. Se decide con la PR viva a la vista:
 * aprobar ejecuta el merge atado a la cabeza que vio el agente; si cambió, falla.
 */
export function MergeRequestCard({
  call,
  approvalId,
  operationHash,
  input,
  decision,
}: {
  call: Call
  approvalId: string
  operationHash: string
  input: unknown
  decision: "approved" | "denied" | "expired" | null
}) {
  const m = (input ?? {}) as {
    number?: number
    method?: "merge" | "squash" | "rebase"
    head_sha?: string
    subject?: string
    why?: string
  }
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  async function resolve(d: "approve_once" | "deny") {
    setBusy(true)
    setError("")
    try {
      await call("approvals.resolve", {
        ...mutationMeta(),
        approval_id: approvalId,
        operation_hash: operationHash,
        decision: d,
      })
    } catch (e) {
      setError(msg(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div
      className="gh-merge-request"
      data-testid="github-merge-request"
      data-decision={decision ?? "pending"}
    >
      <p className="gh-merge-ask">
        <GitMerge size={14} /> El agente pide <strong>{METHOD_LABEL[m.method ?? "merge"]}</strong>{" "}
        de la PR #{m.number}
        {m.head_sha ? (
          <>
            {" "}
            en <span className="mono">{m.head_sha.slice(0, 7)}</span>
          </>
        ) : null}
        {m.why ? `: ${m.why}` : ""}
      </p>
      {m.number !== undefined && <PrCard call={call} number={m.number} />}
      {decision === null ? (
        <div className="gh-actions">
          <Button
            variant="primary"
            icon={GitMerge}
            disabled={busy}
            onClick={() => void resolve("approve_once")}
          >
            Aprobar y mergear
          </Button>
          <Button disabled={busy} onClick={() => void resolve("deny")}>
            Rechazar
          </Button>
        </div>
      ) : (
        <p className="muted gh-note">
          {decision === "approved"
            ? "Aprobaste el merge."
            : decision === "denied"
              ? "Lo rechazaste."
              : "Caducó."}
        </p>
      )}
      {error && <p className="deleted">{error}</p>}
    </div>
  )
}
