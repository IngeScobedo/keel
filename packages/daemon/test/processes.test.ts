/**
 * Identidad de procesos y reconciliación (ADR-0003 §9) contra procesos reales de
 * la plataforma: /proc en Linux y CIM en Windows. Los «huérfanos» son procesos
 * de Bun que esperan; nunca se lanza el `claude` real.
 */
import { afterEach, describe, expect, test } from "bun:test"
import { type ChildProcess, spawn } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  Daemon,
  defaultProcessTable,
  IpcClient,
  type QueryFn,
  type RecordedProcess,
  sameProcess,
} from "../src/index.ts"
import { initRepo } from "./git-fixture.ts"
import { replayQuery } from "./replay.ts"

const table = defaultProcessTable()
const supported = table.kind !== "none"
const children: ChildProcess[] = []
const dirs: string[] = []
const daemons: Daemon[] = []
afterEach(async () => {
  for (const d of daemons.splice(0)) {
    await d.idle()
    d.stop()
  }
  for (const c of children.splice(0)) if (c.exitCode === null) c.kill()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

/** Un proceso que espera 60 s: hace de proveedor huérfano. */
function sleeper(): ChildProcess {
  const c = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" })
  children.push(c)
  return c
}

const exited = (c: ChildProcess, ms = 10_000) =>
  new Promise<boolean>((ok) => {
    if (c.exitCode !== null || c.signalCode !== null) return ok(true)
    const t = setTimeout(() => ok(false), ms)
    c.once("exit", () => {
      clearTimeout(t)
      ok(true)
    })
  })

async function identity(pid: number): Promise<RecordedProcess> {
  for (let i = 0; i < 50; i++) {
    const info = await table.get(pid)
    if (info?.startedAt) return { pid, started_at: info.startedAt, exe: info.exe, cwd: info.cwd }
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error(`sin identidad para ${pid}`)
}

describe("identidad de procesos (pid + arranque + ejecutable)", () => {
  test("sameProcess rechaza un pid reutilizado y un registro sin instante de arranque", () => {
    const cur = { pid: 7, ppid: 1, exe: "/x/claude", cmdline: null, cwd: null, startedAt: "b:100" }
    expect(sameProcess({ pid: 7, started_at: "b:100", exe: "/x/claude" }, cur)).toBe(true)
    expect(sameProcess({ pid: 7, started_at: "b:999", exe: "/x/claude" }, cur)).toBe(false)
    expect(sameProcess({ pid: 7, started_at: null, exe: "/x/claude" }, cur)).toBe(false)
    expect(sameProcess({ pid: 7, started_at: "b:100", exe: "/otro/bin" }, cur)).toBe(false)
    expect(
      sameProcess(
        { pid: 7, started_at: "t", exe: "C:\\Users\\A\\claude.exe" },
        { ...cur, startedAt: "t", exe: "c:\\users\\a\\CLAUDE.EXE" },
        "win32",
      ),
    ).toBe(true)
  })

  test.skipIf(!supported)(
    "la tabla de la plataforma ve un proceso real con ppid, ejecutable y arranque estable",
    async () => {
      const c = sleeper()
      const pid = c.pid as number
      const a = await identity(pid)
      const info = await table.get(pid)
      expect(info?.ppid).toBe(process.pid)
      expect(info?.startedAt).toBe(a.started_at)
      expect(info && sameProcess(a, info)).toBe(true)
      expect(table.terminate(pid)).toBe(true)
      expect(await exited(c)).toBe(true)
      for (let i = 0; i < 50 && (await table.get(pid)) !== null; i++)
        await new Promise((r) => setTimeout(r, 50))
      expect(await table.get(pid)).toBeNull()
    },
    30_000,
  )
})

describe.skipIf(!supported)("reconciliación al arrancar", () => {
  function workspace() {
    const dir = mkdtempSync(join(tmpdir(), "keel-proc-"))
    dirs.push(dir)
    initRepo(join(dir, "repo"))
    return dir
  }
  const boot = (dir: string, queryFn?: QueryFn) => {
    const d = new Daemon({
      dbPath: join(dir, "keel.sqlite"),
      socketPath: join(dir, `${Math.random().toString(36).slice(2)}.sock`),
      rootPath: join(dir, "repo"),
      worktreesDir: join(dir, "worktrees"),
      adapterDeps: { queryFn: queryFn ?? replayQuery(), binary: "/fake/claude" },
    })
    daemons.push(d)
    return d
  }

  test("termina el huérfano que sigue siendo el mismo proceso y respeta un pid reutilizado", async () => {
    const dir = workspace()
    const a = boot(dir)
    const { project_id } = a.project
    const orphan = sleeper()
    const own = await identity(orphan.pid as number)
    const runs = [
      { title: "huérfano real", proc: own },
      // el pid del propio test, con otro arranque: un pid reutilizado que no se debe tocar
      { title: "pid reutilizado", proc: { ...(await identity(process.pid)), started_at: "otro" } },
    ].map(({ title, proc }) => {
      const w = a.repo.createWorkItem({ project_id, title, kind: "chore" })
      const run = a.repo.createRun({
        project_id,
        work_item_id: w.id,
        purpose: "execute",
        manifest: { provider_process: proc },
      })
      a.repo.updateRun(run.id, { status: "running" })
      return run.id
    })
    a.stop()
    daemons.splice(0)

    const b = boot(dir)
    b.start()
    await b.idle()
    expect(await exited(orphan)).toBe(true)
    const checks = b.repo
      .eventsAfter(0, null, 10_000)
      .filter((e) => e.kind === "run.orphan_checked")
      .map((e) => ({ run: e.run_id, ...(JSON.parse(e.payload_json) as object) }))
    expect(checks).toEqual([
      expect.objectContaining({ run: runs[0], same_process: true, terminated: true }),
      expect.objectContaining({
        run: runs[1],
        alive: true,
        same_process: false,
        terminated: false,
      }),
    ])
  }, 60_000)

  test("el adaptador registra pid, arranque y ejecutable en el instante del spawn", async () => {
    const dir = workspace()
    // El SDK falso lanza el proceso por la función de Keel, como hace el real.
    const queryFn: QueryFn = (args) => {
      const spawnFn = args.options.spawnClaudeCodeProcess
      if (!spawnFn) throw new Error("el adaptador no pasó spawnClaudeCodeProcess")
      const child = spawnFn({
        command: process.execPath,
        args: ["-e", "setTimeout(() => {}, 2000)"],
        cwd: String(args.options.cwd),
        env: process.env,
        signal: new AbortController().signal,
      })
      children.push(child as unknown as ChildProcess)
      return replayQuery()(args)
    }
    const d = boot(dir, queryFn)
    d.start()
    const c = await IpcClient.connect(d.server.path)
    const w = d.repo.createWorkItem({
      project_id: d.project.project_id,
      title: "spawn",
      kind: "chore",
    })
    d.repo.setLifecycle(w.id, "planned", { from: "triage" })
    const run = (await c.call("runs.start", {
      request_id: "r",
      idempotency_key: "spawn-1",
      work_item_id: w.id,
      purpose: "execute",
    })) as { id: string }
    await d.idle()
    for (let i = 0; i < 100; i++) {
      const m = JSON.parse(d.repo.getRun(run.id)?.context_manifest_json ?? "{}")
      if (m.provider_process?.started_at) break
      await new Promise((r) => setTimeout(r, 50))
    }
    const manifest = JSON.parse(d.repo.getRun(run.id)?.context_manifest_json ?? "{}") as {
      provider_process: RecordedProcess & { command: string; session_id?: string }
    }
    expect(manifest.provider_process).toMatchObject({
      pid: expect.any(Number),
      command: process.execPath,
      started_at: expect.any(String),
    })
    expect(manifest.provider_process.session_id).toBeString()
    c.close()
  }, 60_000)
})
