import { BarChart3, Save } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import { mutationMeta } from "./client.js"
import { Button, Hint } from "./ui.js"
import type { useWorkspace } from "./useWorkspace.js"

type Call = ReturnType<typeof useWorkspace>["call"]
export type KeelTable = {
  columns: { name: string; type?: string }[]
  rows: unknown[][]
  row_count_total?: number
  truncated?: boolean
}

/** Un resultado de herramienta como tabla, si lo es: filas JSON, o `content` MCP con filas. */
export function tableFromOutput(raw: unknown): KeelTable | null {
  let data: unknown = raw
  if (typeof data === "string")
    try {
      data = JSON.parse(data)
    } catch {
      return null
    }
  const content = (data as { content?: unknown } | null)?.content
  if (Array.isArray(content)) {
    const text = content
      .filter((c): c is { type: string; text: string } => (c as { type?: string })?.type === "text")
      .map((c) => c.text)
      .join("\n")
    return text ? tableFromOutput(text) : null
  }
  if ((data as KeelTable | null)?.columns && Array.isArray((data as KeelTable).rows))
    return data as KeelTable
  const rows = Array.isArray(data)
    ? data
    : Array.isArray((data as { rows?: unknown } | null)?.rows)
      ? ((data as { rows: unknown[] }).rows as unknown[])
      : null
  if (!rows || rows.length === 0) return null
  if (!rows.every((r) => r !== null && typeof r === "object" && !Array.isArray(r))) return null
  const names: string[] = []
  for (const r of rows as Record<string, unknown>[])
    for (const k of Object.keys(r)) if (!names.includes(k)) names.push(k)
  return {
    columns: names.map((name) => ({ name })),
    rows: (rows as Record<string, unknown>[]).map((r) => names.map((n) => r[n] ?? null)),
    row_count_total: rows.length,
    truncated: false,
  }
}

export function TableView({ table }: { table: KeelTable }) {
  return (
    <>
      <table className="result-table" data-testid="result-table">
        <thead>
          <tr>
            {table.columns.map((c) => (
              <th key={c.name}>{c.name}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {table.rows.slice(0, 500).map((r, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: filas de un resultado sin id propio.
            <tr key={i}>
              {r.map((v, j) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: columnas posicionales.
                <td key={j} className="mono">
                  {v === null ? "∅" : typeof v === "object" ? JSON.stringify(v) : String(v)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {(table.truncated || table.rows.length > 500) && (
        <Hint>
          Mostrando {Math.min(500, table.rows.length)} de{" "}
          {table.row_count_total ?? table.rows.length} filas.
        </Hint>
      )}
    </>
  )
}

/** Especificación Vega-Lite de la tabla: el visualizador nunca es dueño de los datos (ADR-0012 §5). */
export function chartSpec(table: KeelTable, x: string, y: string, mark: "bar" | "line" | "point") {
  const xi = table.columns.findIndex((c) => c.name === x)
  const yi = table.columns.findIndex((c) => c.name === y)
  const values = table.rows.map((r) => ({ [x]: r[xi], [y]: r[yi] }))
  const numeric = (i: number) => table.rows.every((r) => r[i] === null || typeof r[i] === "number")
  return {
    $schema: "https://vega.github.io/schema/vega-lite/v5.json",
    data: { values },
    mark,
    encoding: {
      x: { field: x, type: numeric(xi) ? "quantitative" : "nominal" },
      y: { field: y, type: numeric(yi) ? "quantitative" : "nominal" },
    },
    width: "container",
    height: 220,
  }
}

/** Tabla con «Graficar» sin código (ADR-0014 nivel 1); la gráfica puede guardarse como evidencia. */
export function TableWithChart({
  table,
  call,
  workItemId,
}: {
  table: KeelTable
  call?: Call
  workItemId?: string | null
}) {
  const [chart, setChart] = useState(false)
  const names = table.columns.map((c) => c.name)
  const [x, setX] = useState(names[0] ?? "")
  const [y, setY] = useState(names[1] ?? names[0] ?? "")
  const [mark, setMark] = useState<"bar" | "line" | "point">("bar")
  const box = useRef<HTMLDivElement>(null)
  const [saved, setSaved] = useState("")
  const spec = chartSpec(table, x, y, mark)
  // biome-ignore lint/correctness/useExhaustiveDependencies: la especificación sale de x, y y mark.
  useEffect(() => {
    if (!chart || !box.current) return
    const el = box.current
    // Vega se carga al graficar, no al abrir la ventana. Sin eval: la CSP de la ventana
    // no lo permite; Vega usa su intérprete de AST.
    const view = Promise.all([import("vega-embed"), import("vega-interpreter")]).then(
      ([{ default: embed }, { expressionInterpreter }]) =>
        embed(el, spec as never, { actions: false, ast: true, expr: expressionInterpreter }),
    )
    return () => {
      void view.then((v) => v.finalize()).catch(() => {})
    }
  }, [chart, x, y, mark])
  async function save() {
    if (!call || !workItemId) return
    const json = JSON.stringify(spec)
    await call("evidence.attach", {
      ...mutationMeta(),
      work_item_id: workItemId,
      kind: "chart",
      title: `${y} por ${x}`,
      content_base64: btoa(unescape(encodeURIComponent(json))),
      media_type: "application/vnd.vegalite.v5+json",
    })
    setSaved("Guardada como evidencia")
  }
  return (
    <div className="table-with-chart">
      <TableView table={table} />
      <div className="chart-controls">
        <Button icon={BarChart3} onClick={() => setChart((v) => !v)}>
          {chart ? "Ocultar gráfica" : "Graficar"}
        </Button>
        {chart && (
          <>
            <select aria-label="Eje x" value={x} onChange={(e) => setX(e.target.value)}>
              {names.map((n) => (
                <option key={n}>{n}</option>
              ))}
            </select>
            <select aria-label="Eje y" value={y} onChange={(e) => setY(e.target.value)}>
              {names.map((n) => (
                <option key={n}>{n}</option>
              ))}
            </select>
            <select
              aria-label="Tipo de gráfica"
              value={mark}
              onChange={(e) => setMark(e.target.value as typeof mark)}
            >
              <option value="bar">barras</option>
              <option value="line">línea</option>
              <option value="point">puntos</option>
            </select>
            {call && workItemId && (
              <Button icon={Save} onClick={() => void save()}>
                Guardar
              </Button>
            )}
            {saved && <span className="added">{saved}</span>}
          </>
        )}
      </div>
      {chart && <div className="chart" ref={box} data-testid="chart" />}
    </div>
  )
}
