/** ADR-0006 §4: mover una tarjeta es pedir la transición humana; nunca se salta una guarda. */
import { describe, expect, test } from "bun:test"
import { moveTarget, type WorkItem } from "../src/model.ts"

const item = (p: Partial<WorkItem>): WorkItem =>
  ({
    id: "w",
    project_id: "p",
    display_id: "KEEL-1",
    title: "t",
    lifecycle: "triage",
    board_status: "backlog",
    revision: 1,
    visual_state: "queued",
    ...p,
  }) as WorkItem

describe("mover tarjetas en el tablero", () => {
  test("Backlog, en espera, fallida o en revisión pasan a Ready", () => {
    expect(moveTarget(item({}), "todo")).toEqual({ to: "planned" })
    for (const lifecycle of ["waiting_human", "failed"] as const)
      expect(moveTarget(item({ lifecycle, board_status: "in_progress" }), "todo")).toEqual({
        to: "planned",
      })
    expect(
      moveTarget(item({ lifecycle: "needs_review", board_status: "in_review" }), "todo"),
    ).toEqual({
      to: "planned",
    })
  })

  test("lo demás vuelve con su motivo", () => {
    expect(moveTarget(item({}), "backlog")).toBeNull()
    expect(moveTarget(item({}), "in_progress")).toMatchObject({
      reason: expect.stringContaining("run"),
    })
    expect(moveTarget(item({}), "completed")).toMatchObject({
      reason: expect.stringContaining("cierre"),
    })
    expect(
      moveTarget(item({ lifecycle: "running", board_status: "in_progress" }), "todo"),
    ).toMatchObject({ reason: expect.stringContaining("running") })
    expect(
      moveTarget(item({ lifecycle: "planned", board_status: "todo" }), "backlog"),
    ).toMatchObject({
      reason: expect.stringContaining("Backlog"),
    })
  })

  test("una tarea del método avanza con sus gates, no arrastrándola", () => {
    expect(moveTarget(item({ stage: "brief" }), "todo")).toMatchObject({
      reason: expect.stringContaining("método"),
    })
  })
})
