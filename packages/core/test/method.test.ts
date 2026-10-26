import { describe, expect, test } from "bun:test"
import {
  canReturn,
  contractSection,
  lifecycleForStage,
  parseTasks,
  purposeForStage,
  stageMove,
  storyFor,
  validateBrief,
  validateDesign,
  validateDoc,
  validateQa,
  validateSpec,
  validateTasks,
  verifyDelta,
  withinFrontier,
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

describe("ADR-0022: el plan de la feature", () => {
  const SPEC2 = `## Requisitos
### R1 — Capítulos en el API
#### Escenario: lista
- **Dado** un proyecto con capítulos
- **Cuando** pido el detalle
- **Entonces** vienen los capítulos
### R2 — Capítulos en el backoffice
#### Escenario: agrupado
- **Dado** fotos con capítulo
- **Cuando** abro el detalle
- **Entonces** se agrupan
`
  const TASKS = `# Tareas
## Fase 1 — API
- [ ] T1 Contrato de capítulos → \`apps/api/src/chapters/**\` → R1
- [ ] T2 Repositorio de capítulos → \`apps/api/src/repo/**\` → R1
## Fase 2 — Backoffice
- [ ] T3 Tarjeta por capítulos → \`apps/backoffice/src/photos/**\` → R2
- [ ] T4 Pestaña de galería → \`apps/backoffice/src/gallery/**\` → R2 (después de T3)
`
  test("lee fases, fronteras, requisitos y dependencias entre fases", () => {
    const tasks = parseTasks(TASKS)
    expect(tasks.map((t) => [t.key, t.phase, t.title])).toEqual([
      ["T1", 1, "Contrato de capítulos"],
      ["T2", 1, "Repositorio de capítulos"],
      ["T3", 2, "Tarjeta por capítulos"],
      ["T4", 2, "Pestaña de galería"],
    ])
    expect(tasks[0]?.frontier).toEqual(["apps/api/src/chapters/**"])
    expect(tasks[0]?.requirements).toEqual(["R1"])
    expect(tasks[0]?.after).toEqual([])
    expect(tasks[2]?.after).toEqual(["T1", "T2"])
    expect(tasks[3]?.after).toEqual(["T1", "T2", "T3"])
    expect(tasks[2]?.phase_title).toBe("Backoffice")
    expect(validateTasks(TASKS, SPEC2).ok).toBe(true)
  })

  test("sin fases todo es la fase 1 y las llaves salen de la posición", () => {
    const tasks = parseTasks("- [ ] Una → `a/**` → R1\n- [ ] Otra → `b/**` → R1\n")
    expect(tasks.map((t) => [t.key, t.phase, t.after])).toEqual([
      ["T1", 1, []],
      ["T2", 1, []],
    ])
  })

  test("bloquea fronteras solapadas, líneas sin frontera, requisitos inventados y ciclos", () => {
    const bad = `- [ ] T1 A → \`a/**\` → R1 (después de T2)
- [ ] T2 B → \`a/**\` → R9 (después de T1)
- [ ] T3 C sin frontera → R1
`
    const r = validateTasks(bad, SPEC2)
    expect(r.ok).toBe(false)
    const failed = r.checks.filter((c) => !c.ok).map((c) => c.msg)
    expect(failed).toContain("las fronteras de las subtareas no se solapan")
    expect(failed).toContain("cada línea nombra su frontera de archivos")
    expect(failed).toContain("los requisitos citados existen en la spec")
    expect(failed).toContain("las dependencias no forman un ciclo")
    expect(validateDoc("tasks", bad, { spec: SPEC2 }).ok).toBe(false)
  })

  test("la story sale de la línea, los escenarios citados y el contrato", () => {
    const [t] = parseTasks(TASKS)
    const story = storyFor(
      t as NonNullable<typeof t>,
      SPEC2,
      "## Contrato congelado\n`GET /projects/:id` devuelve `chapters`.\n",
    )
    expect(story).toContain("# T1 — Contrato de capítulos")
    expect(story).toContain("`apps/api/src/chapters/**`")
    expect(story).toContain("#### Escenario: lista")
    expect(story).not.toContain("agrupado")
    expect(story).toContain("devuelve `chapters`")
  })

  test("la frontera casa por glob: ** cruza carpetas y * no", () => {
    expect(withinFrontier("apps/api/src/chapters/a.ts", ["apps/api/src/chapters/**"])).toBe(true)
    expect(withinFrontier("apps/api/src/chapters/x/y.ts", ["apps/api/src/chapters/**"])).toBe(true)
    expect(withinFrontier("apps/api/src/other.ts", ["apps/api/src/chapters/**"])).toBe(false)
    expect(withinFrontier("src/a.ts", ["src/*.ts"])).toBe(true)
    expect(withinFrontier("src/x/a.ts", ["src/*.ts"])).toBe(false)
    expect(withinFrontier("README.md", ["**/*.md"])).toBe(true)
  })
})
