/**
 * El daemon sigue vivo al cerrar la ventana (ADR-0019 §1): tras actualizar Keel puede
 * correr código viejo. Dice qué métodos entiende y se reinicia desde un cliente, nunca
 * con runs vivos.
 */
import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { METHOD_NAMES } from "@keel/core"
import { Daemon, IpcClient } from "../src/index.ts"
import { initRepo } from "./git-fixture.ts"
import { replayQuery } from "./replay.ts"

const dirs: string[] = []
const daemons: Daemon[] = []
const clients: IpcClient[] = []
afterEach(async () => {
  for (const c of clients.splice(0)) c.close()
  for (const d of daemons.splice(0)) {
    await d.idle()
    d.stop()
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
const meta = () => ({ request_id: "r", idempotency_key: crypto.randomUUID() })

async function boot(onRestart?: () => void) {
  const dir = mkdtempSync(join(tmpdir(), "keel-restart-"))
  dirs.push(dir)
  const daemon = new Daemon({
    dbPath: join(dir, "keel.sqlite"),
    socketPath: join(dir, "keel.sock"),
    rootPath: initRepo(join(dir, "repo")),
    worktreesDir: join(dir, "worktrees"),
    adapterDeps: { queryFn: replayQuery(), binary: "/fake/claude" },
    mcpBridge: false,
    ...(onRestart ? { onRestart } : {}),
  })
  daemon.start()
  daemons.push(daemon)
  const human = await IpcClient.connect(daemon.server.path)
  clients.push(human)
  return { daemon, human }
}

describe("daemon.health y daemon.restart", () => {
  test("dice qué métodos entiende, para que la GUI note si corre código viejo", async () => {
    const { human } = await boot()
    const h = (await human.call("daemon.health", {})) as { methods: string[]; restartable: boolean }
    expect(h.methods.sort()).toEqual([...METHOD_NAMES].sort())
    expect(h.restartable).toBe(false)
    await expect(human.call("daemon.restart", meta())).rejects.toThrow("no se reinicia")
  })

  test("se reinicia sin runs vivos y se niega con uno vivo", async () => {
    let restarted = 0
    const { daemon, human } = await boot(() => {
      restarted++
    })
    const h = (await human.call("daemon.health", {})) as { restartable: boolean }
    expect(h.restartable).toBe(true)
    const pid = daemon.project.project_id
    const w = daemon.repo.createWorkItem({ project_id: pid, title: "t", kind: "chore" })
    const run = daemon.repo.createRun({ project_id: pid, work_item_id: w.id, purpose: "plan" })
    daemon.repo.updateRun(run.id, { status: "running" })
    await expect(human.call("daemon.restart", meta())).rejects.toThrow("run(s) vivo(s)")
    daemon.repo.updateRun(run.id, { status: "completed" })
    const r = (await human.call("daemon.restart", meta())) as { restarting: boolean }
    expect(r.restarting).toBe(true)
    await Bun.sleep(200)
    expect(restarted).toBe(1)
  })
})
