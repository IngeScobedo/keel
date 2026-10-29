import { X } from "lucide-react"
import type { ReactNode } from "react"

/**
 * Panel lateral dentro del layout (ADR-0034 §5): a diferencia del cajón, no tapa nada;
 * el contenido de al lado se angosta. Nunca toma el foco al abrirse.
 */
export function SidePanel({
  title,
  onClose,
  children,
  actions,
}: {
  title: ReactNode
  onClose: () => void
  children: ReactNode
  actions?: ReactNode
}) {
  return (
    <aside className="ui-side-panel" aria-label={typeof title === "string" ? title : undefined}>
      <header className="ui-drawer-head">
        <h2 className="ui-drawer-title">{title}</h2>
        {actions}
        <button
          type="button"
          className="ui-icon-button"
          aria-label="Cerrar el panel"
          onClick={onClose}
        >
          <X size={15} aria-hidden />
        </button>
      </header>
      <div className="ui-drawer-body">{children}</div>
    </aside>
  )
}
