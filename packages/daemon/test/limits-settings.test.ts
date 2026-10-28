/**
 * ADR-0002 regla 3 desde la GUI: el humano sube el presupuesto y la concurrencia; los
 * flags del daemon mandan. Y una tarea del método en «esperando por ti» sigue al
 * escribirle (runs.continue).
 */
import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { checkRunStart, Daemon, DEFAULT_LIMITS, IpcClient } from "../src/index.ts"
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

describe("ADR-0002 regla 3: límites desde Ajustes", () => {
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

  test("el humano quita los topes de presupuesto: el run arranca sin maxBudgetUsd", async () => {
    const { daemon, human } = await boot()
    const view = (await human.call("settings.update", {
      ...meta(),
      limits: { run_budget_usd: null, daily_budget_usd: null },
    })) as { limits: { run_budget_usd: number | null; daily_budget_usd: number | null } }
    expect(view.limits).toMatchObject({ run_budget_usd: null, daily_budget_usd: null })
    expect(daemon.limits).toMatchObject({
      run_budget_micro_usd: null,
      daily_budget_micro_usd: null,
    })
    const w = (await human.call("work_items.create", { ...meta(), title: "t", kind: "chore" })) as {
      id: string
    }
    await human.call("work_items.transition", { ...meta(), work_item_id: w.id, to: "planned" })
    const run = (await human.call("runs.start", {
      ...meta(),
      work_item_id: w.id,
      purpose: "execute",
    })) as { id: string }
    const manifest = JSON.parse(daemon.repo.getRun(run.id)?.context_manifest_json ?? "{}")
    expect(manifest.budget_micro_usd).toBeNull()
    await daemon.idle()
    // Y se puede volver a poner.
    await human.call("settings.update", { ...meta(), limits: { daily_budget_usd: 20 } })
    expect(daemon.limits.daily_budget_micro_usd).toBe(20_000_000)
  })

  test("sin tope del día, checkRunStart no corta por gasto", () => {
    const repo = {
      liveRuns: () => [],
      spentSince: () => 999_000_000,
      workItemBudgetCap: () => null,
      spentOnWorkItem: () => 0,
    } as never
    const item = { id: "w", project_id: "p" } as never
    expect(
      checkRunStart(repo, { ...DEFAULT_LIMITS, daily_budget_micro_usd: null }, item),
    ).toMatchObject({ ok: true, runBudgetMicroUsd: 2_000_000 })
    expect(checkRunStart(repo, DEFAULT_LIMITS, item)).toMatchObject({
      ok: false,
      limit: "daily_budget",
    })
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

describe("ADR-0019 §4: el modelo con que empieza una tarea", () => {
  test("el default de Ajustes se usa si al arrancar no se elige otro", async () => {
    const { daemon, human } = await boot()
    const before = (await human.call("settings.get", {})) as {
      default_models: { claude: { model: string; source: string } }
    }
    expect(before.default_models.claude).toMatchObject({ model: "haiku", source: "default" })
    await human.call("settings.update", {
      ...meta(),
      default_model: { provider: "claude", model: "opus", effort: "high" },
    })
    const start = async (options?: Record<string, unknown>) => {
      const w = (await human.call("work_items.create", {
        ...meta(),
        title: "t",
        kind: "chore",
      })) as {
        id: string
      }
      await human.call("work_items.transition", { ...meta(), work_item_id: w.id, to: "planned" })
      const run = (await human.call("runs.start", {
        ...meta(),
        work_item_id: w.id,
        purpose: "execute",
        ...(options ? { options } : {}),
      })) as { id: string }
      await daemon.idle()
      return JSON.parse(daemon.repo.getRun(run.id)?.context_manifest_json ?? "{}").options
    }
    expect(await start()).toMatchObject({ model: "opus", effort: "high" })
    // Lo elegido al arrancar gana, y no hereda el esfuerzo del default.
    expect(await start({ model: "sonnet" })).toMatchObject({ model: "sonnet" })
    expect((await start({ model: "sonnet" })).effort).not.toBe("high")
    // Restablecer vuelve al del perfil.
    const reset = (await human.call("settings.update", {
      ...meta(),
      default_model: { provider: "claude", model: null },
    })) as { default_models: { claude: { model: string; source: string } } }
    expect(reset.default_models.claude).toMatchObject({ model: "haiku", source: "default" })
    expect(await start()).toMatchObject({ model: "haiku" })
  })
})
