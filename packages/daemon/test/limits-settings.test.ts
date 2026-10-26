/**
 * ADR-0002 regla 5 desde la GUI: el humano sube el presupuesto y la concurrencia; los
 * flags del daemon mandan. Y una tarea del método en «esperando por ti» sigue al
 * escribirle (runs.continue).
 */
import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
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

async function boot(limits?: Record<string, number>) {
  const dir = mkdtempSync(join(tmpdir(), "keel-limits-"))
  dirs.push(dir)
  const daemon = new Daemon({
    dbPath: join(dir, "keel.sqlite"),
    socketPath: join(dir, "keel.sock"),
    rootPath: initRepo(join(dir, "repo")),
    worktreesDir: join(dir, "worktrees"),
    adapterDeps: { queryFn: replayQuery(), binary: "/fake/claude" },
    mcpBridge: false,
    ...(limits ? { limits } : {}),
  })
  daemon.start()
  daemons.push(daemon)
  const human = await IpcClient.connect(daemon.server.path)
  clients.push(human)
  return { daemon, human }
}

describe("ADR-0002 regla 5: límites desde Ajustes", () => {
  test("el humano sube el presupuesto del día y queda a su nombre", async () => {
    const { daemon, human } = await boot()
    const before = (await human.call("settings.get", {})) as {
      limits: { daily_budget_usd: number; source: string }
    }
    expect(before.limits).toMatchObject({ daily_budget_usd: 10, source: "default" })
    const after = (await human.call("settings.update", {
      ...meta(),
      limits: { daily_budget_usd: 60, run_budget_usd: 15 },
    })) as {
      limits: {
        daily_budget_usd: number
        run_budget_usd: number
        source: string
        updated_by: string
      }
    }
    expect(after.limits).toMatchObject({
      daily_budget_usd: 60,
      run_budget_usd: 15,
      source: "setting",
    })
    expect(after.limits.updated_by).toBeTruthy()
    expect(daemon.limits.daily_budget_micro_usd).toBe(60_000_000)
    expect(daemon.limits.max_concurrent_runs).toBe(1)
  })

  test("los flags del daemon mandan sobre el ajuste", async () => {
    const { daemon, human } = await boot({ daily_budget_micro_usd: 5_000_000 })
    await human.call("settings.update", { ...meta(), limits: { daily_budget_usd: 60 } })
    expect(daemon.limits.daily_budget_micro_usd).toBe(5_000_000)
    const s = (await human.call("settings.get", {})) as { limits: { source: string } }
    expect(s.limits.source).toBe("flag")
  })
})

describe("ADR-0021: seguir una tarea que espera al humano", () => {
  test("escribirle a un run terminado con la tarea en waiting_human abre el siguiente", async () => {
    const { daemon, human } = await boot()
    const w = (await human.call("work_items.create", { ...meta(), title: "t", kind: "chore" })) as {
      id: string
    }
    await human.call("work_items.transition", { ...meta(), work_item_id: w.id, to: "planned" })
    const run = (await human.call("runs.start", {
      ...meta(),
      work_item_id: w.id,
      purpose: "execute",
    })) as { id: string }
    await daemon.idle()
    // Como deja el método la tarea al terminar un turno de implementar.
    const item = daemon.repo.getWorkItem(w.id)
    daemon.repo.setLifecycle(w.id, "waiting_human", { from: item?.lifecycle as never })
    const child = (await human.call("runs.continue", {
      ...meta(),
      run_id: run.id,
      text: "sigue",
    })) as { parent_run_id: string }
    expect(child.parent_run_id).toBe(run.id)
    await daemon.idle()
  })
})
