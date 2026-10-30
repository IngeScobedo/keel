/**
 * Elegir una entre pocas opciones a la vista (ADR-0034 §2): el método de merge, el
 * protocolo de git, una subtarea. Base UI pone el grupo, las flechas y `aria-pressed`;
 * Keel, el aspecto: un riel hundido con la opción elegida en relieve.
 */
import { Toggle } from "@base-ui/react/toggle"
import { ToggleGroup } from "@base-ui/react/toggle-group"
import type { ReactNode } from "react"

export type Segment<T extends string> = {
  value: T
  label: ReactNode
  icon?: ReactNode
  title?: string
  disabled?: boolean
}

export function Segmented<T extends string>({
  value,
  onChange,
  options,
  size = "md",
  mono = false,
  className,
  ...rest
}: {
  /** null: ninguna elegida (un filtro en «todo»). */
  value: T | null
  onChange: (value: T) => void
  options: readonly Segment<T>[]
  size?: "sm" | "md"
  mono?: boolean
  className?: string
  "aria-label": string
}) {
  return (
    <ToggleGroup
      className={`ui-segmented ui-segmented-${size}${mono ? " ui-segmented-mono" : ""}${className ? ` ${className}` : ""}`}
      aria-label={rest["aria-label"]}
      value={value === null ? [] : [value]}
      // Volver a pulsar la elegida no la deja vacía: siempre queda una.
      onValueChange={(next) => {
        const v = next[0]
        if (v !== undefined && v !== value) onChange(v as T)
      }}
    >
      {options.map((o) => (
        <Toggle
          key={o.value}
          value={o.value}
          className="ui-segment"
          disabled={o.disabled ?? false}
          {...(o.title ? { title: o.title } : {})}
        >
          {o.icon}
          <span>{o.label}</span>
        </Toggle>
      ))}
    </ToggleGroup>
  )
}
