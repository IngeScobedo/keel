/** ADR-0042: las tools deterministas del orquestador, con tablas. */
import { describe, expect, test } from "bun:test"
import {
  type BatchIntent,
  BatchIntentSchema,
  batchDocs,
  frontiersOverlap,
  intakeDraft,
  lanesFor,
  parseSpec,
  parseTasks,
  passagesOf,
  readyCheck,
} from "../src/index.ts"

/**
 * El mensaje 1 del caso de Casa Matte, reconstruido desde la tabla del SDD 05 (no es
 * el literal de la sesión: cuando llegue, se reemplaza).
 */
const MSG1 = `Revisa el lienzo de Mis proyectos e integra la UI.
Propón cómo distinguir Proyectos y Mis pedidos: su valor, su relación y su ciclo de vida. Invierte el menú para que Proyectos quede arriba.
El correo ya avisa cuando hay ronda nueva, ¿y en la tienda qué se muestra? Los botones de la propuesta deben ser más claros, con colores por intención y textos más grandes.
El diseñador no ve los pines del Lab. Y que los resueltos se pongan en verde.
Al final quiero que se despliegue.`

describe("intake_draft", () => {
  test("el mensaje 1 del caso: un pedido por cosa, con su clase", () => {
    const d = intakeDraft(MSG1)
    const kinds = d.map((x) => x.kind)
    expect(kinds).toContain("design-proposal")
    expect(kinds).toContain("bugfix")
    expect(kinds).toContain("release")
    expect(kinds.filter((k) => k === "ui-change").length).toBeGreaterThanOrEqual(2)
    expect(d.find((x) => x.kind === "release")?.ordering).toBe("end-of-batch")
    expect(d.find((x) => /pines del Lab/.test(x.text))?.kind).toBe("bugfix")
    // La procedencia apunta al tramo del mensaje.
    const pin = d.find((x) => /pines/.test(x.text)) as (typeof d)[number]
    expect(MSG1.slice(pin.span[0], pin.span[1])).toContain("pines del Lab")
  })

  test("corrección, ratificación y diferido", () => {
    expect(intakeDraft("No puedes ver el avance antes de que llegue la propuesta.")[0]?.kind).toBe(
      "correction",
    )
    expect(intakeDraft("Sí a las primeras cuatro, impleméntalo.")[0]?.kind).toBe("ratification")
    expect(intakeDraft("Agrega el rastreo de envíos, lo vemos después.")[0]?.ordering).toBe(
      "deferred",
    )
  })

  test("una oración de contexto se une al pedido anterior", () => {
    const d = intakeDraft("Arregla el login de la tienda. Pasa sólo en Safari con sesión vieja.")
    expect(d).toHaveLength(1)
    expect(d[0]?.text).toContain("Safari")
  })

  test("lo ambiguo baja la confianza", () => {
    expect((intakeDraft("Lo de la página de inicio")[0]?.confidence ?? 1) < 0.6).toBe(true)
  })
})

const intent = (p: Partial<BatchIntent>): BatchIntent =>
  BatchIntentSchema.parse({ key: "T1", title: "Pines del Lab visibles", kind: "bugfix", ...p })

describe("ready_check", () => {
  test("cada hueco es una pregunta; el alcance ofrece las anclas del repo", () => {
    const r = readyCheck(intent({}), ["features/lab/**", "components/pins/**"])
    expect(r.ready).toBe(false)
    expect(r.questions.map((q) => q.slot)).toEqual(["goal", "scope", "acceptance"])
    expect(r.questions[1]?.options).toEqual(["features/lab/**", "components/pins/**"])
    const ok = readyCheck(
      intent({
        goal: "El diseñador ve y abre cada pin de comentario.",
        scope: ["features/lab/**"],
        acceptance: ["Los pines se ven sobre el lienzo para el diseñador"],
      }),
    )
    expect(ok).toMatchObject({ ready: true, questions: [] })
  })
})

describe("lanes_compute", () => {
  test("fronteras que se cruzan van al mismo carril", () => {
    expect(frontiersOverlap(["features/lab/**"], ["features/lab/pins.ts"])).toBe(true)
    expect(frontiersOverlap(["features/lab/**"], ["features/projects/**"])).toBe(false)
    expect(
      lanesFor([
        { key: "T1", scope: ["features/projects/**"] },
        { key: "T2", scope: ["components/proposal/**"] },
        { key: "T3", scope: ["features/lab/**"] },
        { key: "T4", scope: ["features/lab/comments/**"] },
        { key: "T5", scope: ["features/projects/menu.tsx", "components/proposal/Button.tsx"] },
      ]),
    ).toEqual([
      ["T1", "T5", "T2"],
      ["T3", "T4"],
    ])
  })
})

describe("del plan del lote a la feature", () => {
  test("fases por orden, frontera y criterios que parseTasks y parseSpec leen", () => {
    const docs = batchDocs("Proyectos y pedidos", "Lo que pidió Alan.", [
      intent({
        key: "T1",
        title: "Separar Proyectos de Pedidos",
        kind: "design-proposal",
        scope: ["features/projects/**"],
        acceptance: ["Hay una propuesta con las dos vistas"],
      }),
      intent({
        key: "T2",
        title: "Aviso de ronda nueva",
        kind: "ui-change",
        scope: ["features/projects/round/**"],
        acceptance: ["La ronda nueva se ve en el proyecto"],
        ordering: { after: ["T1"] },
      }),
      intent({ key: "T3", title: "Desplegar", kind: "release", ordering: "end-of-batch" }),
      intent({ key: "T4", title: "Rastreo de envíos", kind: "feature", ordering: "deferred" }),
    ])
    const tasks = parseTasks(docs.tasks)
    // Desplegar va al cierre del lote; lo diferido, al backlog.
    expect(tasks.map((t) => [t.key, t.phase, t.frontier, t.after])).toEqual([
      ["T1", 1, ["features/projects/**"], []],
      ["T2", 2, ["features/projects/round/**"], ["T1"]],
    ])
    expect(tasks.map((t) => t.requirements)).toEqual([["R1"], ["R2"]])
    expect(parseSpec(docs.spec).map((r) => [r.id, r.scenarios.length])).toEqual([
      ["R1", 1],
      ["R2", 1],
    ])
    expect(docs.brief).toContain("Rastreo de envíos (diferido)")
    expect(docs.brief).toContain("## Al cierre del lote\n\n- Desplegar")
  })
})

describe("fuentes", () => {
  test("encabezados, párrafos e ítems de lista son pasajes con ancla", () => {
    const p = passagesOf(
      "# Minuta\n\nQuedamos en separar Proyectos\nde Pedidos.\n\n## Pendientes\n- Pines del Lab\n- Resueltos en verde\n",
    )
    expect(p).toEqual([
      { anchor: "§1", heading: "Minuta", text: "Quedamos en separar Proyectos de Pedidos." },
      { anchor: "§2", heading: "Pendientes", text: "Pines del Lab" },
      { anchor: "§3", heading: "Pendientes", text: "Resueltos en verde" },
    ])
  })
})
