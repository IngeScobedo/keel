import { Tabs as BTabs } from "@base-ui/react/tabs"

/** Pestañas con teclado (flechas, Inicio, Fin) y un indicador que se desliza. */
export function Tabs<T extends string>({
  values,
  active,
  onChange,
  labels,
}: {
  values: readonly T[]
  active: T
  onChange: (tab: T) => void
  /** Texto por pestaña, si no es su valor; puede llevar una cuenta. */
  labels?: Partial<Record<T, React.ReactNode>>
}) {
  return (
    <BTabs.Root value={active} onValueChange={(v) => onChange(v as T)}>
      <BTabs.List className="ui-tabs">
        {values.map((tab) => (
          <BTabs.Tab key={tab} value={tab} className={`ui-tab ${active === tab ? "active" : ""}`}>
            {labels?.[tab] ?? tab}
          </BTabs.Tab>
        ))}
        <BTabs.Indicator className="ui-tab-indicator" />
      </BTabs.List>
    </BTabs.Root>
  )
}
