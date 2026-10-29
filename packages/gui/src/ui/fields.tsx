import type { LucideIcon } from "lucide-react"
import type { ButtonHTMLAttributes, InputHTMLAttributes, TextareaHTMLAttributes } from "react"

/** Botón de Keel: una variante por intención, ícono opcional. */
export function Button({
  icon: Icon,
  children,
  variant = "default",
  size = "md",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  icon?: LucideIcon
  variant?: "default" | "primary" | "danger" | "ghost"
  size?: "sm" | "md"
}) {
  return (
    <button
      type="button"
      {...props}
      className={`button ui-button ${variant} ${props.className ?? ""}`}
      data-size={size}
    >
      {Icon && <Icon size={size === "sm" ? 13 : 14} aria-hidden="true" />}
      {children}
    </button>
  )
}

/** Campo de texto nativo con el estilo de Keel: no tiene lista que dibuje el sistema. */
export function Input(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={`ui-field ui-input ${props.className ?? ""}`} />
}

/** Texto de varias líneas que crece con lo escrito hasta un tope. */
export function TextArea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea rows={1} {...props} className={`ui-field ui-textarea ${props.className ?? ""}`} />
  )
}
