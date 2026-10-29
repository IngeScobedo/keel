/**
 * Avisos apilados (ADR-0034 §6) sobre el toast de Base UI. Un aviso puede traer su
 * propio contenido (aprobar desde ahí): va en `data.render`.
 */
import { Toast as BToast } from "@base-ui/react/toast"
import { X } from "lucide-react"
import type { ReactNode } from "react"

export type ToastData = { render?: () => ReactNode; tone?: "attention" | "info" | "error" }

export const ToastProvider = BToast.Provider
export const useToasts = BToast.useToastManager<ToastData>

function List() {
  const { toasts } = useToasts()
  return toasts.map((t) => (
    <BToast.Root
      key={t.id}
      toast={t}
      className="ui-toast"
      data-tone={t.data?.tone ?? "info"}
      swipeDirection="right"
    >
      <BToast.Content className="ui-toast-content">
        {t.title && <BToast.Title className="ui-toast-title" />}
        {t.description && <BToast.Description className="ui-toast-description" />}
        {t.data?.render?.()}
      </BToast.Content>
      <BToast.Close className="ui-icon-button ui-toast-close" aria-label="Cerrar aviso">
        <X size={13} aria-hidden />
      </BToast.Close>
    </BToast.Root>
  ))
}

/** Donde aparecen los avisos: abajo a la derecha, encima de todo. */
export function ToastViewport() {
  return (
    <BToast.Portal>
      <BToast.Viewport className="ui-toasts">
        <List />
      </BToast.Viewport>
    </BToast.Portal>
  )
}
