import type { EventNotification } from "@keel/core"
import { Bot, Check, ChevronDown, ChevronRight, CircleAlert, Send, User, X } from "lucide-react"
import { useEffect, useLayoutEffect, useRef, useState } from "react"
import { mutationMeta } from "./client.js"
import { buildChat, type ChatItem } from "./model.js"
import { Button, Empty, Hint } from "./ui.js"
import type { useWorkspace } from "./useWorkspace.js"

type Call = ReturnType<typeof useWorkspace>["call"]

/**
 * El run como conversación: lo más nuevo abajo y la vista pegada al final
 * mientras no subas a leer. Las aprobaciones se resuelven aquí mismo.
 */
export function RunChat({
  events,
  call,
  running,
}: {
  events: EventNotification[]
  call?: Call
  running: boolean
}) {
  const items = buildChat(events)
  const box = useRef<HTMLDivElement>(null)
  const pinned = useRef(true)
  useLayoutEffect(() => {
    const el = box.current
    if (el && pinned.current) el.scrollTop = el.scrollHeight
  })
  return (
    <div className="run-chat">
      <div
        className="chat-scroll"
        ref={box}
        onScroll={(e) => {
          const el = e.currentTarget
          pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
        }}
      >
        {items.map((item) => (
          <ChatRow key={item.key} item={item} {...(call ? { call } : {})} />
        ))}
        {items.length === 0 && <Empty title="El agente aún no ha dicho nada" />}
        {running && <p className="chat-typing muted">El agente está trabajando…</p>}
      </div>
      <div className="chat-composer">
        <textarea
          aria-label="Mensaje al agente"
          rows={2}
          disabled
          placeholder="Escribir al agente durante el run llega en el siguiente paso (el daemon aún no lo admite)."
        />
        <Button icon={Send} disabled>
          Enviar
        </Button>
      </div>
    </div>
  )
}

function ChatRow({ item, call }: { item: ChatItem; call?: Call }) {
  const [open, setOpen] = useState(false)
  switch (item.kind) {
    case "prompt":
      return (
        <div className="chat-msg from-human" data-testid="chat-prompt">
          <User size={14} aria-hidden="true" />
          <p className="text-block">{item.text}</p>
        </div>
      )
    case "agent":
      return (
        <div className="chat-msg from-agent" data-testid="chat-agent">
          <Bot size={14} aria-hidden="true" />
          <p className="text-block">{item.text}</p>
        </div>
      )
    case "tool":
      return (
        <div className={`chat-tool ${item.failed ? "failed" : ""}`} data-testid="chat-tool">
          <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
            {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            <code className="tool-name">{item.name}</code>
            <span className="mono tool-input">{item.input}</span>
          </button>
          {open && item.output !== null && <pre>{item.output || "(sin salida)"}</pre>}
        </div>
      )
    case "approval":
      return <ApprovalRow item={item} {...(call ? { call } : {})} />
    case "status":
      return (
        <p className={`chat-status ${item.tone}`} data-testid="chat-status">
          {item.tone === "error" && <CircleAlert size={13} aria-hidden="true" />}
          {item.text}
        </p>
      )
  }
}

function ApprovalRow({
  item,
  call,
}: {
  item: Extract<ChatItem, { kind: "approval" }>
  call?: Call
}) {
  const [now, setNow] = useState(Date.now)
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)
  const pending = item.decision === null
  useEffect(() => {
    if (!pending) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [pending])
  const left = item.expires_at
    ? Math.max(0, Math.ceil((Date.parse(item.expires_at) - now) / 1000))
    : null
  const expired = pending && left === 0
  async function decide(approve: boolean) {
    if (!call || busy) return
    setBusy(true)
    try {
      await call("approvals.resolve", {
        ...mutationMeta(),
        approval_id: item.approval_id,
        operation_hash: item.operation_hash,
        decision: approve ? "approve_once" : "deny",
      })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div
      className="chat-approval"
      data-state={pending ? "pending" : item.decision}
      data-testid="chat-approval"
    >
      <strong>
        {pending
          ? expired
            ? `${item.tool}: venció sin respuesta`
            : `${item.tool} pide permiso${left === null ? "" : ` · ${left}s`}`
          : `${item.tool}: ${item.decision === "approved" ? "aprobado" : item.decision === "expired" ? "venció, denegado" : "denegado"}`}
      </strong>
      {item.input && <pre className="chat-approval-input">{item.input}</pre>}
      {pending && !expired && call && (
        <span className="chat-approval-actions">
          <Button variant="primary" icon={Check} disabled={busy} onClick={() => void decide(true)}>
            Aprobar una vez
          </Button>
          <Button variant="danger" icon={X} disabled={busy} onClick={() => void decide(false)}>
            Denegar
          </Button>
        </span>
      )}
      {error && <Hint>{error}</Hint>}
    </div>
  )
}
