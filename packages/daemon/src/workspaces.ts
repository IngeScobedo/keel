/**
 * Espacio de trabajo de cada run (SDD 02 §4 «Git y lanes», SDD 04 Fase 0).
 *
 * Decisiones del humano (2026-10-22):
 * - Los worktrees viven **fuera del repo**, en
 *   `<worktreesDir>/<project>/<repo>/<KEEL-n>/<run>/root`; por defecto
 *   `$XDG_STATE_HOME/keel/worktrees` (`%LOCALAPPDATA%\keel\worktrees` en Windows). Ni el IDE ni las herramientas del repo
 *   los recorren.
 * - Rama `keel/<KEEL-n>/<run>/root`, el esquema de SDD 02.
 * - **Liberación según el final del run.** `cancelled`, `failed`, `interrupted`
 *   o `budget_exceeded` liberan al terminar; `completed` conserva el worktree
 *   mientras la tarea está en `needs_review` y se libera cuando sale de ahí.
 *   Liberar siempre rescata antes los cambios sin commit (`@keel/git`).
 * - **Sin repo git, un run `execute` falla explícito.** Los runs `plan` y
 *   `triage_eval` son de sólo lectura y corren en la raíz. Un proyecto sin git
 *   usa `DirectFsDriver` sólo si el humano lo confirmó (ADR-0010).
 *
 * El estado vive en git (ADR-0007 §5); `run_worktrees` es el índice del
 * daemon. Este módulo no publica eventos: devuelve lo que pasó y el daemon lo
 * emite.
 */
import { existsSync } from "node:fs"
import { basename, join } from "node:path"
import {
  BRANCH_PREFIX,
  type Changes,
  captureChanges,
  createWorktree,
  GitError,
  type GitRepo,
  git,
  openRepo,
  type RemoveResult,
  reconcile,
  removeWorktree,
} from "@keel/git"
import { defaultStateDir } from "./state-dir.js"
import type { Repo, RunRow, RunWorktreeRow, WorkItemRow } from "./store/repo.js"
import type {
  Provisioned,
  WorkspaceDriver,
  WorkspaceEvent,
  WorkspaceGuarantees,
} from "./workspace-driver.js"

export function defaultWorktreesDir(
  platform: NodeJS.Platform = process.platform,
  env: Record<string, string | undefined> = process.env,
): string {
  return join(defaultStateDir(platform, env), "worktrees")
}

/** Run cuyo final libera el worktree en cuanto termina; `completed` espera a la revisión. */
export function releasesOnFinish(status: RunRow["status"]): boolean {
  return ["cancelled", "failed", "interrupted", "budget_exceeded"].includes(status)
}

export type Released = {
  /** null si git lo conocía pero `run_worktrees` no (caída entre crear y registrar). */
  worktree: RunWorktreeRow | null
  branch: string
  result: RemoveResult
}

export type WorkspacesDeps = {
  repo: Repo
  /** Carpeta del proyecto: cada proyecto abierto tiene la suya (ADR-0019 §2). */
  rootOf: (projectId: string) => string
  worktreesDir: string
  owner?: string
}

export class GitWorktreeDriver implements WorkspaceDriver {
  readonly kind = "git_worktree"
  readonly guarantees: WorkspaceGuarantees = {
    isolation: "worktree",
    rescue: "git_ref",
    parallel: true,
  }
  private readonly deps: WorkspacesDeps
  private readonly repos = new Map<string, GitRepo>()
  constructor(deps: WorkspacesDeps) {
    this.deps = deps
  }

  /** Prepara dónde corre el run. Nunca rechaza por un repo ausente: devuelve `ok: false`. */
  async provision(run: RunRow, item: WorkItemRow): Promise<Provisioned> {
    const { repo, worktreesDir } = this.deps
    const rootPath = this.deps.rootOf(run.project_id)
    // ADR-0021 §3: una tarea en el método trabaja en su worktree desde el primer run,
    // también en las etapas de sólo lectura; así la sesión se retoma siempre.
    const taskWorktree =
      (JSON.parse(run.context_manifest_json) as { task_worktree?: boolean }).task_worktree === true
    if (run.purpose !== "execute" && !taskWorktree) return { ok: true, cwd: rootPath, events: [] }
    // Continuar una conversación (ADR-0019 §3): el run hijo se lleva el worktree del
    // padre si sigue en disco; así el agente retoma en la misma carpeta y rama.
    if (run.parent_run_id) {
      const inherited = repo
        .runWorktrees(run.parent_run_id)
        .filter((w) => existsSync(w.worktree_path))
      if (inherited.length > 0) {
        repo.transferWorktrees(run.parent_run_id, run.id)
        const root = inherited.find((w) => w.slot === "root") ?? (inherited[0] as RunWorktreeRow)
        return {
          ok: true,
          cwd: root.worktree_path,
          events: inherited.map((w) => ({
            kind: "worktree.inherited",
            payload: { ...w, run_id: run.id, from_run_id: run.parent_run_id },
          })),
        }
      }
    }
    let gitRepo: GitRepo
    try {
      gitRepo = await this.gitRepo(rootPath)
    } catch (e) {
      if (e instanceof GitError && e.kind === "not_a_repository")
        return {
          ok: false,
          message: `un run execute necesita un repositorio git en ${rootPath}; no lo hay. Si el proyecto no usa git, confírmalo con projects.set_vcs (ADR-0010)`,
        }
      throw e
    }
    const alias = basename(gitRepo.root)
    const projectRepo = repo.ensurePrimaryRepo({
      project_id: run.project_id,
      local_path: gitRepo.root,
      alias,
      repo_url: await originUrl(gitRepo),
    })
    const key = `${item.display_id}/${run.id}/root`
    const path = join(worktreesDir, run.project_id, alias, ...key.split("/"))
    const wt = await createWorktree(gitRepo, {
      runId: key,
      path,
      owner: this.deps.owner ?? "keel-daemon",
    })
    const row = repo.addRunWorktree({
      project_id: run.project_id,
      run_id: run.id,
      project_repo_id: projectRepo.id,
      slot: "root",
      // La ruta canónica de @keel/git (en Windows puede diferir de la pedida: 8.3, C:/).
      worktree_path: wt.path as string,
      base_sha: wt.baseSha as string,
      branch_name: wt.branch,
      access_mode: "write",
    })
    return {
      ok: true,
      cwd: row.worktree_path,
      events: [{ kind: "worktree.created", payload: row }],
    }
  }

  async capture(runId: string): Promise<WorkspaceEvent[]> {
    return (await this.captureWorktrees(runId)).map(({ worktree, changes }) => ({
      kind: "worktree.changes",
      payload: {
        worktree_id: worktree.id,
        branch: worktree.branch_name,
        base_sha: worktree.base_sha,
        head_sha: changes.headSha,
        commits_ahead: changes.commitsAhead,
        dirty: changes.dirty,
        files: changes.files,
      },
    }))
  }

  async release(runId: string): Promise<WorkspaceEvent[]> {
    return (await this.releaseWorktrees(runId)).map(({ worktree, branch, result }) => ({
      kind: "worktree.released",
      payload: {
        worktree_id: worktree?.id ?? null,
        branch,
        rescue_ref: result.rescueRef,
        branch_kept: result.branchKept,
      },
    }))
  }

  /** Cambios de cada worktree del run respecto a su base; guarda el `head_sha`. */
  async captureWorktrees(runId: string): Promise<{ worktree: RunWorktreeRow; changes: Changes }[]> {
    const out: { worktree: RunWorktreeRow; changes: Changes }[] = []
    for (const w of this.deps.repo.runWorktrees(runId)) {
      try {
        const changes = await captureChanges(w.worktree_path, w.base_sha)
        this.deps.repo.setWorktreeHead(w.id, changes.headSha)
        out.push({ worktree: w, changes })
      } catch (e) {
        // Un worktree que ya no existe no tiene cambios que capturar; reconcile lo verá.
        if (!(e instanceof GitError)) throw e
      }
    }
    return out
  }

  /**
   * Libera los worktrees del run, rescatando antes. Idempotente. Además de los
   * registrados en `run_worktrees`, busca en git los de este run que no llegaron
   * a registrarse (caída entre crearlo y guardarlo): la verdad está en git.
   */
  async releaseWorktrees(runId: string): Promise<Released[]> {
    const out: Released[] = []
    const seen = new Set<string>()
    for (const w of this.deps.repo.runWorktrees(runId)) {
      const projectRepo = this.deps.repo.getProjectRepo(w.project_repo_id)
      if (!projectRepo) continue
      const key = w.branch_name.slice(BRANCH_PREFIX.length)
      seen.add(key)
      const result = await removeWorktree(await this.gitRepo(projectRepo.local_path), key)
      if (result.removed) out.push({ worktree: w, branch: w.branch_name, result })
    }
    let root: GitRepo
    try {
      const run = this.deps.repo.getRun(runId)
      if (!run) return out
      root = await this.gitRepo(this.deps.rootOf(run.project_id))
    } catch (e) {
      if (e instanceof GitError && e.kind === "not_a_repository") return out
      throw e
    }
    for (const wt of await reconcile(root)) {
      if (seen.has(wt.runId) || wt.runId.split("/")[1] !== runId) continue
      const result = await removeWorktree(root, wt.runId)
      if (result.removed) out.push({ worktree: null, branch: wt.branch, result })
    }
    return out
  }

  private async gitRepo(path: string): Promise<GitRepo> {
    const cached = this.repos.get(path)
    if (cached) return cached
    const r = await openRepo(path)
    this.repos.set(path, r)
    return r
  }
}

async function originUrl(repo: GitRepo): Promise<string> {
  try {
    return (await git(["remote", "get-url", "origin"], { cwd: repo.root })).stdout.trim()
  } catch {
    return `file://${repo.root}`
  }
}
