/**
 * ADR-0018 §3: desde dentro del sandbox de un run `execute`, el socket humano
 * y el estado de Keel no existen, la puerta de agentes conecta, se escribe en
 * el worktree y no fuera. Bubblewrap, daemon y git reales; sólo en Linux con
 * `bwrap` instalado.
 */
import { afterEach, describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { bwrapArgs, bwrapPath, Daemon, wrapCommand } from "../src/index.ts"
import { initRepo } from "./git-fixture.ts"
import { replayQuery } from "./replay.ts"

const bwrap = bwrapPath()
const dirs: string[] = []
const daemons: Daemon[] = []
afterEach(async () => {
  for (const d of daemons.splice(0)) {
    await d.idle()
    d.stop()
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

/** Lo que el agente intentaría desde su shell, como script de Bun. */
const PROBE = `
const net = require("node:net"), fs = require("node:fs")
const [human, agent, cwd, outside, db, otherToken, ownToken] = process.argv.slice(2)
const out = {}
const tryConnect = (p) => new Promise((ok) => {
  const s = net.createConnection(p)
  s.on("connect", () => { s.destroy(); ok("connect") })
  s.on("error", (e) => ok(e.code))
})
out.human = await tryConnect(human)
out.agent = await tryConnect(agent)
out.db = fs.existsSync(db) ? "visible" : "hidden"
out.otherToken = fs.existsSync(otherToken) ? "visible" : "hidden"
out.ownToken = fs.existsSync(ownToken) ? "visible" : "hidden"
try { fs.writeFileSync(cwd + "/dentro.txt", "x"); out.inside = "ok" } catch (e) { out.inside = e.code }
try { fs.writeFileSync(outside + "/fuera.txt", "x"); out.outside = "ok" } catch (e) { out.outside = e.code }
console.log(JSON.stringify(out))
`

describe.skipIf(!bwrap)("ADR-0018 §3: sandbox con bubblewrap", () => {
  test("el agente no ve la puerta humana ni el estado; usa la suya y sólo escribe en su worktree", async () => {
    const dir = mkdtempSync(join(tmpdir(), "keel-sbx-"))
    dirs.push(dir)
    // Estado y socket en carpetas propias, como en una instalación real.
    const repo = initRepo(join(dir, "repo"))
    const state = join(dir, "state")
    mkdirSync(state)
    const daemon = new Daemon({
      dbPath: join(state, "keel.sqlite"),
      socketPath: join(dir, "run", "keel.sock"),
      rootPath: repo,
      worktreesDir: join(dir, "worktrees"),
      adapterDeps: { queryFn: replayQuery(), binary: "/fake/claude" },
    })
    daemon.start()
    daemons.push(daemon)
    const pid = daemon.project.project_id
    const w = daemon.repo.createWorkItem({ project_id: pid, title: "t", kind: "chore" })
    const run = daemon.repo.createRun({ project_id: pid, work_item_id: w.id, purpose: "execute" })
    const cwd = join(dir, "worktree")
    initRepo(cwd)
    const own = daemon.agentTokens.issue({ run_id: run.id, project_id: pid, work_item_id: w.id })
    // El token de otro run vivo: el agente no debe verlo.
    const w2 = daemon.repo.createWorkItem({ project_id: pid, title: "otra", kind: "chore" })
    const other = daemon.repo.createRun({ project_id: pid, work_item_id: w2.id, purpose: "plan" })
    const theirs = daemon.agentTokens.issue({
      run_id: other.id,
      project_id: pid,
      work_item_id: w2.id,
    })

    const sandbox = await daemon.sandboxFor(run, cwd)
    expect(sandbox).not.toBeNull()
    const { spec } = sandbox as NonNullable<typeof sandbox>
    // Una raíz de solo lectura no basta: la carpeta del socket humano va tapada.
    expect(bwrapArgs(spec)).toContain("--tmpfs")
    // «Fuera»: una carpeta real del disco que no es el worktree (/tmp va tapado con tmpfs).
    const outside = import.meta.dir
    const probe = join(cwd, "probe.mjs")
    writeFileSync(probe, PROBE)
    const { command, args } = wrapCommand(bwrap as string, spec, process.execPath, [
      probe,
      daemon.server.path,
      daemon.agentServer.path,
      cwd,
      outside,
      join(state, "keel.sqlite"),
      theirs.file,
      own.file,
    ])
    const r = spawnSync(command, args, { encoding: "utf8", timeout: 20_000 })
    expect(r.stderr).toBe("")
    expect(JSON.parse(r.stdout)).toEqual({
      human: "ENOENT",
      agent: "connect",
      db: "hidden",
      otherToken: "hidden",
      ownToken: "visible",
      inside: "ok",
      outside: "EROFS",
    })
    expect(readFileSync(join(cwd, "dentro.txt"), "utf8")).toBe("x")
    const leaked = join(outside, "fuera.txt")
    const wrote = existsSync(leaked)
    rmSync(leaked, { force: true })
    expect(wrote).toBe(false)
  })

  test("un run que no ejecuta, o con el sandbox apagado, no se aísla", async () => {
    const dir = mkdtempSync(join(tmpdir(), "keel-sbx-"))
    dirs.push(dir)
    const repo = initRepo(join(dir, "repo"))
    const daemon = new Daemon({
      dbPath: join(dir, "keel.sqlite"),
      socketPath: join(dir, "keel.sock"),
      rootPath: repo,
      adapterDeps: { queryFn: replayQuery(), binary: "/fake/claude" },
      sandbox: "off",
    })
    daemon.start()
    daemons.push(daemon)
    const pid = daemon.project.project_id
    const w = daemon.repo.createWorkItem({ project_id: pid, title: "t", kind: "chore" })
    const w2 = daemon.repo.createWorkItem({ project_id: pid, title: "t2", kind: "chore" })
    const plan = daemon.repo.createRun({ project_id: pid, work_item_id: w.id, purpose: "plan" })
    const exec = daemon.repo.createRun({ project_id: pid, work_item_id: w2.id, purpose: "execute" })
    expect(await daemon.sandboxFor(plan, repo)).toBeNull()
    expect(await daemon.sandboxFor(exec, repo)).toBeNull()
  })
})
