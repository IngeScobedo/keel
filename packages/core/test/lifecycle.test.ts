import { describe, expect, test } from "bun:test"
import {
  allowedTransitions,
  checkTransition,
  LIFECYCLE_EDGES,
  LIFECYCLES,
  type Lifecycle,
  lifecycleEdge,
  RUN_START_RULES,
} from "../src/index.ts"

describe("SDD 01 §3: máquina de estados de la tarea", () => {
  test("sin aristas duplicadas ni lifecycles fuera del vocabulario de ADR-0006", () => {
    const keys = LIFECYCLE_EDGES.map((e) => `${e.from}->${e.to}`)
    expect(new Set(keys).size).toBe(keys.length)
    for (const e of LIFECYCLE_EDGES) {
      expect(LIFECYCLES).toContain(e.from)
      expect(LIFECYCLES).toContain(e.to)
    }
  })

  test("done sólo se alcanza por cierre humano y es terminal", () => {
    const intoDone = LIFECYCLE_EDGES.filter((e) => e.to === "done")
    expect(intoDone).toEqual([{ from: "needs_review", to: "done", by: "human_close" }])
    expect(LIFECYCLE_EDGES.some((e) => e.from === "done")).toBe(false)
    expect(checkTransition("needs_review", "done", "human")).toMatchObject({
      ok: false,
      reason: "wrong_authority",
    })
  })

  test("todo lifecycle es alcanzable desde triage", () => {
    const seen = new Set<Lifecycle>(["triage"])
    for (let grew = true; grew; ) {
      grew = false
      for (const e of LIFECYCLE_EDGES)
        if (seen.has(e.from) && !seen.has(e.to)) {
          seen.add(e.to)
          grew = true
        }
    }
    expect([...seen].sort()).toEqual([...LIFECYCLES].sort())
  })

  test("el protocolo no puede saltarse al supervisor ni al scheduler", () => {
    expect(allowedTransitions("triage", "human")).toEqual(["planned"])
    expect(allowedTransitions("planned", "human")).toEqual([])
    expect(allowedTransitions("blocked", "human")).toEqual([])
    expect(checkTransition("triage", "running", "human")).toMatchObject({
      ok: false,
      reason: "no_such_transition",
    })
    expect(checkTransition("blocked", "planned", "human")).toMatchObject({
      ok: false,
      reason: "wrong_authority",
    })
    expect(checkTransition("failed", "planned", "human").ok).toBe(true)
  })

  test("las reglas de inicio de run usan aristas del sistema que existen", () => {
    for (const rule of Object.values(RUN_START_RULES)) {
      if (rule.from === rule.to) continue
      expect(lifecycleEdge(rule.from, rule.to)?.by).toBe("system")
    }
    expect(RUN_START_RULES.execute).toEqual({ from: "planned", to: "running" })
    expect(RUN_START_RULES.plan.from).toBe("triage")
  })
})
