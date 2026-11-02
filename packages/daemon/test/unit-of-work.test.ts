/**
 * Los eventos de una unidad de trabajo se publican en orden y antes de sus demás efectos.
 * KEEL-15: un efecto (arrancar las hijas de la feature) abrió otra unidad que publicó
 * eventos más nuevos antes del `done` de la tarea, y el cliente descartó ese `done`.
 */
import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runUnitOfWork } from "../src/command.ts"
import { EventBus, openStore, Repo } from "../src/index.ts"

const cleanup: (() => void)[] = []
afterEach(() => {
  for (const f of cleanup.splice(0)) f()
})

describe("unidad de trabajo", () => {
  test("un efecto que abre otra unidad no adelanta sus eventos a los de ésta", () => {
    const dir = mkdtempSync(join(tmpdir(), "keel-uow-"))
    const store = openStore(join(dir, "keel.sqlite"), { loadVector: false })
    cleanup.push(() => {
      store.db.close()
      rmSync(dir, { recursive: true, force: true })
    })
    const repo = new Repo(store.db)
    const bus = new EventBus()
    const seen: number[] = []
    bus.subscribe((e) => seen.push(e.event_seq))
    const { project_id } = repo.ensureDefaultProject(dir)
    const deps = { db: store.db, repo, bus }
    const scope = { projectId: project_id, actorId: "system:test" }

    runUnitOfWork(deps, scope, (uow) => {
      uow.emit("work_item.updated", null, { lifecycle: "needs_review" })
      uow.afterCommit(() =>
        runUnitOfWork(deps, scope, (inner) =>
          inner.emit("work_item.updated", null, { otra: true }),
        ),
      )
      uow.emit("work_item.updated", null, { lifecycle: "done" })
    })

    expect(seen).toHaveLength(3)
    expect(seen).toEqual([...seen].sort((a, b) => a - b))
  })
})
