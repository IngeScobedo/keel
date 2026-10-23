/**
 * Operaciones de git del agente con plan aprobado (ADR-0015). El agente
 * propone; el humano aprueba un plan con su hash; el daemon ejecuta con
 * `@keel/git` revalidando en cada paso que HEAD, contenido y destino siguen
 * siendo los del plan. Nunca `force push`, nunca a una rama protegida, y la PR
 * con el `gh` del usuario (Keel no guarda tokens de GitHub).
 */
import { spawnSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { type GitPlan, GitPlanSchema } from "@keel/core"
import {
  changedFiles,
  commitPaths,
  contentHash,
  currentBranch,
  git,
  headSha,
  numstat,
  openRepo,
  pushBranch,
  unifiedDiff,
} from "@keel/git"
import type { ArtifactStore } from "./artifacts.js"
import { canonicalJson, sha256Hex } from "./ids.js"

/** Un plan vive más que una aprobación de herramienta: se revisa con calma. */
export const PLAN_TTL_MS = 30 * 60_000
/** Tope del diff que viaja en una respuesta; el entero va como artefacto. */
export const DIFF_INLINE_MAX = 200_000

export type PlanStep = { op: string; state: "done" | "skipped" | "failed"; detail: unknown }

export type GitPlansDeps = {
  artifacts: ArtifactStore
  /** Emite un evento del run (fuente `keel`): los semánticos nacen instrumentados. */
  emit: (runId: string, kind: string, payload: unknown) => void
  /** Ejecutable de `gh`; null o inexistente = la PR queda pendiente con la causa. */
  gh: string | null
}

/** Ramas que el plan nunca toca: la por defecto del repo y las que declare el proyecto. */
export async function protectedBranches(root: string, remote = "origin"): Promise<string[]> {
  const out = new Set<string>()
  try {
    const head = (
      await git(["symbolic-ref", "--short", `refs/remotes/${remote}/HEAD`], { cwd: root })
    ).stdout.trim()
    out.add(head.replace(`${remote}/`, ""))
  } catch {
    // Sin HEAD remoto: la rama actual del árbol principal es la por defecto.
    const b = await currentBranch(root).catch(() => null)
    if (b) out.add(b)
  }
  for (const b of ["main", "master"]) out.add(b)
  // `.keel/project.toml`: [git] protected_branches = ["release/*"]
  const toml = join(root, ".keel", "project.toml")
  if (existsSync(toml))
    try {
      const cfg = Bun.TOML.parse(readFileSync(toml, "utf8")) as {
        git?: { protected_branches?: unknown }
      }
      const list = cfg.git?.protected_branches
      if (Array.isArray(list)) for (const b of list) if (typeof b === "string") out.add(b)
    } catch {
      // Un toml roto no relaja nada: quedan las protegidas por defecto.
    }
  return [...out]
}

export function isProtected(branch: string, protectedList: string[]): boolean {
  return protectedList.some((p) =>
    p.endsWith("*") ? branch.startsWith(p.slice(0, -1)) : branch === p,
  )
}

/** Construye el plan del worktree del run; lanza si el destino está protegido. */
export async function buildPlan(
  deps: GitPlansDeps,
  run: { id: string; work_item_id: string },
  worktree: string,
  p: {
    message: string
    paths?: string[] | undefined
    push?: { remote?: string | undefined; branch?: string | undefined } | undefined
    pr?: { base?: string | undefined; title: string; body?: string | undefined } | undefined
  },
): Promise<{ plan: GitPlan; plan_hash: string }> {
  const repo = await openRepo(worktree)
  const branch = await currentBranch(worktree)
  if (!branch) throw new Error("el worktree no está en una rama (HEAD separado)")
  const all = await changedFiles(worktree)
  const wanted = p.paths?.length ? all.filter((f) => p.paths?.includes(f.path)) : all
  if (wanted.length === 0) throw new Error("no hay cambios que confirmar en esos archivos")
  const files = await numstat(worktree, wanted)
  const paths = files.map((f) => f.path)
  const protectedList = await protectedBranches(repo.root, p.push?.remote ?? "origin")
  const operations: GitPlan["operations"] = [{ op: "commit", message: p.message, paths }]
  if (p.push || p.pr) {
    const target = p.push?.branch ?? branch
    // Sólo a la rama del run o a la que nombre el plan, y nunca a una protegida.
    if (isProtected(target, protectedList))
      throw new Error(
        `la rama ${target} está protegida; el merge a ella es una decisión humana (ADR-0015 §4)`,
      )
    operations.push({ op: "push", remote: p.push?.remote ?? "origin", branch: target })
    if (p.pr)
      operations.push({
        op: "pr.create",
        base: p.pr.base ?? (protectedList[0] as string),
        head: target,
        title: p.pr.title,
        body: p.pr.body ?? "",
      })
  }
  const diff = await unifiedDiff(worktree, wanted)
  const diffRef = diff ? deps.artifacts.put(diff, "text/x-diff").ref : null
  const plan: GitPlan = GitPlanSchema.parse({
    version: 1,
    run_id: run.id,
    work_item_id: run.work_item_id,
    repo_root: repo.root,
    worktree,
    branch,
    expected_head_sha: await headSha(worktree),
    content_hash: await contentHash(worktree, paths),
    files,
    diff_ref: diffRef,
    operations,
  })
  return { plan, plan_hash: await sha256Hex(canonicalJson(plan)) }
}

/**
 * Ejecuta un plan aprobado. Antes del commit revalida HEAD, rama y contenido;
 * antes del push, que HEAD sea el commit recién hecho. Si algo cambió, el plan
 * caduca y no se toca nada más.
 */
export async function executePlan(
  deps: GitPlansDeps,
  planId: string,
  plan: GitPlan,
  env: Record<string, string>,
): Promise<{ ok: true; steps: PlanStep[] } | { ok: false; reason: string; steps: PlanStep[] }> {
  const steps: PlanStep[] = []
  const wt = plan.worktree
  const expire = (reason: string) => {
    deps.emit(plan.run_id, "git.plan.expired", { plan_id: planId, reason })
    return { ok: false as const, reason, steps }
  }
  if (!existsSync(wt)) return expire("el worktree ya no existe")
  if ((await currentBranch(wt)) !== plan.branch) return expire("la rama del worktree cambió")
  if ((await headSha(wt)) !== plan.expected_head_sha) return expire("HEAD cambió desde el plan")
  const commitOp = plan.operations.find((o) => o.op === "commit")
  const paths = commitOp?.op === "commit" ? commitOp.paths : []
  if ((await contentHash(wt, paths)) !== plan.content_hash)
    return expire("el contenido de los archivos cambió desde el plan")

  let commitSha: string | null = null
  for (const op of plan.operations) {
    try {
      if (op.op === "commit") {
        const c = await commitPaths(wt, { message: op.message, files: op.paths, env })
        commitSha = c.sha
        deps.emit(plan.run_id, "git.commit.created", {
          sha: c.sha,
          message: op.message,
          files: c.files,
          branch: plan.branch,
          worktree: wt,
          plan_id: planId,
        })
        steps.push({ op: "commit", state: "done", detail: { sha: c.sha, files: c.files } })
      } else if (op.op === "push") {
        if ((await headSha(wt)) !== commitSha) return expire("HEAD cambió antes del push")
        const r = await pushBranch(wt, { remote: op.remote, branch: op.branch })
        deps.emit(plan.run_id, "git.push.completed", {
          remote: op.remote,
          ref: op.branch,
          old_sha: r.old_sha,
          new_sha: r.new_sha,
          plan_id: planId,
        })
        steps.push({ op: "push", state: "done", detail: r })
      } else if (op.op === "pr.create") {
        const pr = createPullRequest(deps.gh, wt, op)
        if (pr.ok) {
          deps.emit(plan.run_id, "git.pull_request.created", {
            url: pr.url,
            number: pr.number,
            plan_id: planId,
          })
          steps.push({ op: "pr.create", state: "done", detail: pr })
        } else {
          // Sin `gh` autenticado el commit y el push valen; la PR queda pendiente con su causa.
          deps.emit(plan.run_id, "git.pull_request.pending", { plan_id: planId, reason: pr.reason })
          steps.push({ op: "pr.create", state: "skipped", detail: { reason: pr.reason } })
        }
      }
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e)
      steps.push({ op: op.op, state: "failed", detail: { reason } })
      deps.emit(plan.run_id, "git.plan.failed", { plan_id: planId, op: op.op, reason })
      return { ok: false, reason, steps }
    }
  }
  deps.emit(plan.run_id, "git.plan.completed", { plan_id: planId, steps })
  return { ok: true, steps }
}

function createPullRequest(
  gh: string | null,
  cwd: string,
  op: { base: string; head: string; title: string; body: string },
): { ok: true; url: string; number: number | null } | { ok: false; reason: string } {
  if (!gh) return { ok: false, reason: "gh no está configurado" }
  const auth = spawnSync(gh, ["auth", "status"], { cwd, encoding: "utf8", timeout: 20_000 })
  if (auth.error) return { ok: false, reason: `gh no disponible: ${auth.error.message}` }
  if (auth.status !== 0)
    return { ok: false, reason: `gh no tiene sesión: ${(auth.stderr || auth.stdout).trim()}` }
  const r = spawnSync(
    gh,
    ["pr", "create", "--base", op.base, "--head", op.head, "--title", op.title, "--body", op.body],
    { cwd, encoding: "utf8", timeout: 60_000 },
  )
  if (r.status !== 0) return { ok: false, reason: (r.stderr || r.stdout).trim() }
  const url = r.stdout.trim().split("\n").pop() ?? ""
  const n = /\/pull\/(\d+)/.exec(url)
  return { ok: true, url, number: n ? Number(n[1]) : null }
}
