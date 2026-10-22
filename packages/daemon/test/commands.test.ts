import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ErrorCode } from "@keel/core"
import { Daemon, type DaemonOptions, IpcClient } from "../src/index.ts"
import { initRepo } from "./git-fixture.ts"
import { replayQuery } from "./replay.ts"

// Cada test arranca su propio daemon: los casos de fallo no deben contaminar a otros.
const open: { daemon: Daemon; dir: string; client: IpcClient }[] = []
afterEach(async () => {
  for (const o of open.splice(0)) {
    await o.daemon.idle()
    o.client.close()
    o.daemon.stop()
    rmSync(o.dir, { recursive: true, force: true })
  }
})

let n = 0
const key = () => `cmd-${++n}`

async function boot(extra: Partial<DaemonOptions> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "keel-cmd-"))
  const calls = { query: 0 }
  const replay = replayQuery()
  const daemon = new Daemon({
    dbPath: join(dir, "keel.sqlite"),
    socketPath: join(dir, "keel.sock"),
    rootPath: initRepo(join(dir, "repo")),
    worktreesDir: join(dir, "worktrees"),
    ...extra,
    adapterDeps: {
      queryFn: (args) => {
        calls.query++
        return replay(args)
      },
      binary: "/fake/claude",
      ...extra.adapterDeps,
    },
  })
  daemon.start()
  const client = await IpcClient.connect(daemon.server.path)
  open.push({ daemon, dir, client })
  return { daemon, client, calls }
}

type WorkItemView = { id: string; lifecycle: string; revision: number }
const rpcOf = (p: Promise<unknown>) =>
  p.then(
    () => null,
    (e: { rpc?: { code: number; details?: unknown } }) => e.rpc ?? null,
  )

describe("K-04: mutación, eventos y recibo en una sola transacción", () => {
  test("si el recibo falla, no queda la tarea ni su evento; reintentar con la misma key crea una sola", async () => {
    const { daemon, client } = await boot()
    const db = daemon.store.db
    db.exec(`CREATE TRIGGER fail_receipt BEFORE INSERT ON command_receipts
             WHEN NEW.idempotency_key = 'boom' BEGIN SELECT RAISE(ABORT, 'fallo inyectado'); END`)
    const before = daemon.repo.lastEventSeq()
    const params = { request_id: "r1", idempotency_key: "boom", title: "atómica", kind: "chore" }
    const err = await rpcOf(client.call("work_items.create", params))
    expect(err?.code).toBe(ErrorCode.internal)
    expect(daemon.repo.listWorkItems(daemon.project.project_id)).toHaveLength(0)
    expect(daemon.repo.lastEventSeq()).toBe(before)

    db.exec("DROP TRIGGER fail_receipt")
    const a = (await client.call("work_items.create", params)) as WorkItemView
    const b = (await client.call("work_items.create", {
      ...params,
      request_id: "r2",
    })) as WorkItemView
    expect(b.id).toBe(a.id)
    expect(daemon.repo.listWorkItems(daemon.project.project_id)).toHaveLength(1)
  })

  test("los eventos de una mutación se publican después del commit, no antes", async () => {
    const { daemon, client } = await boot()
    const seen: { seq: number; committed: boolean }[] = []
    daemon.bus.subscribe((e) => {
      // si el evento se publicara dentro de la transacción, otra conexión no lo vería aún
      seen.push({ seq: e.event_seq, committed: !daemon.store.db.inTransaction })
    })
    await client.call("work_items.create", {
      request_id: "r",
      idempotency_key: key(),
      title: "publicada",
      kind: "chore",
    })
    expect(seen).toHaveLength(1)
    expect(seen[0]?.committed).toBe(true)
  })
})

describe("K-07: compare-and-set y transiciones legales", () => {
  test("expected_revision distinta es conflict y no cambia la tarea", async () => {
    const { daemon, client } = await boot()
    const w = (await client.call("work_items.create", {
      request_id: "r",
      idempotency_key: key(),
      title: "cas",
      kind: "chore",
    })) as WorkItemView
    const err = await rpcOf(
      client.call("work_items.transition", {
        request_id: "r",
        idempotency_key: key(),
        work_item_id: w.id,
        to: "planned",
        expected_revision: 999,
      }),
    )
    expect(err).toMatchObject({
      code: ErrorCode.conflict,
      details: { expected_revision: 999, current_revision: 0 },
    })
    expect(daemon.repo.getWorkItem(w.id)).toMatchObject({ lifecycle: "triage", revision: 0 })

    const ok = (await client.call("work_items.transition", {
      request_id: "r",
      idempotency_key: key(),
      work_item_id: w.id,
      to: "planned",
      expected_revision: 0,
    })) as WorkItemView
    expect(ok).toMatchObject({ lifecycle: "planned", revision: 1 })
  })

  test("el protocolo no puede saltar al supervisor: triage → running y blocked → planned se rechazan", async () => {
    const { daemon, client } = await boot()
    const { project_id } = daemon.project
    const w = daemon.repo.createWorkItem({ project_id, title: "salto", kind: "chore" })
    const jump = await rpcOf(
      client.call("work_items.transition", {
        request_id: "r",
        idempotency_key: key(),
        work_item_id: w.id,
        to: "running",
      }),
    )
    expect(jump).toMatchObject({
      code: ErrorCode.invalidTransition,
      details: { from: "triage", to: "running", allowed: ["planned"] },
    })
    daemon.repo.setLifecycle(w.id, "planned", { from: "triage" })
    daemon.repo.setLifecycle(w.id, "blocked", { from: "planned" })
    const unblock = await rpcOf(
      client.call("work_items.transition", {
        request_id: "r",
        idempotency_key: key(),
        work_item_id: w.id,
        to: "planned",
      }),
    )
    expect(unblock?.code).toBe(ErrorCode.invalidTransition)
    expect(daemon.repo.getWorkItem(w.id)?.lifecycle).toBe("blocked")
  })

  test("setLifecycle es compare-and-set sobre el lifecycle de origen", async () => {
    const { daemon } = await boot()
    const w = daemon.repo.createWorkItem({
      project_id: daemon.project.project_id,
      title: "cas",
      kind: "chore",
    })
    expect(daemon.repo.setLifecycle(w.id, "running", { from: "planned" })).toBeNull()
    expect(daemon.repo.setLifecycle(w.id, "planned", { from: "triage", revision: 5 })).toBeNull()
    expect(
      daemon.repo.setLifecycle(w.id, "planned", { from: "triage", revision: 0 }),
    ).toMatchObject({ lifecycle: "planned", revision: 1 })
  })
})

describe("K-02: runs.start valida elegibilidad antes de crear o despachar", () => {
  test("blocked, triage con execute, planned con plan y bloqueos abiertos no crean run ni llaman al SDK", async () => {
    const { daemon, client, calls } = await boot()
    const { project_id } = daemon.project
    const start = (work_item_id: string, purpose: string) =>
      rpcOf(
        client.call("runs.start", {
          request_id: "r",
          idempotency_key: key(),
          work_item_id,
          purpose,
        }),
      )

    const blocked = daemon.repo.createWorkItem({ project_id, title: "bloqueada", kind: "chore" })
    daemon.repo.setLifecycle(blocked.id, "planned", { from: "triage" })
    daemon.repo.setLifecycle(blocked.id, "blocked", { from: "planned" })
    expect(await start(blocked.id, "execute")).toMatchObject({
      code: ErrorCode.invalidTransition,
      details: { lifecycle: "blocked", required: "planned" },
    })

    const triage = daemon.repo.createWorkItem({ project_id, title: "sin plan", kind: "chore" })
    expect((await start(triage.id, "execute"))?.code).toBe(ErrorCode.invalidTransition)

    const planned = daemon.repo.createWorkItem({ project_id, title: "planeada", kind: "chore" })
    daemon.repo.setLifecycle(planned.id, "planned", { from: "triage" })
    expect((await start(planned.id, "plan"))?.code).toBe(ErrorCode.invalidTransition)

    for (const kind of ["budget", "human", "dependency"] as const) {
      const guarded = daemon.repo.createWorkItem({ project_id, title: kind, kind: "chore" })
      daemon.repo.setLifecycle(guarded.id, "planned", { from: "triage" })
      daemon.repo.addBlock({ work_item_id: guarded.id, kind, reason_key: `${kind}:1` })
      expect(await start(guarded.id, "execute")).toMatchObject({
        code: ErrorCode.invalidTransition,
        details: { blocks: [{ kind, reason_key: `${kind}:1` }] },
      })
    }

    await new Promise((r) => setTimeout(r, 30))
    expect(calls.query).toBe(0)
    for (const w of daemon.repo.listWorkItems(project_id))
      expect(daemon.repo.liveRunFor(w.id)).toBeNull()
    expect(daemon.repo.listRuns(project_id)).toHaveLength(0)
  })

  test("un run plan arranca desde triage sin mover el lifecycle", async () => {
    const { daemon, client } = await boot()
    const w = daemon.repo.createWorkItem({
      project_id: daemon.project.project_id,
      title: "plan",
      kind: "chore",
    })
    await client.call("runs.start", {
      request_id: "r",
      idempotency_key: key(),
      work_item_id: w.id,
      purpose: "plan",
    })
    expect(daemon.repo.getWorkItem(w.id)?.lifecycle).toBe("triage")
  })
})

describe("K-08: un fallo de configuración termina el run, no lo deja vivo", () => {
  test("api_key sin clave: run failed antes del spawn, evento, tarea failed y un segundo intento no topa con un zombie", async () => {
    const { daemon, client, calls } = await boot({
      profile: { auth_mode: "api_key" },
      adapterDeps: { env: {} },
    })
    const kinds: string[] = []
    daemon.bus.subscribe((e) => kinds.push(e.kind))
    const w = daemon.repo.createWorkItem({
      project_id: daemon.project.project_id,
      title: "sin clave",
      kind: "chore",
    })
    daemon.repo.setLifecycle(w.id, "planned", { from: "triage" })
    const run = (await client.call("runs.start", {
      request_id: "r",
      idempotency_key: key(),
      work_item_id: w.id,
      purpose: "execute",
    })) as { id: string }
    await daemon.idle()
    expect(daemon.repo.getRun(run.id)).toMatchObject({
      status: "failed",
      end_reason: "fatal_error",
    })
    expect(daemon.repo.getWorkItem(w.id)?.lifecycle).toBe("failed")
    expect(kinds).toContain("run.start_failed")
    expect(calls.query).toBe(0)
    expect(daemon.claude.activeRuns).toBe(0)

    await client.call("work_items.transition", {
      request_id: "r",
      idempotency_key: key(),
      work_item_id: w.id,
      to: "planned",
    })
    const again = await rpcOf(
      client.call("runs.start", {
        request_id: "r",
        idempotency_key: key(),
        work_item_id: w.id,
        purpose: "execute",
      }),
    )
    expect(again).toBeNull()
  })

  test("un adaptador que lanza dentro de execute no deja el run vivo ni rechaza sin manejar", async () => {
    const { daemon, client } = await boot()
    daemon.claude.execute = () => Promise.reject(new Error("adaptador roto"))
    const w = daemon.repo.createWorkItem({
      project_id: daemon.project.project_id,
      title: "rompe",
      kind: "chore",
    })
    daemon.repo.setLifecycle(w.id, "planned", { from: "triage" })
    const run = (await client.call("runs.start", {
      request_id: "r",
      idempotency_key: key(),
      work_item_id: w.id,
      purpose: "execute",
    })) as { id: string }
    await daemon.idle()
    expect(daemon.repo.getRun(run.id)?.status).toBe("failed")
    expect(daemon.repo.getWorkItem(w.id)?.lifecycle).toBe("failed")
  })
})
