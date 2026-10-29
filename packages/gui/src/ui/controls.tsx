/**
 * Controles con comportamiento (ADR-0034 §2): Base UI pone el teclado, el foco, el
 * posicionamiento y los roles; Keel pone el aspecto con sus tokens. Se ven igual en
 * WebKitGTK, WebView2 y WKWebView: ninguna lista la dibuja el sistema.
 */
import { Checkbox as BCheckbox } from "@base-ui/react/checkbox"
import { Combobox as BCombobox } from "@base-ui/react/combobox"
import { Select as BSelect } from "@base-ui/react/select"
import { Switch as BSwitch } from "@base-ui/react/switch"
import { Check, ChevronsUpDown, Minus } from "lucide-react"
import type { ReactNode } from "react"

export type Option<T extends string = string> = {
  value: T
  label: ReactNode
  /** Texto de apoyo a la derecha, más tenue. */
  hint?: ReactNode
  disabled?: boolean
}

type SelectProps<T extends string> = {
  value: T
  onChange: (value: T) => void
  options: readonly Option<T>[]
  "aria-label"?: string
  id?: string
  title?: string | undefined
  disabled?: boolean
  placeholder?: string
  className?: string
  /** Compacto para tablas y barras. */
  size?: "sm" | "md"
}

/** Un select propio: la lista es de Keel, con teclado y búsqueda al escribir. */
export function Select<T extends string>({
  value,
  onChange,
  options,
  disabled,
  placeholder,
  className,
  size = "md",
  id,
  title,
  ...rest
}: SelectProps<T>) {
  const items = options.map((o) => ({ value: o.value, label: o.label }))
  return (
    <BSelect.Root
      items={items}
      value={value}
      disabled={disabled ?? false}
      onValueChange={(v) => {
        if (v !== null) onChange(v as T)
      }}
    >
      <BSelect.Trigger
        className={`ui-field ui-select ${className ?? ""}`}
        data-size={size}
        aria-label={rest["aria-label"]}
        {...(id ? { id } : {})}
        {...(title ? { title } : {})}
      >
        <BSelect.Value className="ui-select-value" placeholder={placeholder ?? "Elegir…"} />
        <BSelect.Icon className="ui-select-icon">
          <ChevronsUpDown size={13} aria-hidden />
        </BSelect.Icon>
      </BSelect.Trigger>
      <BSelect.Portal>
        <BSelect.Positioner className="ui-positioner" sideOffset={4} alignItemWithTrigger={false}>
          <BSelect.Popup className="ui-popup ui-list">
            {options.map((o) => (
              <BSelect.Item
                key={o.value}
                value={o.value}
                className="ui-option"
                disabled={o.disabled ?? false}
              >
                <BSelect.ItemIndicator className="ui-option-check">
                  <Check size={13} aria-hidden />
                </BSelect.ItemIndicator>
                <BSelect.ItemText className="ui-option-text">{o.label}</BSelect.ItemText>
                {o.hint && <span className="ui-option-hint">{o.hint}</span>}
              </BSelect.Item>
            ))}
          </BSelect.Popup>
        </BSelect.Positioner>
      </BSelect.Portal>
    </BSelect.Root>
  )
}

/** Un select con búsqueda: para listas largas (modelos, conexiones, archivos). */
export function Combobox<T extends string>({
  value,
  onChange,
  options,
  placeholder,
  disabled,
  className,
  empty = "Sin coincidencias",
  ...rest
}: SelectProps<T> & { empty?: string }) {
  type Item = { value: string; label: string }
  const items: Item[] = options.map((o) => ({ value: o.value, label: String(o.label) }))
  const selected = items.find((i) => i.value === value) ?? null
  return (
    <BCombobox.Root<Item>
      items={items}
      value={selected}
      disabled={disabled ?? false}
      itemToStringLabel={(i) => i.label}
      isItemEqualToValue={(a, b) => a.value === b.value}
      onValueChange={(v) => {
        if (v) onChange(v.value as T)
      }}
    >
      <div className={`ui-field ui-combobox ${className ?? ""}`}>
        <BCombobox.Input
          className="ui-combobox-input"
          placeholder={placeholder ?? "Buscar…"}
          aria-label={rest["aria-label"]}
        />
        <BCombobox.Trigger className="ui-combobox-trigger" aria-label="Abrir la lista">
          <ChevronsUpDown size={13} aria-hidden />
        </BCombobox.Trigger>
      </div>
      <BCombobox.Portal>
        <BCombobox.Positioner className="ui-positioner" sideOffset={4}>
          <BCombobox.Popup className="ui-popup ui-list">
            <BCombobox.Empty className="ui-option-empty">{empty}</BCombobox.Empty>
            <BCombobox.List>
              {(item: Item) => (
                <BCombobox.Item key={item.value} value={item} className="ui-option">
                  <BCombobox.ItemIndicator className="ui-option-check">
                    <Check size={13} aria-hidden />
                  </BCombobox.ItemIndicator>
                  <span className="ui-option-text">{item.label}</span>
                </BCombobox.Item>
              )}
            </BCombobox.List>
          </BCombobox.Popup>
        </BCombobox.Positioner>
      </BCombobox.Portal>
    </BCombobox.Root>
  )
}

/** Casilla con su etiqueta; `indeterminate` para «algunas». */
export function Checkbox({
  checked,
  onChange,
  children,
  disabled,
  indeterminate,
  ...rest
}: {
  checked: boolean
  onChange: (checked: boolean) => void
  children?: ReactNode
  disabled?: boolean
  indeterminate?: boolean
  "aria-label"?: string
}) {
  const box = (
    <BCheckbox.Root
      className="ui-checkbox"
      checked={checked}
      indeterminate={indeterminate ?? false}
      disabled={disabled ?? false}
      onCheckedChange={(v) => onChange(v)}
      {...(rest["aria-label"] ? { "aria-label": rest["aria-label"] } : {})}
    >
      <BCheckbox.Indicator className="ui-checkbox-mark">
        {indeterminate ? <Minus size={11} aria-hidden /> : <Check size={11} aria-hidden />}
      </BCheckbox.Indicator>
    </BCheckbox.Root>
  )
  if (!children) return box
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: el control es el botón de Base UI de adentro.
    <label className="ui-check-row" data-disabled={disabled || undefined}>
      {box}
      <span>{children}</span>
    </label>
  )
}

/** Interruptor para un ajuste que se aplica al instante. */
export function Switch({
  checked,
  onChange,
  children,
  disabled,
}: {
  checked: boolean
  onChange: (checked: boolean) => void
  children?: ReactNode
  disabled?: boolean
}) {
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: el control es el botón de Base UI de adentro.
    <label className="ui-check-row" data-disabled={disabled || undefined}>
      <BSwitch.Root
        className="ui-switch"
        checked={checked}
        disabled={disabled ?? false}
        onCheckedChange={(v) => onChange(v)}
      >
        <BSwitch.Thumb className="ui-switch-thumb" />
      </BSwitch.Root>
      {children && <span>{children}</span>}
    </label>
  )
}
