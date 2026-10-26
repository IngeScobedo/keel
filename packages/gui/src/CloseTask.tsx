/**
 * ADR-0027: cerrar a mano una tarea hecha fuera de Keel (una PR, un hotfix), con su
 * motivo y su evidencia. Queda como evidencia de la tarea, a nombre de quien la cerró.
 */
import { type FormEvent, useState } from "react"
import { mutationMeta } from "./client.js"
import type { WorkItem } from "./model.js"
import { Button, Hint, Modal } from "./ui.js"
import type { useWorkspace } from "./useWorkspace.js"

type Call = ReturnType<typeof useWorkspace>["call"]

export function CloseTask({
  task,
  call,
  onClose,
}: {
  task: WorkItem
  call: Call
  onClose: () => void
}) {
  const [reason, setReason] = useState("")
  const [url, setUrl] = useState("")
  const [text, setText] = useState("")
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)
  const urlOk = url.trim() === "" || /^https?:\/\/\S+$/.test(url.trim())
  const ready = reason.trim().length >= 3 && urlOk && (url.trim() !== "" || text.trim().length >= 3)
  async function submit(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError("")
    try {
      await call("work_items.close", {
        ...mutationMeta(task.revision),
        work_item_id: task.id,
        reason: reason.trim(),
        evidence: {
          ...(url.trim() ? { url: url.trim() } : {}),
          ...(text.trim() ? { text: text.trim() } : {}),
        },
      })
      onClose()
    } catch (x) {
      setError(x instanceof Error ? x.message : String(x))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Modal title={`Cerrar ${task.display_id}`} onClose={onClose}>
      <form onSubmit={(e) => void submit(e)} className="conn-form" data-testid="close-task">
        <p className="muted">
          <strong>{task.title}</strong> pasa a Done sin revisión en Keel. El motivo y la evidencia
          quedan en la tarea, a tu nombre.
        </p>
        <label>
          Motivo
          <input
            aria-label="Motivo del cierre"
            data-autofocus
            placeholder="Se hizo fuera de Keel con la PR…"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </label>
        <label>
          Enlace (PR, commit, ticket)
          <input
            aria-label="Enlace de la evidencia"
            className="mono"
            placeholder="https://github.com/…/pull/126"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
          />
        </label>
        {!urlOk && <p className="error">El enlace tiene que empezar con http:// o https://.</p>}
        <label>
          O dónde está el trabajo
          <textarea
            aria-label="Texto de la evidencia"
            rows={3}
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
        </label>
        <Hint>Hace falta el motivo y un enlace o un texto.</Hint>
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        <div className="modal-actions">
          <Button onClick={onClose}>Cancelar</Button>
          <button type="submit" className="button primary" disabled={!ready || busy}>
            Cerrar la tarea
          </button>
        </div>
      </form>
    </Modal>
  )
}
