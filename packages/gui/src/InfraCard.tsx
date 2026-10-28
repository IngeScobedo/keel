/**
 * Terraform, Ansible y SSH como tarjetas en vivo (ADR-0031 §5): el árbol de recursos con
 * su estado, la matriz host × tarea y el comando con su salida. Lo que llega del broker
 * ya viene redactado; aquí sólo se pinta.
 */
import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronRight,
  Loader2,
  Server,
  TerminalSquare,
  X,
} from "lucide-react"
import { useEffect, useState } from "react"
import { clock, duration } from "./chat-model.js"
import { ArtifactView } from "./Evidence.js"
import { type HostRow, headCounts, type InfraRun, type TfRow } from "./infra-model.js"
import type { useWorkspace } from "./useWorkspace.js"

type Call = ReturnType<typeof useWorkspace>["call"]

const TAG: Record<string, string> = {
  "terraform:plan": "TF PLAN",
  "terraform:apply": "TF APPLY",
  "ansible:check": "ANSIBLE CHECK",
  "ansible:apply": "ANSIBLE DEPLOY",
  "ssh:run": "SSH",
}
const SYMBOL: Record<TfRow["action"], string> = {
  create: "+",
  update: "~",
  delete: "-",
  replace: "±",
  read: "·",
  "no-op": "·",
}
const ACTION: Record<TfRow["action"], string> = {
  create: "se creará",
  update: "en sitio",
  delete: "se destruye",
  replace: "se reemplaza",
  read: "lectura",
  "no-op": "sin cambio",
}
const DOING: Record<TfRow["action"], string> = {
  create: "Creando",
  update: "Cambiando",
  delete: "Destruyendo",
  replace: "Reemplazando",
  read: "Leyendo",
  "no-op": "",
}
const DONE: Record<TfRow["action"], string> = {
  create: "Creado",
  update: "Cambiado",
  delete: "Destruido",
  replace: "Reemplazado",
  read: "Leído",
  "no-op": "Sin cambio",
}

function useNow(live: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!live) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [live])
  return now
}

export function InfraCard({ r, call }: { r: InfraRun; call?: Call }) {
  const running = r.state === "running"
  const now = useNow(running)
  // Abierta mientras corre, si falló o si es algo que se va a aprobar; cerrada al terminar bien.
  const [open, setOpen] = useState(r.mode === "plan" || r.mode === "check" || r.state !== "done")
  useEffect(() => {
    if (r.state === "failed") setOpen(true)
  }, [r.state])
  const [raw, setRaw] = useState(false)
  const prod = r.environment === "prod"
  const time = running ? clock(r.started_at, now) : duration(r.duration_ms)
  return (
    <div className="infra-card" data-state={r.state} data-tool={r.tool} data-testid="infra-card">
      <button
        type="button"
        className="infra-head"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className={`infra-tag ${r.tool}`}>{TAG[`${r.tool}:${r.mode}`] ?? r.tool}</span>
        <span className="infra-title">
          <strong>{r.connection}</strong>
          {r.title && r.title !== r.connection && <span className="mono"> · {r.title}</span>}
        </span>
        {prod && <span className="infra-env prod">PROD</span>}
        {headCounts(r).map((c) => (
          <span key={c.label} className={`infra-count ${c.tone}`}>
            {c.label}
          </span>
        ))}
        <span className="infra-time mono">{time}</span>
        <StateIcon state={r.state} />
        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
      </button>
      {r.destructive.length > 0 && (
        <p className="infra-banner danger" role="alert">
          <AlertTriangle size={13} /> Destruye o reemplaza {r.destructive.length} recurso
          {r.destructive.length === 1 ? "" : "s"}: {r.destructive.slice(0, 3).join(", ")}
          {r.destructive.length > 3 ? "…" : ""}
        </p>
      )}
      {r.tool === "ansible" && r.mode === "check" && r.unpreviewed > 0 && (
        <p className="infra-banner warn">
          <AlertTriangle size={13} /> El check no corre comandos: {r.unpreviewed} tarea
          {r.unpreviewed === 1 ? "" : "s"} sólo se verán al desplegar.
        </p>
      )}
      {!open && r.summary && <p className="infra-summary">{r.summary}</p>}
      {open && (
        <div className="infra-body">
          {r.tool === "terraform" && <Resources r={r} />}
          {r.tool === "ansible" && <Fleet r={r} />}
          {r.tool === "ssh" && <Command r={r} call={call} />}
          {Object.keys(r.outputs).length > 0 && (
            <dl className="infra-outputs">
              {Object.entries(r.outputs).map(([k, v]) => (
                <div key={k}>
                  <dt className="mono">{k}</dt>
                  <dd className="mono">{v}</dd>
                </div>
              ))}
            </dl>
          )}
          {r.errors.map((e) => (
            <p key={e} className="infra-error mono">
              {e}
            </p>
          ))}
          <footer className="infra-foot">
            {r.summary && <span>{r.summary}</span>}
            {r.commit && <span className="mono">commit {r.commit.slice(0, 8)}</span>}
            {r.plan_sha256 && <span className="mono">plan {r.plan_sha256.slice(0, 10)}</span>}
            {r.output_ref && call && r.tool !== "ssh" && (
              <button type="button" className="button ghost" onClick={() => setRaw((v) => !v)}>
                {raw ? "Ocultar salida" : "Ver salida completa"}
              </button>
            )}
          </footer>
          {raw && r.output_ref && call && (
            <ArtifactView call={call} artifactRef={r.output_ref} title="Salida completa" />
          )}
        </div>
      )}
    </div>
  )
}

function StateIcon({ state }: { state: InfraRun["state"] }) {
  if (state === "running")
    return <Loader2 size={14} className="infra-spin" aria-label="corriendo" />
  if (state === "failed") return <X size={14} className="infra-bad" aria-label="falló" />
  return <Check size={14} className="infra-ok" aria-label="terminó" />
}

/** Terraform: el árbol de recursos; cada renglón cambia de estado mientras se aplica. */
function Resources({ r }: { r: InfraRun }) {
  const rows = r.resources.filter((x) => x.action !== "no-op" && x.action !== "read")
  if (rows.length === 0)
    return <p className="muted">{r.state === "running" ? "Leyendo el estado…" : "Sin cambios."}</p>
  return (
    <ul className="infra-resources">
      {rows.map((x) => (
        <li key={x.address} data-action={x.action} data-status={x.status}>
          <span className="infra-symbol mono">[{SYMBOL[x.action]}]</span>
          <span className="infra-address mono">{x.address}</span>
          <span className="infra-resource-state">
            {x.status === "planned" && ACTION[x.action]}
            {(x.status === "started" || x.status === "progress") && (
              <>
                <Loader2 size={12} className="infra-spin" /> {DOING[x.action]}
                {x.elapsed !== null ? ` (${x.elapsed} s)` : "…"}
              </>
            )}
            {x.status === "complete" && (
              <>
                <Check size={12} className="infra-ok" /> {DONE[x.action]}
                {x.elapsed !== null ? ` (${x.elapsed} s)` : ""}
              </>
            )}
            {x.status === "errored" && (
              <>
                <X size={12} className="infra-bad" /> Falló
              </>
            )}
          </span>
          {(x.attrs.length > 0 || x.sensitive_changed > 0 || x.message) && (
            <ul className="infra-attrs mono">
              {x.attrs.map((a) => (
                <li key={a.key}>
                  └ {a.key}: <span className="before">{a.before ?? "—"}</span> →{" "}
                  <span className="after">{a.after ?? "(conocido al aplicar)"}</span>
                </li>
              ))}
              {x.sensitive_changed > 0 && (
                <li className="muted">
                  └ {x.sensitive_changed} atributo{x.sensitive_changed === 1 ? "" : "s"} sensible
                  {x.sensitive_changed === 1 ? "" : "s"} (oculto
                  {x.sensitive_changed === 1 ? "" : "s"})
                </li>
              )}
              {x.message && <li className="infra-error">{x.message}</li>}
            </ul>
          )}
        </li>
      ))}
    </ul>
  )
}

/** Ansible: un renglón por host con sus contadores y dónde va o dónde tronó. */
function Fleet({ r }: { r: InfraRun }) {
  return (
    <>
      {r.state === "running" && (
        <p className="infra-progress">
          <Loader2 size={12} className="infra-spin" /> {r.task ?? "Preparando…"}
          {r.tasks > 0 && <span className="muted mono"> · tarea {r.tasks}</span>}
        </p>
      )}
      <table className="infra-fleet">
        <thead>
          <tr>
            <th>Host</th>
            <th>OK</th>
            <th>Cambios</th>
            <th>Fallos</th>
            <th>Estado</th>
          </tr>
        </thead>
        <tbody>
          {r.hosts.map((h) => (
            <tr key={h.name} data-host-state={hostState(h, r.state)}>
              <td>
                <span className="infra-dot" />
                <span className="mono">{h.name}</span>
                {h.connection && <span className="muted"> · {h.connection}</span>}
              </td>
              <td className="mono">{h.ok}</td>
              <td className="mono">{h.changed}</td>
              <td className="mono">{h.failed + h.unreachable}</td>
              <td>{hostLine(h, r.state)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {r.hosts
        .filter((h) => h.error)
        .map((h) => (
          <div key={h.name} className="infra-host-error">
            <strong>
              Error en {h.name} · {h.error?.task}
            </strong>
            {h.error?.msg && <pre className="mono">{h.error.msg}</pre>}
          </div>
        ))}
    </>
  )
}

function hostState(h: HostRow, run: InfraRun["state"]): "ok" | "running" | "failed" | "waiting" {
  if (h.failed > 0 || h.unreachable > 0) return "failed"
  if (run === "running") return h.last ? "running" : "waiting"
  return "ok"
}

function hostLine(h: HostRow, run: InfraRun["state"]): string {
  if (h.unreachable > 0) return `✖ Inalcanzable${h.error?.task ? ` en ${h.error.task}` : ""}`
  if (h.failed > 0) return `✖ Falló en: ${h.error?.task ?? "?"}`
  if (run === "running") return h.task ? `▶ ${h.task}` : "esperando…"
  return "✓ Completado"
}

/** SSH: el comando, dónde corrió, su exit y la salida guardada. */
function Command({ r, call }: { r: InfraRun; call?: Call | undefined }) {
  return (
    <>
      <p className="infra-command mono">
        <TerminalSquare size={13} /> {r.title}
      </p>
      <p className="infra-server muted">
        <Server size={12} /> {r.server}
        {r.exit_code !== null && (
          <span className={`infra-exit ${r.exit_code === 0 ? "ok" : "bad"}`}>
            exit {r.exit_code}
          </span>
        )}
      </p>
      {r.output_ref && call && (
        <ArtifactView call={call} artifactRef={r.output_ref} title="Salida" />
      )}
    </>
  )
}
