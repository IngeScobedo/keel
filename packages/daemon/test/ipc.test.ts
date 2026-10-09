import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ErrorCode, type EventNotification } from "@keel/core"
import { Daemon, IpcClient } from "../src/index.ts"
import { hangingQuery, replayQuery } from "./replay.ts"

let dir: string
let daemon: Daemon
const key = (() => {
  let n = 0
  return () => `k${++n}`
})()

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "keel-ipc-"))
  daemon = new Daemon({
    dbPath: join(dir, "keel.sqlite"),
    socketPath: join(dir, "keel.sock"),
    rootPath: dir,
    adapterDeps: {
      queryFn: (args) => (args.prompt === "hang" ? hangingQuery() : replayQuery())(args),
      binary: "/fake/claude",
    },
  })
  daemon.start()
})
afterAll(() => {
  daemon.stop()
  rmSync(dir, { recursive: true, force: true })
})

describe("servidor IPC (ADR-0005)", () => {
  test("el socket es 0600 y daemon.health responde con lag del loop", async () => {
    expect(statSync(daemon.server.path).mode & 0o777).toBe(0o600)
    const c = await IpcClient.connect(daemon.server.path)
    const h = (await c.call("daemon.health", {})) as { version: string; event_loop_lag_ms: number }
    expect(typeof h.event_loop_lag_ms).toBe("number")
    c.close()
  })

  test("frames sin keel_protocol o rotos reciben error estructurado sin cerrar la conexión", async () => {
    const c = await IpcClient.connect(daemon.server.path)
    const errors: unknown[] = []
    c.onNotification((m, p) => {
      if (m === "protocol.error") errors.push(p)
    })
    c.raw(JSON.stringify({ jsonrpc: "2.0", id: 9, method: "daemon.health" }))
    c.raw("{nope")
    await new Promise((r) => setTimeout(r, 100))
    // el error con id 9 llega como respuesta de error: la promesa no existe, así que
    // comprobamos que la conexión sigue viva con una llamada válida
    const h = await c.call("daemon.health", {})
    expect(h).toBeDefined()
    expect(errors.length).toBeGreaterThanOrEqual(1)
    c.close()
  })

  test("mutación idempotente por recibo: misma key devuelve el mismo resultado; otra request con la misma key es error", async () => {
    const c = await IpcClient.connect(daemon.server.path)
    const k = key()
    const a = (await c.call("work_items.create", {
      request_id: "r1",
      idempotency_key: k,
      title: "Tarea A",
      kind: "feature",
    })) as { id: string; display_id: string; visual_state: string }
    const b = (await c.call("work_items.create", {
      request_id: "r2",
      idempotency_key: k,
      title: "Tarea A",
      kind: "feature",
    })) as { id: string }
    expect(b.id).toBe(a.id)
    expect(a.visual_state).toBe("queued")
    await expect(
      c.call("work_items.create", {
        request_id: "r3",
        idempotency_key: k,
        title: "Otra",
        kind: "feature",
      }),
    ).rejects.toMatchObject({ rpc: { code: ErrorCode.idempotencyMismatch } })
    expect(daemon.repo.listWorkItems(daemon.project.project_id)).toHaveLength(1)
    c.close()
  })

  test("events.subscribe: snapshot con visual_state, replay desde el cursor y stream en vivo", async () => {
    const c = await IpcClient.connect(daemon.server.path)
    const got: EventNotification[] = []
    c.onEvent((n) => got.push(n))
    const sub = (await c.call("events.subscribe", {
      project_id: daemon.project.project_id,
      after_event_seq: 0,
    })) as { cursor: number; snapshot: { work_items: { visual_state: string }[] } }
    expect(sub.snapshot.work_items).toHaveLength(1)
    expect(sub.snapshot.work_items[0]?.visual_state).toBe("queued")
    await new Promise((r) => setTimeout(r, 50))
    const replayed = got.length
    expect(replayed).toBeGreaterThanOrEqual(1) // work_item.created
    await c.call("work_items.create", {
      request_id: "r4",
      idempotency_key: key(),
      title: "Tarea B",
      kind: "bug",
    })
    await new Promise((r) => setTimeout(r, 50))
    expect(got.length).toBe(replayed + 1)
    expect(got.at(-1)?.kind).toBe("work_item.created")
    const seqs = got.map((g) => g.event_seq)
    expect([...seqs].sort((x, y) => x - y)).toEqual(seqs)
    c.close()
  })

  test("runs.start: un run vivo bloquea el segundo; cancelar lo libera; la corrida grabada termina en needs_review", async () => {
    const c = await IpcClient.connect(daemon.server.path)
    const updates: { status?: string }[] = []
    c.onEvent((n) => {
      if (n.kind === "run.updated") updates.push(n.payload as { status?: string })
    })
    await c.call("events.subscribe", { after_event_seq: daemon.repo.lastEventSeq() })
    const w = daemon.repo.createWorkItem({
      project_id: daemon.project.project_id,
      title: "runs",
      kind: "chore",
    })
    const hang = (await c.call("runs.start", {
      request_id: "r5",
      idempotency_key: key(),
      work_item_id: w.id,
      purpose: "execute",
      prompt: "hang",
    })) as { id: string; visual_state: string }
    expect(hang.visual_state).toBe("queued")
    let second: unknown = "resolved"
    try {
      second = await c.call("runs.start", {
        request_id: "r6",
        idempotency_key: key(),
        work_item_id: w.id,
        purpose: "execute",
      })
    } catch (e) {
      second = (e as { rpc?: unknown }).rpc ?? e
    }
    expect(second).toMatchObject({ code: ErrorCode.conflict })
    await c.call("runs.cancel", { request_id: "r6b", idempotency_key: key(), run_id: hang.id })
    for (let i = 0; i < 100 && daemon.repo.getRun(hang.id)?.status !== "cancelled"; i++)
      await new Promise((r) => setTimeout(r, 10))
    expect(daemon.repo.getRun(hang.id)?.status).toBe("cancelled")
    expect(daemon.repo.toolCallsOfRun(hang.id).map((t) => t.state)).toEqual(["cancelled"])

    const run = (await c.call("runs.start", {
      request_id: "r7",
      idempotency_key: key(),
      work_item_id: w.id,
      purpose: "execute",
      prompt: "lista",
    })) as { id: string }
    for (let i = 0; i < 200 && !updates.some((u) => u.status === "completed"); i++)
      await new Promise((r) => setTimeout(r, 20))
    expect(updates.some((u) => u.status === "completed")).toBe(true)
    const item = daemon.repo.getWorkItem(w.id)
    expect(item?.lifecycle).toBe("needs_review")
    expect(daemon.repo.workItemView(item as NonNullable<typeof item>).visual_state).toBe(
      "needs_review",
    )
    expect(daemon.repo.toolCallsOfRun(run.id)).toHaveLength(2)
    c.close()
  })

  test("work_items.transition a done está vedado al protocolo (cierre humano explícito)", async () => {
    const c = await IpcClient.connect(daemon.server.path)
    const w = daemon.repo.listWorkItems(daemon.project.project_id)[0] as { id: string }
    await expect(
      c.call("work_items.transition", {
        request_id: "r7",
        idempotency_key: key(),
        work_item_id: w.id,
        to: "done",
      }),
    ).rejects.toMatchObject({ rpc: { code: ErrorCode.invalidTransition } })
    c.close()
  })

  test("reconciliación al arrancar: un run vivo de un daemon anterior queda interrupted", () => {
    const { project_id } = daemon.project
    const w = daemon.repo.createWorkItem({ project_id, title: "zombie", kind: "chore" })
    const run = daemon.repo.createRun({
      project_id,
      work_item_id: w.id,
      purpose: "execute",
      manifest: { provider_process: { pid: 999999999, cwd: dir } },
    })
    daemon.repo.updateRun(run.id, { status: "running" })
    const r = daemon.reconcile()
    expect(r.interrupted).toContain(run.id)
    expect(daemon.repo.getRun(run.id)?.status).toBe("interrupted")
  })
})
