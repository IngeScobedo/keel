import { describe, expect, test } from "bun:test"
import { agentName, leaseOf, stageOf, stepOf } from "../src/orchestration-model.js"

let seq = 0
const at = (kind: string, payload: unknown, run_id: string | null = "r1") => ({
  event_seq: ++seq,
  kind,
  payload,
  project_id: "p",
  run_id,
  received_at: "2026-11-02T00:00:00Z",
})
const runs = new Set(["r1"])

describe("ADR-0041: la etapa de la conversación", () => {
  test("sin runs está vacía; con charla es hilo", () => {
    expect(stageOf([], new Set())).toEqual({ kind: "empty" })
    expect(stageOf([at("sdk.assistant", {})], runs)).toEqual({ kind: "thread" })
  })

  test("un plan pendiente toma el foco; resuelto, manda el lote que nació", () => {
    const requested = at("approval.requested", {
      approval_id: "a1",
      operation_hash: "h",
      tool: "batch.plan",
      input: { plan: { title: "Lote" } },
    })
    expect(stageOf([requested], runs)).toMatchObject({
      kind: "plan",
      plan: { approval_id: "a1", tool: "batch.plan" },
    })
    const started = at("batch.started", { batch: { id: "w9", display_id: "KEEL-13" } })
    expect(
      stageOf([requested, at("approval.resolved", { approval_id: "a1" }), started], runs),
    ).toEqual({ kind: "batch", batch: { id: "w9", display_id: "KEEL-13" } })
    // Otra conversación no cuenta.
    expect(stageOf([at("batch.started", { batch: { id: "x" } }, "otro")], runs)).toEqual({
      kind: "thread",
    })
  })

  test("las etiquetas de un carril", () => {
    expect(agentName({ provider: "claude", model: "claude-opus-5-5" })).toBe("Claude · Opus")
    expect(agentName({ provider: "codex" })).toBe("Codex")
    expect(agentName(null)).toBe("Claude")
    expect(leaseOf(["apps/store/**", "docs/x.md"])).toBe("apps/store/** +1")
    expect(leaseOf([])).toBe("sin frontera")
    expect(stepOf("implement")).toEqual({ n: 3, of: 5 })
  })
})
