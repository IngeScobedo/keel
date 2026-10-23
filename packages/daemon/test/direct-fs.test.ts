/**
 * ADR-0010: modo sin VCS. Un proyecto sin git usa `DirectFsDriver` sólo con la
 * confirmación del humano; el run trabaja en la carpeta real, con snapshot
 * previo, candado de un escritor y captura por hashes. Todo contra la carpeta y
 * `tar` reales; el proveedor es la corrida grabada del spike.
 */
import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Daemon, IpcClient, type QueryFn } from "../src/index.ts"
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
const key = () => `dfs-${++n}`

function stored(daemon: Daemon, kind: string): unknown[] {
  return daemon.repo
    .eventsAfter(0, null, 100_000)
    .filter((e) => e.kind === kind)
    .map((e) => JSON.parse(e.payload_json) as unknown)
}

/** El agente falso crea, cambia y borra archivos en la carpeta donde lo lanzan. */
function editingQuery(): QueryFn {
  return (args) => {
    const cwd = String(args.options.cwd)
    writeFileSync(join(cwd, "nuevo.txt"), "creado por el agente\n")
    writeFileSync(join(cwd, "init.lua"), "-- cambiado por el agente\n")
    rmSync(join(cwd, "borrar.txt"))
    return replayQuery()(args)
  }
}

async function boot() {
  const dir = mkdtempSync(join(tmpdir(), "keel-dfs-"))
  dirs.push(dir)
  const root = join(dir, "nvim")
  mkdirSync(join(root, "lua"), { recursive: true })
  writeFileSync(join(root, "init.lua"), "-- original\n")
  writeFileSync(join(root, "borrar.txt"), "se borra\n")
  writeFileSync(join(root, "lua", "plugins.lua"), "return {}\n")
  const daemon = new Daemon({
    dbPath: join(dir, "keel.sqlite"),
    socketPath: join(dir, "keel.sock"),
    rootPath: root,
    worktreesDir: join(dir, "worktrees"),
    snapshotsDir: join(dir, "snapshots"),
    adapterDeps: { queryFn: editingQuery(), binary: "/fake/claude" },
  })
  daemon.start()
  daemons.push(daemon)
  const client = await IpcClient.connect(daemon.server.path)
  const run = async () => {
    const w = (await client.call("work_items.create", {
      request_id: "r",
      idempotency_key: key(),
      title: "ajustar nvim",
      kind: "chore",
    })) as { id: string }
    await client.call("work_items.transition", {
      request_id: "r",
      idempotency_key: key(),
      work_item_id: w.id,
      to: "planned",
    })
    const r = (await client.call("runs.start", {
      request_id: "r",
      idempotency_key: key(),
      work_item_id: w.id,
      purpose: "execute",
      prompt: "edita",
    })) as { id: string }
    await daemon.idle()
    return { workItemId: w.id, runId: r.id }
  }
  const setVcs = (vcs: "git" | "none") =>
    client.call("projects.set_vcs", { request_id: "r", idempotency_key: key(), vcs })
  return { dir, root, daemon, client, run, setVcs }
}

describe("ADR-0010: DirectFsDriver", () => {
  test("sin confirmación del humano, un proyecto sin git falla explícito como en la Fase 0", async () => {
    const { daemon, run, root } = await boot()
    const { runId } = await run()
    expect(daemon.repo.getRun(runId)?.status).toBe("failed")
    const [failed] = stored(daemon, "run.start_failed") as { message: string }[]
    expect(failed?.message).toContain("projects.set_vcs")
    expect(readFileSync(join(root, "init.lua"), "utf8")).toBe("-- original\n")
  })

  test("confirmado, el run trabaja en la carpeta real con snapshot previo y captura por hashes", async () => {
    const { daemon, root, run, setVcs } = await boot()
    const vcs = (await setVcs("none")) as { vcs: string; vcs_none_confirmed_by: string | null }
    expect(vcs.vcs).toBe("none")
    expect(vcs.vcs_none_confirmed_by).toStartWith("user:")
    const { runId } = await run()

    expect(daemon.repo.getRun(runId)?.status).toBe("completed")
    const [prepared] = stored(daemon, "workspace.prepared") as {
      kind: string
      guarantees: { isolation: string; parallel: boolean }
    }[]
    expect(prepared).toMatchObject({
      kind: "direct_fs",
      guarantees: { isolation: "none", rescue: "snapshot", parallel: false },
    })
    const [snap] = stored(daemon, "workspace.snapshot_created") as { file_count: number }[]
    expect(snap?.file_count).toBe(3)
    const [changes] = stored(daemon, "workspace.changes") as {
      added: string[]
      modified: string[]
      deleted: string[]
    }[]
    expect(changes).toMatchObject({
      added: ["nuevo.txt"],
      modified: ["init.lua"],
      deleted: ["borrar.txt"],
    })
    // completed conserva la carpeta tomada hasta salir de la revisión
    expect(
      daemon.repo.activeSnapshotForRoot(daemon.repo.runSnapshot(runId)?.root_path ?? ""),
    ).not.toBeNull()
    expect(existsSync(join(root, "nuevo.txt"))).toBe(true)
  })

  test("un escritor por carpeta: otro run sobre la misma carpeta falla mientras la primera sigue tomada", async () => {
    const { daemon, run, setVcs } = await boot()
    await setVcs("none")
    const first = await run()
    expect(daemon.repo.getRun(first.runId)?.status).toBe("completed")
    const second = await run()
    expect(daemon.repo.getRun(second.runId)?.status).toBe("failed")
    const failures = stored(daemon, "run.start_failed") as { message: string }[]
    expect(failures.at(-1)?.message).toContain(first.runId)
  })

  test("restaurar devuelve la carpeta al snapshot y borra lo nuevo sólo si se pide", async () => {
    const { daemon, root, client, run, setVcs } = await boot()
    await setVcs("none")
    const { workItemId, runId } = await run()
    // Salir de needs_review libera la carpeta (y sólo entonces se puede restaurar).
    await expect(
      client.call("snapshots.restore", { request_id: "r", idempotency_key: key(), run_id: runId }),
    ).rejects.toThrow("sigue usando la carpeta")
    await client.call("work_items.transition", {
      request_id: "r",
      idempotency_key: key(),
      work_item_id: workItemId,
      to: "planned",
    })
    await daemon.idle()
    expect(stored(daemon, "workspace.released")).toHaveLength(1)

    await client.call("snapshots.restore", {
      request_id: "r",
      idempotency_key: key(),
      run_id: runId,
      delete_new: true,
    })
    await daemon.idle()
    const [restored] = stored(daemon, "workspace.restored") as { deleted: string[] }[]
    expect(restored?.deleted).toEqual(["nuevo.txt"])
    expect(readFileSync(join(root, "init.lua"), "utf8")).toBe("-- original\n")
    expect(readFileSync(join(root, "borrar.txt"), "utf8")).toBe("se borra\n")
    expect(existsSync(join(root, "nuevo.txt"))).toBe(false)
  })

  test("volver a git quita la confirmación del modo sin VCS", async () => {
    const { setVcs } = await boot()
    await setVcs("none")
    const back = (await setVcs("git")) as { vcs: string; vcs_none_confirmed_at: string | null }
    expect(back).toMatchObject({ vcs: "git", vcs_none_confirmed_at: null })
  })
})
