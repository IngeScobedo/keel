/** ADR-0034 §5: lo que la vista de tarea decide con código. */
import { describe, expect, test } from "bun:test"
import type { TaskFlowView } from "@keel/core"
import type { Run, WorkItem } from "../src/model.ts"
import {
  attentionKey,
  checklistOf,
  dagOf,
  lanesOf,
  nextAction,
  splitUnified,
} from "../src/task-model.ts"

const item = (p: Partial<WorkItem>): WorkItem =>
  ({
    id: "w",
    project_id: "p",
    display_id: "KEEL-1",
    title: "t",
    lifecycle: "planned",
    board_status: "todo",
    revision: 1,
    visual_state: "queued",
    ...p,
  }) as WorkItem
const run = (p: Partial<Run>): Run =>
  ({ id: "r", work_item_id: "w", status: "completed", ...p }) as Run
const flow = (p: Partial<TaskFlowView>): TaskFlowView =>
  ({ stage: "implement", pending_gate: null, git_plan: null, ...p }) as TaskFlowView

const TASKS = `## Fase 1 — Datos
- [ ] T1 Modelo → \`api/**\` → R1
- [ ] T2 Migración → \`db/**\` → R1
## Fase 2 — Vista
- [ ] T3 Pantalla → \`web/**\` → R2 (después de T1)
`
const SPEC = `## Requisitos
### R1 — Capítulos guardados
#### Escenario: guardar
- **Dado** x
- **Cuando** y
- **Entonces** z
### R2 — Capítulos visibles
### R3 — Orden
`

describe("vista de tarea", () => {
  test("una sola acción, en orden de urgencia", () => {
    expect(nextAction(item({}), null, [], 0)).toEqual({ kind: "work", label: "Trabajar" })
    const gate = flow({
      pending_gate: { approval_id: "a", operation_hash: "h", gate: "close", to: "close" },
      git_plan: { plan_id: "p", run_id: "r", state: "pending", reason: null, done: [] },
    })
    expect(nextAction(item({}), gate, [run({})], 2).kind).toBe("gate")
    const plan = flow({
      git_plan: { plan_id: "p", run_id: "r", state: "pending", reason: null, done: [] },
    })
    expect(nextAction(item({}), plan, [run({})], 2).kind).toBe("plan")
    expect(nextAction(item({}), flow({}), [run({ status: "running" })], 1).label).toBe(
      "Decidir 1 permiso",
    )
    expect(nextAction(item({}), flow({}), [run({ status: "running" })], 0).kind).toBe("watch")
    expect(nextAction(item({ lifecycle: "done" }), plan, [], 3).kind).toBe("none")
    expect(attentionKey(plan)).toBe("plan:p")
    expect(attentionKey(flow({}))).toBeNull()
  })

  test("el DAG une cada línea de tasks con su subtarea", () => {
    const subs = [
      item({ id: "a", subtask: { key: "T1", phase: 1, phase_title: "Datos" }, lifecycle: "done" }),
      item({ id: "c", subtask: { key: "T3", phase: 2, phase_title: "Vista" } }),
    ]
    const dag = dagOf(TASKS, subs)
    expect(dag.phases.map((p) => [p.phase, p.title, p.nodes.map((n) => n.key)])).toEqual([
      [1, "Datos", ["T1", "T2"]],
      [2, "Vista", ["T3"]],
    ])
    expect(dag.phases[0]?.nodes[0]?.item?.id).toBe("a")
    expect(dag.phases[0]?.nodes[1]?.item).toBeNull()
    expect(dag.edges).toContainEqual({ from: "T1", to: "T3" })
  })

  test("la checklist sale del spec: subtareas que lo citan o el QA", () => {
    const subs = [
      item({ id: "a", subtask: { key: "T1", phase: 1, phase_title: "" }, lifecycle: "done" }),
      item({ id: "b", subtask: { key: "T2", phase: 1, phase_title: "" }, lifecycle: "running" }),
      item({ id: "c", subtask: { key: "T3", phase: 2, phase_title: "" }, lifecycle: "done" }),
    ]
    const lines = checklistOf(SPEC, TASKS, subs, null)
    expect(lines.map((l) => [l.id, l.done, l.why])).toEqual([
      ["R1", false, "falta T2"],
      ["R2", true, "T3 integradas"],
      ["R3", false, "ninguna subtarea lo cita"],
    ])
    expect(lines[0]?.scenarios).toBe(1)
    const solo = checklistOf(SPEC, null, [], "## Veredicto: PASS\n")
    expect(solo.every((l) => l.done && l.why === "QA PASS")).toBe(true)
    expect(checklistOf(SPEC, null, [], null)[0]?.why).toBe("sin QA todavía")
  })

  test("carriles: una subtarea con run vivo trabaja; al terminar pasa a hechas", () => {
    const a = item({ id: "a" })
    const b = item({ id: "b", lifecycle: "blocked" })
    const c = item({ id: "c", lifecycle: "done" })
    const d = item({ id: "d", lifecycle: "needs_review" })
    const e = item({ id: "e" })
    const lanes = lanesOf(
      [a, b, c, d, e],
      [run({ work_item_id: "a", status: "running" })],
      new Set(["e"]),
    )
    expect(lanes.waiting.map((x) => x.id)).toEqual(["d", "e"])
    expect(lanes.working.map((x) => x.id)).toEqual(["a"])
    expect(lanes.queued.map((x) => x.id)).toEqual(["b"])
    expect(lanes.done.map((x) => x.id)).toEqual(["c"])
  })

  test("el diff de git se parte por archivo", () => {
    const diff = `diff --git a/src/a.ts b/src/a.ts
index 1..2 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,2 +1,2 @@
 uno
-dos
+tres
diff --git a/b.md b/b.md
new file mode 100644
--- /dev/null
+++ b/b.md
@@ -0,0 +1 @@
+hola
`
    const files = splitUnified(diff)
    expect(files.map((f) => [f.path, f.added, f.removed])).toEqual([
      ["src/a.ts", 1, 1],
      ["b.md", 1, 0],
    ])
  })
})
