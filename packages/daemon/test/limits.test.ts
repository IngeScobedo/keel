/**
 * Límites antes del spawn (ADR-0002 regla 3, SDD 04 Fase 1): concurrencia,
 * presupuesto del día y de la tarea, y el tope por run que recibe el proveedor.
 */
import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ErrorCode } from "@keel/core"
import { Daemon, IpcClient, type Limits, nowIso, type QueryFn } from "../src/index.ts"
import { initRepo } from "./git-fixture.ts"
import { firstPrompt, hangingQuery, replayQuery } from "./replay.ts"

const open: { d: Daemon; c: IpcClient; dir: string }[] = []
afterEach(async () => {
  for (const o of open.splice(0)) {
    for (const r of o.d.repo.liveRuns()) o.d.claude.cancel(r.id, "fin del test")
    await o.d.idle()
    o.c.close()
    o.d.stop()
    rmSync(o.dir, { recursive: true, force: true })
  }
})

let n = 0
const key = () => `lim-${++n}`

async function boot(limits: Partial<Limits> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "keel-limits-"))
  const seen = { calls: 0, maxBudgetUsd: [] as (number | undefined)[] }
  const queryFn: QueryFn = (args) => {
    seen.calls++
    seen.maxBudgetUsd.push(args.options.maxBudgetUsd)
    return (firstPrompt(args.prompt) === "hang" ? hangingQuery() : replayQuery())(args)
  }
  const d = new Daemon({
    dbPath: join(dir, "keel.sqlite"),
    socketPath: join(dir, "keel.sock"),
    rootPath: initRepo(join(dir, "repo")),
    worktreesDir: join(dir, "worktrees"),
    adapterDeps: { queryFn, binary: "/fake/claude" },
    limits,
  })
  d.start()
  const c = await IpcClient.connect(d.server.path)
  open.push({ d, c, dir })
  const planned = (title: string) => {
    const w = d.repo.createWorkItem({ project_id: d.project.project_id, title, kind: "chore" })
    d.repo.setLifecycle(w.id, "planned", { from: "triage" })
    return w
  }
  const start = (workItemId: string, prompt = "x") =>
    c
      .call("runs.start", {
        request_id: "r",
        idempotency_key: key(),
        work_item_id: workItemId,
        purpose: "execute",
        prompt,
      })
      .then(
        (r) => ({ ok: true as const, run: r as { id: string } }),
        (e: { rpc?: { code: number; retryable: boolean; details?: Record<string, unknown> } }) => ({
          ok: false as const,
          rpc: e.rpc,
        }),
      )
  /** Un run terminado hoy con este costo estimado. */
  const spent = (workItemId: string, microUsd: number) => {
    const r = d.repo.createRun({
      project_id: d.project.project_id,
      work_item_id: workItemId,
      purpose: "execute",
    })
    d.repo.updateRun(r.id, {
      status: "completed",
      end_reason: "completed",
      started_at: nowIso(),
      ended_at: nowIso(),
      total_cost_micro_usd: microUsd,
      cost_kind: "estimated",
    })
  }
  return { d, c, seen, planned, start, spent }
}

describe("ADR-0002 regla 3: límites antes del spawn", () => {
  test("default de un run a la vez: el segundo se rechaza, reintentable, y entra al terminar el primero", async () => {
    const { d, planned, start } = await boot()
    expect(d.limits.max_concurrent_runs).toBe(1)
    const a = await start(planned("a").id, "hang")
    expect(a.ok).toBe(true)
    const b = planned("b")
    const rejected = await start(b.id)
    expect(rejected).toMatchObject({
      ok: false,
      rpc: {
        code: ErrorCode.limitExceeded,
        retryable: true,
        details: { limit: "max_concurrent_runs" },
      },
    })
    if (a.ok) {
      for (let i = 0; i < 200 && d.repo.toolCallsOfRun(a.run.id).length === 0; i++)
        await new Promise((r) => setTimeout(r, 10))
      d.claude.cancel(a.run.id, "libera")
    }
    await d.idle()
    expect((await start(b.id)).ok).toBe(true)
  })

  test("presupuesto del día agotado: rechazo sin reintento y el proveedor nunca se llama", async () => {
    const { seen, planned, start, spent } = await boot({ daily_budget_micro_usd: 1_000_000 })
    const w = planned("caro")
    spent(w.id, 1_000_000)
    expect(await start(w.id)).toMatchObject({
      ok: false,
      rpc: {
        code: ErrorCode.limitExceeded,
        retryable: false,
        details: { limit: "daily_budget", spent_today_micro_usd: 1_000_000 },
      },
    })
    expect(seen.calls).toBe(0)
  })

  test("tope de la tarea agotado", async () => {
    const { d, planned, start, spent } = await boot()
    const w = planned("con tope")
    d.repo.setWorkItemBudgetCap(w.id, 500_000)
    spent(w.id, 500_000)
    expect(await start(w.id)).toMatchObject({
      ok: false,
      rpc: { details: { limit: "task_budget" } },
    })
  })

  test("el proveedor recibe como maxBudgetUsd lo menor entre el tope del run, lo que queda del día y de la tarea", async () => {
    const { d, seen, planned, start, spent } = await boot({ daily_budget_micro_usd: 3_000_000 })
    const other = planned("otra")
    spent(other.id, 1_500_000) // quedan 1.5 del día; el tope por run es 2
    const w = planned("medida")
    expect((await start(w.id)).ok).toBe(true)
    await d.idle()
    const capped = planned("con tope chico")
    d.repo.setWorkItemBudgetCap(capped.id, 300_000)
    expect((await start(capped.id)).ok).toBe(true)
    await d.idle()
    expect(seen.maxBudgetUsd[0]).toBe(1.5)
    expect(seen.maxBudgetUsd[1]).toBe(0.3)
  })

  test("daemon.health muestra los límites vigentes y el gasto estimado de hoy", async () => {
    const { c, planned, spent } = await boot({ run_budget_micro_usd: 750_000 })
    spent(planned("x").id, 123_000)
    const h = (await c.call("daemon.health", {})) as {
      limits: Limits
      spent_today_micro_usd: number
    }
    expect(h.limits).toEqual({
      max_concurrent_runs: 1,
      run_budget_micro_usd: 750_000,
      daily_budget_micro_usd: 10_000_000,
    })
    expect(h.spent_today_micro_usd).toBe(123_000)
  })
})
