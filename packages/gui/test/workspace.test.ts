import { describe, expect, test } from "bun:test"
import type { EventNotification } from "@keel/core"
import { approvalCanResolve } from "../src/approvals.js"
import { DEMO_PROJECT, demoRuns, demoTasks, makeDemoApprovals } from "../src/fixtures.js"
import {
  actorLabel,
  applyEvent,
  filterTasks,
  formatCost,
  mergeReplay,
  summarizeEvent,
  touchesInbox,
} from "../src/model.js"

const task = demoTasks[0]
if (!task) throw new Error("Fixture ausente")
function event(revision: number, project_id = DEMO_PROJECT): EventNotification {
  return {
    event_seq: revision + 1,
    kind: "work_item.updated",
    project_id,
    run_id: null,
    received_at: "2026-10-14T00:00:00Z",
    payload: { ...task, title: `rev ${revision}`, revision },
  }
}
describe("workspace GUI", () => {
  test("replay previo a subscribe no revierte una revisión nueva", () => {
    const snapshot = { work_items: [{ ...task, revision: 3 }], runs: [] }
    const merged = mergeReplay(snapshot, [event(2), event(4), event(1)], DEMO_PROJECT)
    expect(merged.work_items[0]?.revision).toBe(4)
    expect(merged.work_items[0]?.title).toBe("rev 4")
    expect(merged.work_items).toHaveLength(1)
    expect(applyEvent(merged, event(8, "other-project"), DEMO_PROJECT)).toBe(merged)
  })
  test("filtro Needs you usa los estados canónicos y admite consulta por ID", () => {
    expect(
      filterTasks(demoTasks, "", true, "all").every((item) =>
        ["needs_review", "waiting_human"].includes(item.visual_state),
      ),
    ).toBe(true)
    expect(filterTasks(demoTasks, "KEEL-142 refresh", false, "frontend")).toHaveLength(1)
    expect(filterTasks(demoTasks, "KEEL-142", false, "backend")).toHaveLength(0)
  })
  test("costo desconocido nunca se presenta como cero dólares", () => {
    expect(formatCost()).toBe("Costo desconocido")
    expect(formatCost({ cost_kind: "unknown", total_cost_micro_usd: 0 })).not.toContain("$")
    expect(formatCost({ cost_kind: "estimated", total_cost_micro_usd: 0 })).toBe("$0.00 estimado")
    expect(formatCost(demoRuns[0])).toBe("$1.84 estimado")
  })
  test("TTL, estado y operación completa son necesarios para aprobar", () => {
    const approval = makeDemoApprovals()[0]
    if (!approval) throw new Error("Fixture ausente")
    expect(approvalCanResolve(approval, approval.expiresAt - 1, true)).toBe(true)
    expect(approvalCanResolve(approval, approval.expiresAt, true)).toBe(false)
    expect(approvalCanResolve({ ...approval, operation: null }, Date.now(), true)).toBe(false)
    expect(approvalCanResolve({ ...approval, state: "approved" }, Date.now(), true)).toBe(false)
    expect(approvalCanResolve(approval, Date.now(), false)).toBe(false)
  })
})

describe("modo live: identidad y resumen de eventos", () => {
  test("lo que firma un agente nunca se presenta como del humano", () => {
    expect(actorLabel("agent:ext:01ABC")).toMatchObject({ role: "external" })
    expect(actorLabel("agent:01RUN0000000000")).toMatchObject({ role: "agent" })
    expect(actorLabel("human")).toMatchObject({ role: "human", label: "Tú" })
  })
  test("el Inbox se relee con aprobaciones, emparejamientos y peticiones de run", () => {
    for (const k of ["approval.requested", "session.pairing_requested", "run.requested"])
      expect(touchesInbox(k)).toBe(true)
    expect(touchesInbox("run.updated")).toBe(false)
  })
  test("el timeline resume herramientas y esconde el ruido", () => {
    const at = { event_seq: 1, project_id: "p", run_id: "r", received_at: "2026-10-23T00:00:00Z" }
    expect(
      summarizeEvent({
        ...at,
        kind: "hook.PreToolUse",
        payload: { tool_name: "Bash", tool_input: { command: "ls" } },
      }),
    ).toEqual({ title: "Herramienta · Bash", detail: '{"command":"ls"}' })
    expect(summarizeEvent({ ...at, kind: "projection.updated", payload: {} })).toBeNull()
  })
})
