/**
 * Límites antes del spawn (ADR-0002 regla 3, CLAUDE.md regla 5, SDD 04 Fase 1):
 * concurrencia y presupuesto con defaults bajos. Subirlos, o quitar un tope de
 * presupuesto (`null`), es una decisión explícita del usuario (flags del daemon o
 * Ajustes) y queda visible en `daemon.health` y en Ajustes.
 *
 * El costo es siempre una estimación del proveedor (`cost_kind: estimated`,
 * ADR-0002 §3), también con la suscripción: el presupuesto acota lo que el SDK
 * estima, no una factura.
 */
import type { Repo, WorkItemRow } from "./store/repo.js"

export type Limits = {
  /** Runs vivos a la vez en el daemon. */
  max_concurrent_runs: number
  /** Tope estimado por run; se pasa al proveedor (`maxBudgetUsd`). `null`: sin tope. */
  run_budget_micro_usd: number | null
  /** Tope estimado por proyecto y día local. `null`: sin tope. */
  daily_budget_micro_usd: number | null
}

/** Defaults bajos, una persona trabajando (ADR-0002 regla 3). Decididos el 2026-10-23. */
export const DEFAULT_LIMITS: Limits = {
  max_concurrent_runs: 1,
  run_budget_micro_usd: 2_000_000,
  daily_budget_micro_usd: 10_000_000,
}

export type LimitCheck =
  /** `runBudgetMicroUsd` null: ningún tope aplica y el proveedor corre sin `maxBudgetUsd`. */
  | { ok: true; runBudgetMicroUsd: number | null }
  | {
      ok: false
      limit: "max_concurrent_runs" | "daily_budget" | "task_budget"
      retryable: boolean
      message: string
      details: Record<string, number>
    }

/** Medianoche local de hoy en ISO UTC, para comparar con `runs.started_at`. */
export function startOfLocalDay(now: Date = new Date()): string {
  const d = new Date(now)
  d.setHours(0, 0, 0, 0)
  return d.toISOString()
}

export function checkRunStart(
  repo: Repo,
  limits: Limits,
  item: WorkItemRow,
  now: Date = new Date(),
): LimitCheck {
  const live = repo.liveRuns().length
  if (live >= limits.max_concurrent_runs)
    return {
      ok: false,
      limit: "max_concurrent_runs",
      retryable: true,
      message: `ya hay ${live} run(s) vivo(s); el límite es ${limits.max_concurrent_runs}`,
      details: { live, max_concurrent_runs: limits.max_concurrent_runs },
    }
  const spentToday = repo.spentSince(item.project_id, startOfLocalDay(now))
  const dailyLeft =
    limits.daily_budget_micro_usd === null
      ? Number.POSITIVE_INFINITY
      : limits.daily_budget_micro_usd - spentToday
  if (dailyLeft <= 0)
    return {
      ok: false,
      limit: "daily_budget",
      retryable: false,
      message: "se agotó el presupuesto estimado del día",
      details: {
        spent_today_micro_usd: spentToday,
        daily_budget_micro_usd: limits.daily_budget_micro_usd ?? 0,
      },
    }
  const cap = repo.workItemBudgetCap(item.id)
  const taskLeft = cap === null ? Number.POSITIVE_INFINITY : cap - repo.spentOnWorkItem(item.id)
  if (taskLeft <= 0)
    return {
      ok: false,
      limit: "task_budget",
      retryable: false,
      message: "se agotó el presupuesto estimado de la tarea",
      details: { task_budget_micro_usd: cap ?? 0, spent_micro_usd: repo.spentOnWorkItem(item.id) },
    }
  const budget = Math.min(
    limits.run_budget_micro_usd ?? Number.POSITIVE_INFINITY,
    dailyLeft,
    taskLeft,
  )
  return { ok: true, runBudgetMicroUsd: Number.isFinite(budget) ? budget : null }
}
