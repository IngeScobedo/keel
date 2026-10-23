/**
 * Backup y restore (SDD 03 §7, DoD de la Fase 0): consistente con WAL mientras
 * el daemon escribe, verificado por hash, y la base restaurada pasa
 * integrity_check, foreign_key_check y FTS, y vuelve a servir.
 */
import { afterEach, describe, expect, test } from "bun:test"
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  BackupError,
  backupStore,
  Daemon,
  IpcClient,
  openStore,
  restoreStore,
} from "../src/index.ts"
import { initRepo } from "./git-fixture.ts"
import { replayQuery } from "./replay.ts"

const dirs: string[] = []
const daemons: Daemon[] = []
afterEach(async () => {
  for (const d of daemons.splice(0)) {
    await d.idle()
    d.stop()
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function boot(dir: string, dbPath = join(dir, "keel.sqlite")): Daemon {
  const d = new Daemon({
    dbPath,
    socketPath: join(dir, `${Math.random().toString(36).slice(2)}.sock`),
    rootPath: join(dir, "repo"),
    worktreesDir: join(dir, "worktrees"),
    adapterDeps: { queryFn: replayQuery(), binary: "/fake/claude" },
  })
  d.start()
  daemons.push(d)
  return d
}

let n = 0
const key = () => `bk-${++n}`

/** Proyecto con una tarea que pasó por un run completo: hay filas en casi todas las tablas. */
async function populated() {
  const dir = mkdtempSync(join(tmpdir(), "keel-backup-"))
  dirs.push(dir)
  initRepo(join(dir, "repo"))
  const d = boot(dir)
  const c = await IpcClient.connect(d.server.path)
  const w = (await c.call("work_items.create", {
    request_id: "r",
    idempotency_key: key(),
    title: "respaldar",
    kind: "chore",
  })) as { id: string }
  await c.call("work_items.transition", {
    request_id: "r",
    idempotency_key: key(),
    work_item_id: w.id,
    to: "planned",
  })
  await c.call("runs.start", {
    request_id: "r",
    idempotency_key: key(),
    work_item_id: w.id,
    purpose: "execute",
  })
  await d.idle()
  c.close()
  return { dir, d, workItemId: w.id }
}

const count = (db: Daemon["store"]["db"], table: string) =>
  db.query<{ n: number }, []>(`SELECT count(*) n FROM ${table}`).get()?.n ?? 0
const TABLES = [
  "events",
  "work_items",
  "runs",
  "agent_instances",
  "tool_calls",
  "run_worktrees",
  "command_receipts",
  "outbox",
]

describe("backup y restore del store", () => {
  test("el backup incluye lo que aún está en el WAL y el restore pasa todas las comprobaciones", async () => {
    const { dir, d } = await populated()
    // filas recién escritas, todavía sin checkpoint al archivo principal
    for (let i = 0; i < 50; i++)
      d.repo.appendEvent({
        project_id: d.project.project_id,
        run_id: null,
        source: "test",
        source_event_key: `wal:${i}`,
        fidelity: "full",
        adapter_version: "test/0",
        kind: "test.wal",
        occurred_at: null,
        payload_json: "{}",
      })
    const before = Object.fromEntries(TABLES.map((t) => [t, count(d.store.db, t)]))
    expect(before.run_worktrees).toBe(1)

    // copiar sólo el archivo principal con el daemon vivo pierde lo del WAL (lo que SDD 03 §7 prohíbe)
    copyFileSync(d.store.path, join(dir, "naive.sqlite"))
    const naive = openStore(join(dir, "naive.sqlite"), { loadVector: false })
    expect(count(naive.db, "events")).toBeLessThan(before.events as number)
    naive.db.close()

    const { manifestPath, manifest } = backupStore(d.store, join(dir, "backups"))
    expect(manifest).toMatchObject({ version: 1, source: d.store.path })
    expect(manifest.migrations.map((m) => m.id)).toContain("0001-initial")

    const target = join(dir, "restored", "keel.sqlite")
    const report = restoreStore(manifestPath, target, { loadVector: false })
    expect(report).toMatchObject({ integrity: "ok", foreign_key_violations: 0, fts: "ok" })
    const restored = openStore(target, { loadVector: false })
    expect(Object.fromEntries(TABLES.map((t) => [t, count(restored.db, t)]))).toEqual(before)
    restored.db.close()
  })

  test("la base restaurada vuelve a servir: un daemon sobre ella entrega el historial por el protocolo", async () => {
    const { dir, d, workItemId } = await populated()
    const { manifestPath } = backupStore(d.store, join(dir, "backups"))
    const target = join(dir, "restored.sqlite")
    restoreStore(manifestPath, target, { loadVector: false })
    const r = boot(dir, target)
    const c = await IpcClient.connect(r.server.path)
    const sub = (await c.call("events.subscribe", {
      project_id: r.project.project_id,
      after_event_seq: 0,
    })) as { cursor: number; snapshot: { work_items: { id: string; lifecycle: string }[] } }
    expect(sub.cursor).toBe(d.repo.lastEventSeq())
    expect(sub.snapshot.work_items).toEqual([
      expect.objectContaining({ id: workItemId, lifecycle: "needs_review" }),
    ])
    c.close()
  })

  test("un backup alterado, un manifest ajeno o una base existente se rechazan sin escribir nada", async () => {
    const { dir, d } = await populated()
    const { manifestPath, manifest } = backupStore(d.store, join(dir, "backups"))
    const file = join(dir, "backups", manifest.file)

    expect(() => restoreStore(manifestPath, d.store.path)).toThrow(BackupError)

    const bytes = readFileSync(file)
    bytes[bytes.length - 100] = (bytes[bytes.length - 100] ?? 0) ^ 0xff
    writeFileSync(file, bytes)
    const target = join(dir, "x.sqlite")
    expect(() => restoreStore(manifestPath, target)).toThrow(/sha256/)
    expect(() => readFileSync(target)).toThrow()
  })
})
