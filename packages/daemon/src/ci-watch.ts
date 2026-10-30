/**
 * ADR-0043 §5: Keel sigue los runs de GitHub Actions de lo que él empujó (un plan de git,
 * un merge, una promoción) y deja su historia como eventos `ci.run.*`, aunque nadie
 * tenga la tarjeta abierta. Consulta a `gh` cada 10 s; si al límite de la API le quedan
 * menos de 500 llamadas, deja de seguir y lo dice.
 */
import {
  type GhOptions,
  rateLimit,
  type WorkflowRun,
  workflowRun,
  workflowRuns,
} from "@keel/git/github"

type Emit = (projectId: string, runId: string | null, kind: string, payload: unknown) => void

export type CiWatcherDeps = {
  gh: () => string | null
  emit: Emit
  intervalMs?: number
  now?: () => number
}

type Followed = {
  projectId: string
  runId: string | null
  cwd: string
  sha: string
  since: number
  lastActivity: number
  runs: Map<number, { started: boolean; steps: Set<string>; done: boolean; branch: string }>
}

/** Sin runs a los 3 min, se da por hecho que nada corre por ese commit. */
const NOTHING_AFTER_MS = 3 * 60_000
/** Terminados todos, se espera 2 min por si un workflow encadenado arranca después. */
const QUIET_AFTER_MS = 2 * 60_000
const MAX_FOLLOW_MS = 90 * 60_000
const BUDGET_FLOOR = 500

export class CiWatcher {
  private readonly follows = new Map<string, Followed>()
  private timer: ReturnType<typeof setInterval> | null = null
  private ticking = false
  private budgetCheckedAt = 0
  private paused: string | null = null

  private readonly deps: CiWatcherDeps
  constructor(deps: CiWatcherDeps) {
    this.deps = deps
  }

  private now() {
    return this.deps.now?.() ?? Date.now()
  }

  /** Empieza a seguir los runs de `sha` en el repo `cwd`. Idempotente por commit. */
  follow(f: { projectId: string; runId: string | null; cwd: string; sha: string }): void {
    if (!this.deps.gh() || this.follows.has(f.sha)) return
    const t = this.now()
    this.follows.set(f.sha, { ...f, since: t, lastActivity: t, runs: new Map() })
    this.timer ??= setInterval(() => void this.tick(), this.deps.intervalMs ?? 10_000)
  }

  following(): string[] {
    return [...this.follows.keys()]
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.follows.clear()
  }

  /** Una vuelta: runs nuevos, pasos terminados y runs terminados de cada commit seguido. */
  async tick(): Promise<void> {
    const bin = this.deps.gh()
    if (this.ticking || !bin) return
    this.ticking = true
    try {
      if (!(await this.budgetOk(bin))) return
      for (const f of [...this.follows.values()]) await this.step(f, { cwd: f.cwd, gh: bin })
      if (this.follows.size === 0 && this.timer) {
        clearInterval(this.timer)
        this.timer = null
      }
    } finally {
      this.ticking = false
    }
  }

  private async budgetOk(gh: string): Promise<boolean> {
    if (this.now() - this.budgetCheckedAt < 5 * 60_000) return this.paused === null
    this.budgetCheckedAt = this.now()
    const any = [...this.follows.values()][0]
    if (!any) return true
    try {
      const r = await rateLimit({ cwd: any.cwd, gh })
      if (r.remaining < BUDGET_FLOOR) {
        this.paused = `quedan ${r.remaining} llamadas a la API de GitHub hasta ${r.reset_at}`
        for (const f of this.follows.values())
          this.deps.emit(f.projectId, f.runId, "ci.watch.paused", {
            sha: f.sha,
            reason: this.paused,
          })
        this.follows.clear()
        return false
      }
    } catch {
      // Sin poder leer el límite se sigue: lo peor es una consulta de más.
    }
    this.paused = null
    return true
  }

  private async step(f: Followed, opts: GhOptions): Promise<void> {
    let runs: WorkflowRun[]
    try {
      runs = await workflowRuns(opts, { commit: f.sha, limit: 20 })
    } catch {
      return
    }
    const t = this.now()
    for (const r of runs) {
      let seen = f.runs.get(r.databaseId)
      if (!seen) {
        seen = { started: false, steps: new Set(), done: false, branch: r.headBranch }
        f.runs.set(r.databaseId, seen)
      }
      if (seen.done) continue
      if (!seen.started) {
        seen.started = true
        f.lastActivity = t
        this.deps.emit(f.projectId, f.runId, "ci.run.started", {
          gh_run_id: r.databaseId,
          workflow: r.workflowName,
          sha: r.headSha,
          branch: r.headBranch,
          url: r.url,
        })
      }
      try {
        const d = await workflowRun(opts, r.databaseId)
        for (const j of d.jobs)
          for (const s of j.steps) {
            const key = `${j.name}/${s.name}`
            if (s.status !== "completed" || seen.steps.has(key)) continue
            seen.steps.add(key)
            f.lastActivity = t
            this.deps.emit(f.projectId, f.runId, "ci.run.step", {
              gh_run_id: r.databaseId,
              workflow: r.workflowName,
              job: j.name,
              step: s.name,
              conclusion: s.conclusion || null,
              duration_ms:
                s.startedAt && s.completedAt
                  ? Date.parse(s.completedAt) - Date.parse(s.startedAt)
                  : null,
            })
          }
        if (d.status === "completed") {
          seen.done = true
          f.lastActivity = t
          this.deps.emit(f.projectId, f.runId, "ci.run.completed", {
            gh_run_id: r.databaseId,
            workflow: r.workflowName,
            sha: r.headSha,
            branch: r.headBranch,
            conclusion: d.conclusion || null,
            duration_ms: Date.parse(d.updatedAt) - Date.parse(d.createdAt),
            url: r.url,
          })
        }
      } catch {
        // Un detalle que no llega se intenta en la siguiente vuelta.
      }
    }
    const all = [...f.runs.values()]
    const finished =
      (all.length === 0 && t - f.since > NOTHING_AFTER_MS) ||
      (all.length > 0 && all.every((x) => x.done) && t - f.lastActivity > QUIET_AFTER_MS) ||
      t - f.since > MAX_FOLLOW_MS
    if (finished) this.follows.delete(f.sha)
  }
}
