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
} from "lucide-react"
import type { ReactNode } from "react"
import { Dialog } from "./ui/index.js"

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
export function Status({
  state,
  dot = false,
  label,
}: {
  state: VisualState
  dot?: boolean
  /** Otro texto para el mismo estado (p. ej. una feature que espera a sus subtareas). */
  label?: string
}) {
  const Icon = stateIcons[state]
  const text = label ?? stateLabels[state]
  return (
    <span className={`status ${dot ? "status-dot" : ""}`} data-state={state} title={text}>
      <Icon size={dot ? 10 : 11} aria-hidden="true" />
      {!dot && text}
    </span>
  )
}
/** Los controles viven en `ui/` (ADR-0034 §2); estos nombres siguen para no tocar cada vista. */
export { Button, Tabs } from "./ui/index.js"
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
/** Un diálogo modal: el de `ui/` sobre Base UI, con el nombre de siempre. */
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
  return (
    <Dialog title={title} onClose={onClose} wide={wide}>
      {children}
    </Dialog>
  )
}
export function Hint({ children }: { children: ReactNode }) {
  return <p className="hint">{children}</p>
}
