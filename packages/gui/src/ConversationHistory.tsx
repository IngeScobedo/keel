/**
 * ADR-0035 §1: las conversaciones del proyecto, como `/resume` de Claude Code: la más
 * reciente arriba, se filtra escribiendo, ↑↓ y Enter retoman una. Cada una guarda su
 * sesión, sus notas y sus lotes; empezar otra no arrastra nada.
 */
import type { Methods } from "@keel/core"
import { Check, MessageSquare, Pencil, X } from "lucide-react"
import { useEffect, useMemo, useState } from "react"
import { mutationMeta } from "./client.js"
import { ago } from "./RunLedger.js"
import { Hint, Modal } from "./ui.js"
import type { useWorkspace } from "./useWorkspace.js"
import "./ConversationHistory.css"

type Call = ReturnType<typeof useWorkspace>["call"]
export type ConversationItem = ReturnType<
  (typeof Methods)["conversation.list"]["result"]["parse"]
>["conversations"][number]

/** Los comandos del composer de la conversación, como en Claude Code. */
export const CONVERSATION_COMMANDS = [
  { name: "/resume", hint: "retomar otra conversación" },
  { name: "/clear", hint: "empezar una conversación nueva, sin arrastrar nada" },
  { name: "/rename", hint: "renombrar esta conversación: /rename Título" },
] as const

export type ConversationCommand =
  | { kind: "resume" }
  | { kind: "new" }
  | { kind: "rename"; title: string }

/** `/resume`, `/clear` (o `/new`) y `/rename Título`; cualquier otro texto se manda. */
export function parseCommand(text: string): ConversationCommand | null {
  const m = /^\/(\w+)(?:\s+([\s\S]*))?$/.exec(text.trim())
  if (!m) return null
  const arg = (m[2] ?? "").trim()
  switch (m[1]?.toLowerCase()) {
    case "resume":
    case "historial":
      return { kind: "resume" }
    case "clear":
    case "new":
    case "nueva":
      return { kind: "new" }
    case "rename":
      return arg ? { kind: "rename", title: arg } : null
    default:
      return null
  }
}

/** Debajo del composer, mientras se escribe un comando. */
export function CommandHints({ draft }: { draft: string }) {
  const word = draft.trim().split(/\s/)[0]?.toLowerCase() ?? ""
  const matches = CONVERSATION_COMMANDS.filter((c) => c.name.startsWith(word))
  if (!matches.length) return <Hint>Ese comando no existe aquí; se mandará como texto.</Hint>
  return (
    <ul className="conv-commands" data-testid="conv-commands">
      {matches.map((c) => (
        <li key={c.name}>
          <code>{c.name}</code> <span className="muted">{c.hint}</span>
        </li>
      ))}
    </ul>
  )
}

export function ConversationHistory({
  call,
  current,
  onPick,
  onNew,
  onClose,
}: {
  call: Call
  current: string | null
  onPick: (id: string) => void
  onNew: () => void
  onClose: () => void
}) {
  const [items, setItems] = useState<ConversationItem[] | null>(null)
  const [filter, setFilter] = useState("")
  const [cursor, setCursor] = useState(0)
  const [editing, setEditing] = useState<string | null>(null)
  const [title, setTitle] = useState("")
  const [error, setError] = useState("")
  useEffect(() => {
    call("conversation.list", {})
      .then((r) => setItems(r.conversations))
      .catch((e: Error) => setError(e.message))
  }, [call])
  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase()
    return (items ?? []).filter(
      (c) =>
        !q ||
        c.work_item.title.toLowerCase().includes(q) ||
        c.work_item.display_id.toLowerCase().includes(q),
    )
  }, [items, filter])
  async function rename(id: string) {
    const t = title.trim()
    if (!t) return
    try {
      const w = await call("conversation.rename", {
        ...mutationMeta(),
        conversation_id: id,
        title: t,
      })
      setItems((all) =>
        (all ?? []).map((c) => (c.work_item.id === id ? { ...c, work_item: w } : c)),
      )
      setEditing(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }
  return (
    <Modal title="Conversaciones" onClose={onClose}>
      <div className="conv-history" data-testid="conv-history">
        <input
          aria-label="Buscar conversación"
          placeholder="Buscar por título…"
          data-autofocus
          value={filter}
          onChange={(e) => {
            setFilter(e.target.value)
            setCursor(0)
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault()
              setCursor((i) => Math.min(shown.length - 1, i + 1))
            } else if (e.key === "ArrowUp") {
              e.preventDefault()
              setCursor((i) => Math.max(0, i - 1))
            } else if (e.key === "Enter") {
              e.preventDefault()
              const c = shown[cursor]
              if (c) onPick(c.work_item.id)
            }
          }}
        />
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        {items === null && !error && <p className="muted">Cargando…</p>}
        <ul className="conv-history-list" aria-label="Conversaciones del proyecto">
          {shown.map((c, i) => {
            const id = c.work_item.id
            return (
              <li
                key={id}
                data-active={i === cursor || undefined}
                data-current={id === current || undefined}
                data-testid="conv-history-item"
              >
                {editing === id ? (
                  <form
                    className="conv-history-rename"
                    onSubmit={(e) => {
                      e.preventDefault()
                      void rename(id)
                    }}
                  >
                    <input
                      aria-label="Nuevo título"
                      // biome-ignore lint/a11y/noAutofocus: el lápiz pide escribir el título ya.
                      autoFocus
                      value={title}
                      onChange={(e) => setTitle(e.target.value)}
                    />
                    <button type="submit" className="ui-icon-button" aria-label="Guardar título">
                      <Check size={14} />
                    </button>
                    <button
                      type="button"
                      className="ui-icon-button"
                      aria-label="Cancelar"
                      onClick={() => setEditing(null)}
                    >
                      <X size={14} />
                    </button>
                  </form>
                ) : (
                  <>
                    <button
                      type="button"
                      className="conv-history-pick"
                      onClick={() => onPick(id)}
                      onMouseEnter={() => setCursor(i)}
                    >
                      <MessageSquare size={14} />
                      <span className="conv-history-title">{c.work_item.title}</span>
                      <span className="mono muted">{c.work_item.display_id}</span>
                      <span className="muted conv-history-meta">
                        {[
                          ago(c.last_activity_at),
                          `${c.runs} ${c.runs === 1 ? "turno" : "turnos"}`,
                          c.batches ? `${c.batches} ${c.batches === 1 ? "lote" : "lotes"}` : "",
                          id === current ? "abierta" : "",
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      </span>
                    </button>
                    <button
                      type="button"
                      className="ui-icon-button"
                      aria-label={`Renombrar ${c.work_item.title}`}
                      onClick={() => {
                        setEditing(id)
                        setTitle(c.work_item.title)
                      }}
                    >
                      <Pencil size={13} />
                    </button>
                  </>
                )}
              </li>
            )
          })}
        </ul>
        {items !== null && shown.length === 0 && <Hint>Ninguna conversación con ese título.</Hint>}
        <div className="modal-actions">
          <span className="muted conv-history-keys">↑↓ elegir · Enter retomar</span>
          <button type="button" className="button primary" onClick={onNew}>
            Nueva conversación
          </button>
        </div>
      </div>
    </Modal>
  )
}
