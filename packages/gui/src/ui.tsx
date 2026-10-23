import type { VisualState } from "@keel/core"
import {
  Check,
  Circle,
  CircleDot,
  CircleSlash,
  Diamond,
  type LucideIcon,
  Pause,
  Square,
  TriangleAlert,
  Unplug,
  X,
} from "lucide-react"
import { type ButtonHTMLAttributes, type ReactNode, useEffect, useRef } from "react"

export const stateLabels: Record<VisualState, string> = {
  queued: "Queued",
  planning: "Planning",
  paused: "Paused",
  running: "Running",
  waiting_human: "Waiting for you",
  needs_review: "Needs review",
  blocked: "Blocked",
  succeeded: "Succeeded",
  failed: "Failed",
  cancelled: "Cancelled",
  interrupted: "Interrupted",
  orphan: "Orphan",
  budget_stop: "Budget exceeded",
}
const stateIcons: Record<VisualState, LucideIcon> = {
  queued: Circle,
  planning: Diamond,
  paused: Pause,
  running: CircleDot,
  waiting_human: TriangleAlert,
  needs_review: Check,
  blocked: Square,
  succeeded: CircleDot,
  failed: Square,
  cancelled: CircleSlash,
  interrupted: Pause,
  orphan: Unplug,
  budget_stop: Square,
}
export function Status({ state, dot = false }: { state: VisualState; dot?: boolean }) {
  const Icon = stateIcons[state]
  return (
    <span
      className={`status ${dot ? "status-dot" : ""}`}
      data-state={state}
      title={stateLabels[state]}
    >
      <Icon size={dot ? 10 : 11} aria-hidden="true" />
      {!dot && stateLabels[state]}
    </span>
  )
}
export function Button({
  icon: Icon,
  children,
  variant = "default",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  icon?: LucideIcon
  variant?: "default" | "primary" | "danger" | "ghost"
}) {
  return (
    <button type="button" className={`button ${variant} ${props.className ?? ""}`} {...props}>
      {Icon && <Icon size={14} aria-hidden="true" />}
      {children}
    </button>
  )
}
export function Empty({
  title,
  children,
  icon: Icon = Circle,
}: {
  title: string
  children?: ReactNode
  icon?: LucideIcon
}) {
  return (
    <div className="empty">
      <Icon size={25} strokeWidth={1.3} aria-hidden="true" />
      <strong>{title}</strong>
      <p>{children}</p>
    </div>
  )
}
export function Modal({
  title,
  children,
  onClose,
  wide = false,
}: {
  title: string
  children: ReactNode
  onClose: () => void
  wide?: boolean
}) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    ref.current?.showModal()
    // showModal enfoca el primer control (el botón de cerrar); el campo marcado gana.
    ref.current?.querySelector<HTMLElement>("[data-autofocus]")?.focus()
    return () => ref.current?.close()
  }, [])
  return (
    <dialog
      ref={ref}
      className={`modal ${wide ? "wide" : ""}`}
      aria-labelledby="modal-title"
      onCancel={(event) => {
        event.preventDefault()
        onClose()
      }}
    >
      <header>
        <h2 id="modal-title">{title}</h2>
        <Button variant="ghost" icon={X} aria-label="Cerrar diálogo" onClick={onClose} />
      </header>
      {children}
    </dialog>
  )
}
export function Tabs<T extends string>({
  values,
  active,
  onChange,
}: {
  values: readonly T[]
  active: T
  onChange: (tab: T) => void
}) {
  return (
    <div className="tabs" role="tablist">
      {values.map((tab) => (
        <button
          type="button"
          key={tab}
          role="tab"
          aria-selected={active === tab}
          className={active === tab ? "active" : ""}
          onClick={() => onChange(tab)}
        >
          {tab}
        </button>
      ))}
    </div>
  )
}
export function Hint({ children }: { children: ReactNode }) {
  return <p className="hint">{children}</p>
}
