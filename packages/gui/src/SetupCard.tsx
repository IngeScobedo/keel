/**
 * ADR-0025 §6: el agente pide lo que le falta (una conexión, un permiso, un plugin o un
 * cambio del perfil). La tarjeta dice qué y por qué; «Configurar» abre el formulario de
 * Keel ya lleno. El agente nunca crea nada ni pasa secretos.
 */
import { Plug } from "lucide-react"
import { useState } from "react"
import { useKeys, useResolve, Waiting } from "./ApprovalCard.js"
import type { Approval } from "./chat-model.js"
import type { useWorkspace } from "./useWorkspace.js"

type Call = ReturnType<typeof useWorkspace>["call"]

export type SetupInput = {
  kind: "connection" | "grant" | "plugin" | "profile"
  why: string
  proposal: Record<string, unknown>
  evidence: string | null
}

const TITLE: Record<SetupInput["kind"], string> = {
  connection: "Pide una conexión",
  grant: "Pide un permiso sobre una conexión",
  plugin: "Pide un plugin",
  profile: "Pide un cambio del perfil",
}

/** Lo que escucha App: abrir Conexiones con el alta llena. */
export const SETUP_EVENT = "keel:setup"
export function openSetup(approvalId: string, input: SetupInput) {
  window.dispatchEvent(
    new CustomEvent(SETUP_EVENT, {
      detail: {
        approval_id: approvalId,
        kind: input.kind,
        proposal: { ...input.proposal, why: input.why },
      },
    }),
  )
}

export function SetupCard({ a, call, active }: { a: Approval; call?: Call; active: boolean }) {
  const input = (a.input ?? {}) as SetupInput
  const { busy, error, resolve } = useResolve(a, call)
  const [asking, setAsking] = useState(false)
  const [why, setWhy] = useState("")
  const pending = a.decision === null
  const configure = () =>
    input.kind === "connection" || input.kind === "grant"
      ? openSetup(a.approval_id, input)
      : void resolve({ decision: "approve_once", setup_result: { note: "listo" } })
  useKeys(active && pending && !!call && !asking, (e) => {
    if (e.key.toLowerCase() !== "y") return
    e.preventDefault()
    configure()
  })
  const rows = Object.entries(input.proposal ?? {}).filter(
    ([, v]) => v !== null && v !== undefined && v !== "",
  )
  return (
    <div className="rc-setup" data-state={a.decision ?? "pending"} data-testid="chat-setup">
      <header>
        <Plug size={15} />
        <strong>{TITLE[input.kind] ?? "Pide algo"}</strong>
        {pending ? (
          <Waiting a={a} />
        ) : (
          <span className="muted rc-step">
            {a.decision === "approved" ? "listo" : a.decision === "denied" ? "no ahora" : "venció"}
          </span>
        )}
      </header>
      <p>{input.why}</p>
      <dl className="rc-setup-kv">
        {rows.map(([k, v]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd className="mono">{typeof v === "string" ? v : JSON.stringify(v)}</dd>
          </div>
        ))}
        {input.evidence && (
          <div>
            <dt>por qué</dt>
            <dd className="mono">{input.evidence}</dd>
          </div>
        )}
      </dl>
      {pending && !asking && (
        <div className="rc-actions">
          <button
            type="button"
            className="button primary"
            disabled={busy || !call}
            onClick={configure}
          >
            {input.kind === "connection" || input.kind === "grant" ? "Configurar" : "Hecho"}{" "}
            <kbd>Y</kbd>
          </button>
          <button
            type="button"
            className="button"
            disabled={busy || !call}
            onClick={() => setAsking(true)}
          >
            No ahora
          </button>
          <span className="muted">el agente no crea nada: propone y tú guardas</span>
        </div>
      )}
      {pending && asking && (
        <form
          className="rc-actions"
          onSubmit={(e) => {
            e.preventDefault()
            void resolve({ decision: "deny", reason: why.trim() || "no ahora" })
          }}
        >
          <input
            aria-label="Por qué no"
            placeholder="Por qué no (el agente lo lee)"
            value={why}
            onChange={(e) => setWhy(e.target.value)}
          />
          <button type="submit" className="button" disabled={busy}>
            Decirle al agente
          </button>
        </form>
      )}
      {error && <p className="error">{error}</p>}
    </div>
  )
}
