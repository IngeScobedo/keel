import { describe, expect, test } from "bun:test"
import { chartSpec, tableFromOutput } from "../src/Chart.js"

describe("ADR-0014 nivel 1: un resultado tabular cualquiera es una tabla", () => {
  test("filas JSON, contenido MCP con texto, o una tabla de Keel", () => {
    const rows = [
      { mes: "ago", monto: 10 },
      { mes: "sep", monto: 30 },
    ]
    const expected = {
      columns: [{ name: "mes" }, { name: "monto" }],
      rows: [
        ["ago", 10],
        ["sep", 30],
      ],
    }
    expect(tableFromOutput(rows)).toMatchObject(expected)
    expect(
      tableFromOutput({ content: [{ type: "text", text: JSON.stringify(rows) }] }),
    ).toMatchObject(expected)
    expect(tableFromOutput(JSON.stringify({ rows }))).toMatchObject(expected)
    expect(tableFromOutput("no es tabla")).toBeNull()
    expect(tableFromOutput([1, 2, 3])).toBeNull()
  })
  test("la gráfica es una especificación Vega-Lite con los datos y tipos inferidos", () => {
    const t = tableFromOutput([
      { mes: "ago", monto: 10 },
      { mes: "sep", monto: 30 },
    ])
    if (!t) throw new Error("tabla")
    const spec = chartSpec(t, "mes", "monto", "bar")
    expect(spec.encoding).toEqual({
      x: { field: "mes", type: "nominal" },
      y: { field: "monto", type: "quantitative" },
    })
    expect(spec.data.values).toEqual([
      { mes: "ago", monto: 10 },
      { mes: "sep", monto: 30 },
    ])
  })
})
