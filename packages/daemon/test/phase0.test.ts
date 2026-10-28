/**
 * DoD de la Fase 0 (SDD 04): una integración crea proyecto y tarea, aprovisiona
 * un worktree real, registra un cambio git y libera recursos; reintentar el
 * comando devuelve el mismo resultado. Todo contra git y SQLite reales; el
 * proveedor es la corrida grabada del spike más una escritura en su `cwd`.
 */
import { afterEach, describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { canonical } from "@keel/git"
import { Daemon, type DaemonOptions, IpcClient, type QueryFn } from "../src/index.ts"
import { initRepo } from "./git-fixture.ts"
import { firstPrompt, hangingQuery, replayQuery } from "./replay.ts"

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
const key = () => `p0-${++n}`
const sh = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim()

/** Eventos guardados de un tipo: la tabla es la verdad; el socket llega después. */
function stored(daemon: Daemon, kind: string): unknown[] {
  return daemon.repo
    .eventsAfter(0, null, 100_000)
    .filter((e) => e.kind === kind)
    .map((e) => JSON.parse(e.payload_json) as unknown)
}

/** El agente falso deja un archivo en el directorio donde lo lanzaron. */
function writingQuery(calls: { cwd: string[] }): QueryFn {
  return (args) => {
    const cwd = String(args.options.cwd)
    calls.cwd.push(cwd)
    if (firstPrompt(args.prompt) === "hang") return hangingQuery()(args)
    writeFileSync(join(cwd, "AGENTE.md"), "cambio del agente\n")
    return replayQuery()(args)
  }
}

function options(dir: string, extra: Partial<DaemonOptions> = {}): DaemonOptions {
  return {
    dbPath: join(dir, "keel.sqlite"),
    socketPath: join(dir, "keel.sock"),
    rootPath: join(dir, "repo"),
    worktreesDir: join(dir, "worktrees"),
    ...extra,
  }
}

async function boot(opts: { git?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "keel-p0-"))
  dirs.push(dir)
  if (opts.git ?? true) initRepo(join(dir, "repo"))
  else mkdirSync(join(dir, "repo"), { recursive: true })
  const calls = { cwd: [] as string[] }
  const daemon = new Daemon(
    options(dir, { adapterDeps: { queryFn: writingQuery(calls), binary: "/fake/claude" } }),
  )
  daemon.start()
  daemons.push(daemon)
  const client = await IpcClient.connect(daemon.server.path)
  const planned = async (title: string) => {
    const w = (await client.call("work_items.create", {
      request_id: "r",
      idempotency_key: key(),
      title,
      kind: "chore",
    })) as { id: string; display_id: string }
    await client.call("work_items.transition", {
      request_id: "r",
      idempotency_key: key(),
      work_item_id: w.id,
      to: "planned",
    })
    return w
  }
  return { dir, daemon, client, calls, planned, root: join(dir, "repo") }
}

describe("Fase 0: tarea → worktree real → cambio git → liberación", () => {
  test("el run execute corre aislado en su worktree, registra el cambio y lo libera al salir de needs_review", async () => {
    const { dir, daemon, client, calls, planned, root } = await boot()
    const w = await planned("primer cambio")
    const params = {
      request_id: "r",
      idempotency_key: key(),
      work_item_id: w.id,
      purpose: "execute",
      prompt: "escribe",
    }
    const run = (await client.call("runs.start", params)) as { id: string }
    // reintentar con la misma key devuelve el mismo run y no aprovisiona otro worktree
    const again = (await client.call("runs.start", { ...params, request_id: "r2" })) as {
      id: string
    }
    expect(again.id).toBe(run.id)
    await daemon.idle()

    expect(daemon.repo.getRun(run.id)?.status).toBe("completed")
    expect(daemon.repo.getWorkItem(w.id)?.lifecycle).toBe("needs_review")
    const [wt] = daemon.repo.runWorktrees(run.id)
    expect(daemon.repo.runWorktrees(run.id)).toHaveLength(1)
    const expectedPath = canonical(
      join(dir, "worktrees", daemon.project.project_id, "repo", w.display_id, run.id, "root"),
    )
    expect(wt).toMatchObject({
      branch_name: `keel/${w.display_id}/${run.id}/root`,
      worktree_path: expectedPath,
      base_sha: sh(root, "rev-parse", "HEAD"),
    })
    // aislamiento: el agente corrió en el worktree y la raíz quedó intacta
    expect(calls.cwd).toEqual([expectedPath])
    expect(existsSync(join(expectedPath, "AGENTE.md"))).toBe(true)
    expect(existsSync(join(root, "AGENTE.md"))).toBe(false)

    const [changes] = stored(daemon, "worktree.changes")
    expect(changes).toMatchObject({
      dirty: true,
      commits_ahead: 0,
      files: [{ path: "AGENTE.md", status: "??" }],
    })
    // completed conserva el worktree para la revisión
    expect(stored(daemon, "worktree.released")).toEqual([])

    await client.call("work_items.transition", {
      request_id: "r",
      idempotency_key: key(),
      work_item_id: w.id,
      to: "planned",
    })
    await daemon.idle()
    const [released] = stored(daemon, "worktree.released") as {
      rescue_ref: string
      branch_kept: boolean
    }[]
    if (!released) throw new Error("no hubo worktree.released")
    // Sin commits propios, la rama no aporta nada: lo sin commit queda en el rescate.
    expect(released.branch_kept).toBe(false)
    expect(sh(root, "show", `${released.rescue_ref}:AGENTE.md`)).toBe("cambio del agente")
    expect(existsSync(expectedPath)).toBe(false)
    // Ni carpetas vacías de la tarea ni la rama keel/… quedan atrás.
    expect(
      existsSync(join(dir, "worktrees", daemon.project.project_id, "repo", w.display_id)),
    ).toBe(false)
    expect(sh(root, "branch", "--list", "keel/*")).toBe("")
    expect(sh(root, "for-each-ref", "refs/keel/runs/")).toBe("")
    expect(daemon.store.db.query("PRAGMA foreign_key_check").all()).toEqual([])
  })

  test("sin repo git el run execute falla explícito antes del spawn y la tarea queda failed", async () => {
    const { daemon, client, calls, planned } = await boot({ git: false })
    const w = await planned("sin git")
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
    const [failed] = stored(daemon, "run.start_failed") as { message: string }[]
    expect(failed?.message).toContain("repositorio git")
    expect(calls.cwd).toEqual([])
    expect(daemon.repo.getWorkItem(w.id)?.lifecycle).toBe("failed")
  })

  test("los runs plan son de sólo lectura y corren en la raíz, sin worktree", async () => {
    const { daemon, client, calls, root } = await boot()
    const w = daemon.repo.createWorkItem({
      project_id: daemon.project.project_id,
      title: "plan",
      kind: "chore",
    })
    const run = (await client.call("runs.start", {
      request_id: "r",
      idempotency_key: key(),
      work_item_id: w.id,
      purpose: "plan",
      prompt: "hang",
    })) as { id: string }
    for (let i = 0; i < 100 && calls.cwd.length === 0; i++)
      await new Promise((r) => setTimeout(r, 10))
    expect(calls.cwd).toEqual([root])
    expect(daemon.repo.runWorktrees(run.id)).toEqual([])
    daemon.claude.cancel(run.id, "fin del test")
  })

  test("cancelar mientras se prepara el worktree cierra el run sin lanzar el proveedor y libera", async () => {
    const { daemon, client, calls, planned } = await boot()
    const w = await planned("cancelada pronto")
    // La preparación del worktree queda retenida hasta que llega la cancelación.
    let release: () => void = () => {}
    const held = new Promise<void>((r) => {
      release = r
    })
    const provision = daemon.workspaces.provision.bind(daemon.workspaces)
    daemon.workspaces.provision = async (...args) => {
      await held
      return provision(...args)
    }
    const run = (await client.call("runs.start", {
      request_id: "r",
      idempotency_key: key(),
      work_item_id: w.id,
      purpose: "execute",
      prompt: "hang",
    })) as { id: string }
    await client.call("runs.cancel", { request_id: "r", idempotency_key: key(), run_id: run.id })
    release()
    await daemon.idle()
    expect(daemon.repo.getRun(run.id)?.status).toBe("cancelled")
    expect(calls.cwd).toEqual([])
    expect(daemon.repo.getWorkItem(w.id)?.lifecycle).toBe("planned")
    expect(stored(daemon, "worktree.released")).toHaveLength(1)
    // git real: en el runner de Windows, rescatar y quitar el worktree pasa de 5 s.
  }, 30_000)

  test("un daemon que arranca tras un crash libera el worktree del run interrumpido, rescatando su trabajo", async () => {
    const { dir, daemon, root } = await boot()
    const { project_id } = daemon.project
    const w = daemon.repo.createWorkItem({ project_id, title: "crash", kind: "chore" })
    daemon.repo.setLifecycle(w.id, "planned", { from: "triage" })
    daemon.repo.setLifecycle(w.id, "running", { from: "planned" })
    const run = daemon.repo.createRun({ project_id, work_item_id: w.id, purpose: "execute" })
    const ws = await daemon.workspaces.provision(run, w)
    if (!ws.ok) throw new Error(ws.message)
    writeFileSync(join(ws.cwd, "a-medias.txt"), "trabajo sin commit\n")
    daemon.repo.updateRun(run.id, { status: "running" })
    daemon.stop()
    daemons.splice(daemons.indexOf(daemon), 1)

    const next = new Daemon(options(dir, { adapterDeps: { binary: "/fake/claude" } }))
    daemons.push(next)
    next.start()
    await next.idle()
    expect(next.repo.getRun(run.id)?.status).toBe("interrupted")
    expect(next.repo.getWorkItem(w.id)?.lifecycle).toBe("failed")
    expect(existsSync(ws.cwd)).toBe(false)
    const rescue = sh(root, "for-each-ref", "--format=%(refname)", "refs/keel/rescue/")
    expect(sh(root, "show", `${rescue}:a-medias.txt`)).toBe("trabajo sin commit")
  })
})
