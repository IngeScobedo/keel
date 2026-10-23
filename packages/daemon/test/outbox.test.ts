/**
 * Outbox (SDD 02 §2, DoD de la Fase 0): reiniciar entre el commit y la entrega
 * conserva el efecto; la entrega es al menos una vez y los handlers son
 * idempotentes. La «caída» se simula desactivando el drenaje del daemon A y
 * arrancando un daemon B sobre la misma base.
 */
import { afterEach, describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  Daemon,
  type DaemonOptions,
  IpcClient,
  Outbox,
  openStore,
  type QueryFn,
  Repo,
  RUN_DISPATCH,
  WORKTREE_RELEASE,
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

let n = 0
const key = () => `ob-${++n}`
const sh = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim()

function workspace() {
  const dir = mkdtempSync(join(tmpdir(), "keel-outbox-"))
  dirs.push(dir)
  initRepo(join(dir, "repo"))
  return dir
}

function start(dir: string, calls: { n: number }): Daemon {
  const queryFn: QueryFn = (args) => {
    calls.n++
    writeFileSync(join(String(args.options.cwd), "AGENTE.md"), "cambio\n")
    return replayQuery()(args)
  }
  const opts: DaemonOptions = {
    dbPath: join(dir, "keel.sqlite"),
    socketPath: join(dir, "keel.sock"),
    rootPath: join(dir, "repo"),
    worktreesDir: join(dir, "worktrees"),
    adapterDeps: { queryFn, binary: "/fake/claude" },
  }
  const d = new Daemon(opts)
  d.start()
  daemons.push(d)
  return d
}

/** Simula la caída: el daemon deja de entregar el outbox y se apaga sin drenarlo. */
function crashAfterCommit(d: Daemon): void {
  d.outbox.drain = async () => 0
}
async function shutdown(d: Daemon): Promise<void> {
  await d.idle()
  d.stop()
  daemons.splice(daemons.indexOf(d), 1)
}

async function plannedItem(c: IpcClient): Promise<{ id: string }> {
  const w = (await c.call("work_items.create", {
    request_id: "r",
    idempotency_key: key(),
    title: "outbox",
    kind: "chore",
  })) as { id: string }
  await c.call("work_items.transition", {
    request_id: "r",
    idempotency_key: key(),
    work_item_id: w.id,
    to: "planned",
  })
  return w
}

describe("outbox: reiniciar entre commit y entrega conserva el efecto (DoD Fase 0)", () => {
  test("runs.start confirmado y no despachado: el daemon siguiente lo despacha, no lo interrumpe", async () => {
    const dir = workspace()
    const calls = { n: 0 }
    const a = start(dir, calls)
    const ca = await IpcClient.connect(a.server.path)
    const w = await plannedItem(ca)
    crashAfterCommit(a)
    const run = (await ca.call("runs.start", {
      request_id: "r",
      idempotency_key: key(),
      work_item_id: w.id,
      purpose: "execute",
    })) as { id: string }
    ca.close()
    await shutdown(a)
    expect(calls.n).toBe(0)

    const b = start(dir, calls)
    await b.idle()
    expect(b.repo.getRun(run.id)?.status).toBe("completed")
    expect(b.repo.getWorkItem(w.id)?.lifecycle).toBe("needs_review")
    expect(calls.n).toBe(1)
    expect(b.repo.getOutbox(`${RUN_DISPATCH}:${run.id}`)).toMatchObject({ attempts: 1 })
    expect(b.repo.getOutbox(`${RUN_DISPATCH}:${run.id}`)?.delivered_at).not.toBeNull()
  })

  test("salir de needs_review confirmado sin liberar: el daemon siguiente libera y rescata", async () => {
    const dir = workspace()
    const calls = { n: 0 }
    const a = start(dir, calls)
    const ca = await IpcClient.connect(a.server.path)
    const w = await plannedItem(ca)
    const run = (await ca.call("runs.start", {
      request_id: "r",
      idempotency_key: key(),
      work_item_id: w.id,
      purpose: "execute",
    })) as { id: string }
    await a.idle()
    const [wt] = a.repo.runWorktrees(run.id)
    if (!wt) throw new Error("sin worktree")
    crashAfterCommit(a)
    await ca.call("work_items.transition", {
      request_id: "r",
      idempotency_key: key(),
      work_item_id: w.id,
      to: "planned",
    })
    ca.close()
    await shutdown(a)
    expect(existsSync(wt.worktree_path)).toBe(true)

    const b = start(dir, calls)
    await b.idle()
    expect(existsSync(wt.worktree_path)).toBe(false)
    const rescue = sh(join(dir, "repo"), "for-each-ref", "--format=%(refname)", "refs/keel/rescue/")
    expect(sh(join(dir, "repo"), "show", `${rescue}:AGENTE.md`)).toBe("cambio")
    expect(
      b.repo.getOutbox(`${WORKTREE_RELEASE}:${run.id}:review_exit`)?.delivered_at,
    ).not.toBeNull()
  })
})

describe("outbox: al menos una vez, con handlers idempotentes", () => {
  test("reentregar un despacho o una liberación ya hechos no repite el efecto", async () => {
    const dir = workspace()
    const calls = { n: 0 }
    const d = start(dir, calls)
    const c = await IpcClient.connect(d.server.path)
    const w = await plannedItem(c)
    const run = (await c.call("runs.start", {
      request_id: "r",
      idempotency_key: key(),
      work_item_id: w.id,
      purpose: "execute",
    })) as { id: string }
    await d.idle()
    await c.call("work_items.transition", {
      request_id: "r",
      idempotency_key: key(),
      work_item_id: w.id,
      to: "planned",
    })
    await d.idle()
    c.close()
    const released = () =>
      d.repo.eventsAfter(0, null, 100_000).filter((e) => e.kind === "worktree.released").length
    expect(calls.n).toBe(1)
    expect(released()).toBe(1)

    // el proceso cayó tras el efecto y antes del ACK: los mensajes vuelven a estar pendientes
    d.store.db.exec("UPDATE outbox SET delivered_at = NULL")
    expect(await d.outbox.drain()).toBeGreaterThanOrEqual(2)
    await d.idle()
    expect(calls.n).toBe(1)
    expect(released()).toBe(1)
    expect(d.repo.getRun(run.id)?.status).toBe("completed")
  })

  test("un handler que falla deja su mensaje pendiente y no frena a los demás; los tipos sin handler no se marcan", async () => {
    const dir = workspace()
    const store = openStore(join(dir, "solo.sqlite"), { loadVector: false })
    const repo = new Repo(store.db)
    const { project_id } = repo.ensureDefaultProject(dir)
    const outbox = new Outbox(repo)
    const seen: string[] = []
    outbox.on("ok", (m) => {
      seen.push(m.aggregate_id)
    })
    outbox.on("roto", () => {
      throw new Error("fallo")
    })
    for (const [type, id] of [
      ["roto", "1"],
      ["ok", "2"],
      ["contract_updated", "3"],
    ] as const)
      repo.enqueueOutbox({
        project_id,
        event_type: type,
        aggregate_id: id,
        dedupe_key: `${type}:${id}`,
        payload: {},
      })
    expect(await outbox.drain()).toBe(1)
    expect(seen).toEqual(["2"])
    expect(repo.getOutbox("roto:1")).toMatchObject({ attempts: 1, delivered_at: null })
    expect(repo.getOutbox("contract_updated:3")).toMatchObject({ attempts: 0, delivered_at: null })
    // reintento en la siguiente pasada
    await outbox.drain()
    expect(repo.getOutbox("roto:1")?.attempts).toBe(2)
    store.db.close()
  })
})
