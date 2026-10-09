import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import {
  conformanceTable,
  isVisualState,
  LIFECYCLES,
  LIVE_RUN_STATUSES,
  NEEDS_YOU,
  NODE_STATES,
  RUN_PURPOSES,
  RUN_STATUSES,
  VISUAL_FAMILIES,
  VISUAL_STATES,
  visualFallback,
  visualForNode,
  visualForRun,
  visualForWorkItem,
} from "../src/index.ts"

describe("ADR-0006: vocabulario de estados", () => {
  test("13 visuales, exactamente los del canvas más needs_review y paused", () => {
    expect(VISUAL_STATES).toHaveLength(13)
    expect(VISUAL_STATES).toContain("needs_review")
    expect(VISUAL_STATES).toContain("paused")
    expect(Object.keys(VISUAL_FAMILIES).sort()).toEqual([...VISUAL_STATES].sort())
  })

  test("toda combinación de tarea/run/nodo produce un visual válido (exhaustivo)", () => {
    for (const l of LIFECYCLES) {
      expect(isVisualState(visualForWorkItem(l, null))).toBe(true)
      for (const s of RUN_STATUSES)
        for (const p of RUN_PURPOSES)
          expect(isVisualState(visualForWorkItem(l, { status: s, purpose: p }))).toBe(true)
    }
    for (const s of RUN_STATUSES)
      for (const p of RUN_PURPOSES) expect(isVisualState(visualForRun(s, p))).toBe(true)
    for (const n of NODE_STATES) expect(isVisualState(visualForNode(n))).toBe(true)
  })

  test("decisiones del humano: needs_review ámbar con visual propio, paused neutro, planning sólo con run plan vivo", () => {
    expect(visualForWorkItem("needs_review", null)).toBe("needs_review")
    expect(VISUAL_FAMILIES.needs_review).toBe("amber")
    expect(VISUAL_FAMILIES.waiting_human).toBe("amber")
    expect(NEEDS_YOU).toEqual(["waiting_human", "needs_review"])
    expect(visualForRun("paused", "execute")).toBe("paused")
    expect(VISUAL_FAMILIES.paused).toBe("neutral")
    expect(visualForWorkItem("triage", { status: "running", purpose: "plan" })).toBe("planning")
    expect(visualForWorkItem("triage", { status: "interrupted", purpose: "plan" })).toBe("queued")
    expect(visualForWorkItem("triage", { status: "running", purpose: "execute" })).toBe("queued")
    expect(visualForWorkItem("planned", { status: "running", purpose: "plan" })).toBe("queued")
    expect(visualForRun("running", "plan")).toBe("planning")
    expect(visualForRun("waiting_human", "plan")).toBe("waiting_human")
  })

  test("interrupted y rate limit no son failed; budget_exceeded es budget_stop", () => {
    expect(visualForRun("interrupted", "execute")).toBe("interrupted")
    expect(visualForRun("budget_exceeded", "execute")).toBe("budget_stop")
    expect(visualForNode("orphan")).toBe("orphan")
  })

  test("runs vivos = los de idx_live_run del SDD 03", () => {
    expect([...LIVE_RUN_STATUSES].sort()).toEqual([
      "initializing",
      "paused",
      "queued",
      "running",
      "waiting_human",
    ])
  })

  test("fallback de cliente: neutro con el texto crudo", () => {
    expect(isVisualState("something_new")).toBe(false)
    expect(visualFallback("something_new")).toEqual({ family: "neutral", label: "something_new" })
  })

  test("la tabla de conformidad coincide con el fixture versionado", () => {
    const fixture = JSON.parse(
      readFileSync(join(import.meta.dir, "..", "fixtures", "visual-state.json"), "utf8"),
    )
    expect(conformanceTable()).toEqual(fixture)
    expect(fixture.length).toBe(
      LIFECYCLES.length * (1 + RUN_STATUSES.length * RUN_PURPOSES.length) +
        RUN_STATUSES.length * RUN_PURPOSES.length +
        NODE_STATES.length,
    )
  })
})
