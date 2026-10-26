/**
 * ADR-0025 §4: el broker necesita una contraseña o una frase que no está guardada
 * (método `ask`). Se pregunta aquí, en cualquier pantalla; el valor va al daemon, que
 * se lo da a ssh o al driver, y nunca al agente ni a un evento.
 */
import type { EventNotification } from "@keel/core"
import { KeyRound } from "lucide-react"
import { type FormEvent, useState } from "react"
import { mutationMeta } from "./client.js"
import { Button, Hint, Modal } from "./ui.js"
import type { useWorkspace } from "./useWorkspace.js"

type Call = ReturnType<typeof useWorkspace>["call"]
type Prompt = {
  prompt_id: string
  connection_name: string
  environment: string
  what: "password" | "passphrase"
  text: string
}

export function SecretPrompts({ events, call }: { events: EventNotification[]; call: Call }) {
  const [done, setDone] = useState<Set<string>>(new Set())
  const resolved = new Set(
    events
      .filter((e) => e.kind === "secret.prompt_resolved")
      .map((e) => String((e.payload as { prompt_id?: string }).prompt_id)),
  )
  const open = events
    .filter((e) => e.kind === "secret.prompt_requested")
    .map((e) => e.payload as Prompt)
    .filter((p) => !resolved.has(p.prompt_id) && !done.has(p.prompt_id))
  const p = open[0]
  if (!p) return null
  return (
    <PromptModal
      key={p.prompt_id}
      p={p}
      call={call}
      onDone={() => setDone((s) => new Set([...s, p.prompt_id]))}
    />
  )
}

function PromptModal({ p, call, onDone }: { p: Prompt; call: Call; onDone: () => void }) {
  const [value, setValue] = useState("")
  const [remember, setRemember] = useState<"once" | "session" | "vault">("session")
  const [error, setError] = useState("")
  const label = p.what === "password" ? "Contraseña" : "Frase de la llave"
  async function send(e: FormEvent | null, cancel = false) {
    e?.preventDefault()
    setError("")
    try {
      await call("secrets.prompt_answer", {
        ...mutationMeta(),
        prompt_id: p.prompt_id,
        ...(cancel ? { cancel: true } : { value, remember }),
      })
      onDone()
    } catch (x) {
      setError(x instanceof Error ? x.message : String(x))
    }
  }
  return (
    <Modal title={`${label} de ${p.connection_name}`} onClose={() => void send(null, true)}>
      <form onSubmit={(e) => void send(e)} className="secret-prompt" data-testid="secret-prompt">
        <p className="muted">
          <KeyRound size={13} /> {p.text || "ssh la pide para entrar."} Keel no lee la llave ni se
          la da al agente: sólo se la pasa a ssh.
          {p.environment === "prod" ? " Es producción." : ""}
        </p>
        <input
          type="password"
          aria-label={label}
          data-autofocus
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
        <fieldset className="remember">
          {(
            [
              ["once", "Sólo esta vez"],
              ["session", "Recordar hasta cerrar Keel"],
              ["vault", "Guardar en el vault"],
            ] as const
          ).map(([v, t]) => (
            <label key={v}>
              <input
                type="radio"
                name="remember"
                checked={remember === v}
                onChange={() => setRemember(v)}
              />{" "}
              {t}
            </label>
          ))}
        </fieldset>
        {error && <p className="error">{error}</p>}
        <Hint>Si no contestas, la operación del agente se niega al vencer el tiempo.</Hint>
        <div className="modal-actions">
          <Button onClick={() => void send(null, true)}>Cancelar</Button>
          <button type="submit" className="button primary" disabled={!value}>
            Conectar
          </button>
        </div>
      </form>
    </Modal>
  )
}
