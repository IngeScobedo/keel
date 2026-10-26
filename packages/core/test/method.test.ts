import { describe, expect, test } from "bun:test"
import {
  canReturn,
  contractSection,
  lifecycleForStage,
  purposeForStage,
  stageMove,
  validateBrief,
  validateDesign,
  validateQa,
  validateSpec,
  verifyDelta,
} from "../src/index.ts"

describe("ADR-0021: etapas y gates", () => {
  test("directo salta los gates (a) y (b); formal los pide", () => {
    expect(stageMove("brief", "implement", "direct")).toMatchObject({ ok: true, gate: null })
    expect(stageMove("brief", "implement", "formal").ok).toBe(false)
    expect(stageMove("brief", "implement", null)).toMatchObject({ ok: false })
    expect(stageMove("brief", "design", "formal")).toMatchObject({ ok: true, gate: "brief" })
    expect(stageMove("design", "implement", "formal")).toMatchObject({
      ok: true,
      gate: "design",
      requires: ["spec", "design"],
    })
    expect(stageMove("review", "close", "direct")).toMatchObject({ ok: true, requires: ["qa"] })
    expect(stageMove("review", "implement", "direct").ok).toBe(true)
    expect(stageMove("brief", "close", "direct").ok).toBe(false)
    expect(stageMove("implement", "close", "direct").ok).toBe(false)
  })
  test("el humano devuelve a una etapa anterior; lifecycle y propósito por etapa", () => {
    expect(canReturn("close", "implement")).toBe(true)
    expect(canReturn("brief", "design")).toBe(false)
    expect(lifecycleForStage("design")).toBe("triage")
    expect(lifecycleForStage("review")).toBe("running")
    expect(lifecycleForStage("close")).toBe("needs_review")
    expect(purposeForStage("brief")).toBe("plan")
    expect(purposeForStage("implement")).toBe("execute")
  })
})

const BRIEF = `# Brief
## Problema
Los capítulos se pierden.
## Alcance
La vista del diseñador.
## Fuera de alcance
La tienda.
## Criterios de aceptación
- se ven los capítulos
`
const SPEC = `## Requisitos
### R1 — Capítulos visibles
El detalle debe mostrar los capítulos.
#### Escenario: con capítulos
- **Dado** un proyecto con 2 capítulos
- **Cuando** abro el detalle
- **Entonces** veo 2 capítulos
### R2 — Orden
#### Escenario: sin cláusula
- **Dado** algo
- **Entonces** otra cosa
### R3 — Vacío
`
const DESIGN = `# Design
## Contrato congelado
\`GET /projects/:id\` devuelve \`chapters\` en centavos.
## Fronteras de archivos (DISJUNTAS)
| engineer | archivos |
| -------- | -------- |
| backend  | \`apps/api/**\` |
| frontend | \`apps/web/**\` |
`

describe("ADR-0021: validación determinista de documentos", () => {
  test("brief: las cuatro secciones con contenido", () => {
    expect(validateBrief(BRIEF).ok).toBe(true)
    const r = validateBrief("## Problema\nalgo\n## Alcance\n…\n")
    expect(r.ok).toBe(false)
    expect(r.checks.filter((c) => !c.ok).map((c) => c.msg)).toEqual([
      "sección «Alcance» con contenido",
      "sección «Fuera de alcance» con contenido",
      "sección «Criterios de aceptación» con contenido",
    ])
  })
  test("spec: escenarios completos por requisito", () => {
    const r = validateSpec(SPEC)
    expect(r.ok).toBe(false)
    expect(r.checks.find((c) => !c.ok && c.msg.includes("escenario tiene"))?.detail).toBe(
      "R2 «sin cláusula»",
    )
    expect(r.checks.find((c) => c.msg.includes("al menos un escenario"))?.detail).toBe("R3")
  })
  test("diseño: contrato, fronteras disjuntas e invariante con ADR", () => {
    expect(contractSection(DESIGN)).toContain("GET /projects")
    const ctx = { invariants: ["centavos"], adr: "ADR-[GAB]\\d+" }
    const sinAdr = validateDesign(DESIGN, SPEC, ctx)
    expect(sinAdr.ok).toBe(false)
    expect(sinAdr.checks.find((c) => !c.ok)?.detail).toBe("centavos")
    expect(validateDesign(`${DESIGN}\nVer ADR-A6.\n`, SPEC, ctx).ok).toBe(true)
    const dup = `${DESIGN.replace("apps/web/**", "apps/api/**")}`
    expect(validateDesign(dup, SPEC).checks.find((c) => !c.ok)?.detail).toBe("apps/api/**")
  })
  test("QA: FAIL no cierra; WAIVED exige justificación", () => {
    expect(validateQa("## Veredicto: PASS").ok).toBe(true)
    expect(validateQa("## Veredicto: **FAIL**").ok).toBe(false)
    expect(validateQa("## Veredicto: WAIVED").ok).toBe(false)
    expect(
      validateQa(
        "## Veredicto: WAIVED\n## Justificación\nLa deuda de lint ya estaba antes y se agenda.",
      ),
    ).toMatchObject({ ok: true })
  })
  test("delta-verde: sólo el rojo nuevo bloquea", () => {
    const base = [
      { name: "lint", ok: false },
      { name: "test", ok: true },
      { name: "build", ok: true },
    ]
    expect(
      verifyDelta(base, [
        { name: "lint", ok: false },
        { name: "test", ok: true },
        { name: "build", ok: true },
      ]),
    ).toEqual({ green: true, newRed: [], stillRed: ["lint"], fixed: [] })
    expect(
      verifyDelta(base, [
        { name: "lint", ok: true },
        { name: "test", ok: false },
        { name: "build", ok: true },
      ]),
    ).toEqual({ green: false, newRed: ["test"], stillRed: [], fixed: ["lint"] })
  })
})
