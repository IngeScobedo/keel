/**
 * Lo que se abre encima (ADR-0034 §2): diálogo, cajón, menú, popover y tooltip sobre
 * Base UI. El diálogo y el cajón no le roban el foco al compositor si no se les pide.
 */
import { Dialog as BDialog } from "@base-ui/react/dialog"
import { Drawer as BDrawer } from "@base-ui/react/drawer"
import { Menu as BMenu } from "@base-ui/react/menu"
import { Popover as BPopover } from "@base-ui/react/popover"
import { Tooltip as BTooltip } from "@base-ui/react/tooltip"
import { X } from "lucide-react"
import type { ReactElement, ReactNode } from "react"

/** Diálogo modal: atrapa el foco y `Esc` lo cierra. */
export function Dialog({
  title,
  children,
  onClose,
  wide = false,
  description,
}: {
  title: string
  children: ReactNode
  onClose: () => void
  wide?: boolean
  description?: ReactNode
}) {
  return (
    <BDialog.Root
      open
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <BDialog.Portal>
        <BDialog.Backdrop className="ui-backdrop" />
        <BDialog.Popup
          className="ui-dialog modal"
          data-wide={wide || undefined}
          initialFocus={(): HTMLElement | boolean =>
            document.querySelector<HTMLElement>(".ui-dialog [data-autofocus]") ?? true
          }
        >
          <header className="ui-dialog-head">
            <BDialog.Title className="ui-dialog-title">{title}</BDialog.Title>
            <BDialog.Close className="ui-icon-button" aria-label="Cerrar diálogo">
              <X size={15} aria-hidden />
            </BDialog.Close>
          </header>
          {description && (
            <BDialog.Description className="ui-dialog-description">
              {description}
            </BDialog.Description>
          )}
          <div className="ui-dialog-body">{children}</div>
        </BDialog.Popup>
      </BDialog.Portal>
    </BDialog.Root>
  )
}

/**
 * Cajón lateral no modal (ADR-0034 §5): se abre sin quitarle el foco a nadie, no tapa
 * con un fondo y no se cierra por un clic afuera; lo cierra su botón o `Esc` adentro.
 */
export function Drawer({
  open,
  onOpenChange,
  title,
  children,
  actions,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: ReactNode
  children: ReactNode
  actions?: ReactNode
}) {
  return (
    <BDrawer.Root
      open={open}
      onOpenChange={onOpenChange}
      modal={false}
      disablePointerDismissal
      swipeDirection="right"
    >
      <BDrawer.Portal>
        <BDrawer.Popup className="ui-drawer" initialFocus={false} finalFocus={false}>
          <header className="ui-drawer-head">
            <BDrawer.Title className="ui-drawer-title">{title}</BDrawer.Title>
            {actions}
            <BDrawer.Close className="ui-icon-button" aria-label="Cerrar el panel">
              <X size={15} aria-hidden />
            </BDrawer.Close>
          </header>
          <div className="ui-drawer-body">{children}</div>
        </BDrawer.Popup>
      </BDrawer.Portal>
    </BDrawer.Root>
  )
}

export type MenuItem = {
  label: ReactNode
  onSelect: () => void
  disabled?: boolean
  danger?: boolean
}

/** Menú de acciones desde un botón. */
export function Menu({
  trigger,
  items,
  label,
}: {
  trigger: ReactNode
  items: readonly MenuItem[]
  label: string
}) {
  return (
    <BMenu.Root>
      <BMenu.Trigger className="ui-icon-button" aria-label={label}>
        {trigger}
      </BMenu.Trigger>
      <BMenu.Portal>
        <BMenu.Positioner className="ui-positioner" sideOffset={4} align="end">
          <BMenu.Popup className="ui-popup ui-list">
            {items.map((it, i) => (
              <BMenu.Item
                // biome-ignore lint/suspicious/noArrayIndexKey: el menú es fijo mientras está abierto
                key={i}
                className="ui-option"
                data-danger={it.danger || undefined}
                disabled={it.disabled ?? false}
                onClick={it.onSelect}
              >
                <span className="ui-option-text">{it.label}</span>
              </BMenu.Item>
            ))}
          </BMenu.Popup>
        </BMenu.Positioner>
      </BMenu.Portal>
    </BMenu.Root>
  )
}

/** Un panel chico anclado a un botón. */
export function Popover({
  trigger,
  children,
  label,
}: {
  trigger: ReactNode
  children: ReactNode
  label: string
}) {
  return (
    <BPopover.Root>
      <BPopover.Trigger className="ui-icon-button" aria-label={label}>
        {trigger}
      </BPopover.Trigger>
      <BPopover.Portal>
        <BPopover.Positioner className="ui-positioner" sideOffset={6}>
          <BPopover.Popup className="ui-popup ui-popover">{children}</BPopover.Popup>
        </BPopover.Positioner>
      </BPopover.Portal>
    </BPopover.Root>
  )
}

/** Texto de ayuda al pasar o enfocar; nunca lleva lo único que explica una acción. */
export function Tooltip({ content, children }: { content: ReactNode; children: ReactElement }) {
  return (
    <BTooltip.Root>
      <BTooltip.Trigger render={children} />
      <BTooltip.Portal>
        <BTooltip.Positioner className="ui-positioner" sideOffset={6}>
          <BTooltip.Popup className="ui-tooltip">{content}</BTooltip.Popup>
        </BTooltip.Positioner>
      </BTooltip.Portal>
    </BTooltip.Root>
  )
}

export const TooltipProvider = BTooltip.Provider
