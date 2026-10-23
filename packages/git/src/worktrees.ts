/**
 * Worktrees aislados por run (ADR-0007 §5, SDD 04 Fase 0).
 *
 * La fuente de verdad es el propio repositorio, no un store externo:
 * - `refs/keel/runs/<run_id>` apunta a la base SHA y existe mientras el run
 *   tenga worktree. Se escribe **antes** de crear el worktree y se borra
 *   **después** de quitarlo, así que un crash en medio deja un ref huérfano que
 *   `reconcile()` ve, nunca un worktree que nadie reconoce.
 * - La rama `keel/<run_id>` es la del worktree.
 * - `keel.json` en el git-dir del worktree guarda metadatos para humanos y
 *   herramientas; si se pierde, el ref basta.
 * - Los cambios sin commit se rescatan en `refs/keel/rescue/<run_id>/<stamp>`
 *   antes de cualquier limpieza. Nada se borra sin rescatar antes.
 */
import { randomUUID } from "node:crypto"
import { existsSync, realpathSync } from "node:fs"
import { readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { isAbsolute, join, resolve } from "node:path"
import { DEFAULT_RETRY, GitError, git, type RetryPolicy, retryOnLock } from "./exec.js"
import { withRepoLock } from "./lock.js"

export const RUN_REF_PREFIX = "refs/keel/runs/"
export const RESCUE_REF_PREFIX = "refs/keel/rescue/"
export const BRANCH_PREFIX = "keel/"
const META_FILE = "keel.json"

/** Un repositorio resuelto: raíz del árbol principal y `.git` común absoluto. */
export type GitRepo = { root: string; commonDir: string; retry: RetryPolicy }

export async function openRepo(path: string, opts: { retry?: RetryPolicy } = {}): Promise<GitRepo> {
  const { stdout } = await git(
    ["rev-parse", "--path-format=absolute", "--show-toplevel", "--git-common-dir"],
    { cwd: path },
  )
  const [root, commonDir] = stdout.trim().split("\n")
  if (!root || !commonDir)
    throw new GitError("not_a_repository", `no es un árbol de trabajo git: ${path}`)
  return { root, commonDir, retry: opts.retry ?? DEFAULT_RETRY }
}

export type WorktreeMeta = {
  version: 1
  run_id: string
  base_sha: string
  branch: string
  path: string
  created_at: string
  /** Quién lo creó (p. ej. `keel-daemon`); libre para otros harness. */
  owner: string | null
}

export type WorktreeState =
  /** Ref, worktree y directorio presentes. */
  | "active"
  /** Git lo lista pero el directorio ya no existe (`prunable`). */
  | "missing"
  /** El ref existe y no hay worktree: crash entre crear el ref y el worktree, o al limpiar. */
  | "orphan_ref"
  /** Worktree en una rama `keel/*` sin ref de run: creado a mano o por otra versión. */
  | "unregistered"

export type KeelWorktree = {
  runId: string
  state: WorktreeState
  path: string | null
  branch: string
  baseSha: string | null
  headSha: string | null
  /** Sólo se mide en `active`. */
  dirty: boolean | null
  meta: WorktreeMeta | null
}

const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

/**
 * El id puede ser jerárquico, en segmentos separados por `/`: el SDD 02 nombra
 * las ramas `keel/<work-item>/<run>/<lane>`. Ningún id puede ser prefijo de otro
 * por segmentos (`a` y `a/b`): git no admite un ref y un directorio con el mismo
 * nombre, y lo rechaza como `conflict`.
 */
function assertRunId(runId: string): void {
  const segments = runId.split("/")
  const ok =
    segments.length <= 8 &&
    segments.every((seg) => SEGMENT.test(seg) && !seg.endsWith(".lock") && !seg.includes(".."))
  if (!ok) throw new GitError("invalid_argument", `run_id no sirve como nombre de ref: ${runId}`)
}

/** Escribe en el `.git` común: serializado en el proceso y con reintento ante locks ajenos. */
function write<T>(repo: GitRepo, fn: () => Promise<T>): Promise<T> {
  return withRepoLock(repo.commonDir, () => retryOnLock(fn, repo.retry))
}

/**
 * Crea `keel/<runId>` desde `base` en `path`. Falla con `conflict` si el run ya
 * tiene ref o el destino ya es un worktree.
 */
export async function createWorktree(
  repo: GitRepo,
  opts: { runId: string; path: string; base?: string; owner?: string },
): Promise<KeelWorktree> {
  assertRunId(opts.runId)
  if (!isAbsolute(opts.path))
    throw new GitError("invalid_argument", `la ruta del worktree debe ser absoluta: ${opts.path}`)
  const branch = `${BRANCH_PREFIX}${opts.runId}`
  const ref = `${RUN_REF_PREFIX}${opts.runId}`
  return write(repo, async () => {
    const baseSha = (
      await git(["rev-parse", "--verify", `${opts.base ?? "HEAD"}^{commit}`], { cwd: repo.root })
    ).stdout.trim()
    if (await refExists(repo, `refs/heads/${branch}`))
      throw new GitError("conflict", `la rama ${branch} ya existe`)
    // Valor anterior vacío: sólo crea; si el ref ya existe, git falla (conflict) y no pisa nada.
    await git(["update-ref", ref, baseSha, ""], { cwd: repo.root })
    try {
      await git(["worktree", "add", "-b", branch, opts.path, baseSha], { cwd: repo.root })
    } catch (e) {
      // `worktree add -b` que falla deja la rama creada (medido con git 2.43): se deshace todo.
      if (await refExists(repo, `refs/heads/${branch}`))
        await git(["branch", "-D", branch], { cwd: repo.root }).catch(() => undefined)
      await git(["update-ref", "-d", ref, baseSha], { cwd: repo.root }).catch(() => undefined)
      throw e
    }
    // Ruta canónica, la misma que devolverá reconcile() (ver canonical()).
    const path = canonical(opts.path)
    const meta: WorktreeMeta = {
      version: 1,
      run_id: opts.runId,
      base_sha: baseSha,
      branch,
      path,
      created_at: new Date().toISOString(),
      owner: opts.owner ?? null,
    }
    await writeFile(join(await worktreeGitDir(path), META_FILE), JSON.stringify(meta, null, 2))
    return {
      runId: opts.runId,
      state: "active",
      path,
      branch,
      baseSha,
      headSha: baseSha,
      dirty: false,
      meta,
    }
  })
}

/**
 * Estado de todos los worktrees de Keel, reconstruido sólo desde git: refs
 * `refs/keel/runs/*` y `git worktree list --porcelain`. No modifica nada.
 */
export async function reconcile(repo: GitRepo): Promise<KeelWorktree[]> {
  const refs = await runRefs(repo)
  const trees = await listWorktrees(repo)
  const byBranch = new Map(trees.filter((t) => t.branch).map((t) => [t.branch as string, t]))
  const out: KeelWorktree[] = []
  for (const [runId, baseSha] of refs) {
    const branch = `${BRANCH_PREFIX}${runId}`
    const t = byBranch.get(`refs/heads/${branch}`)
    byBranch.delete(`refs/heads/${branch}`)
    out.push(await describe(runId, branch, baseSha, t ?? null))
  }
  for (const [fullBranch, t] of byBranch) {
    if (!fullBranch.startsWith(`refs/heads/${BRANCH_PREFIX}`)) continue
    const branch = fullBranch.slice("refs/heads/".length)
    out.push(await describe(branch.slice(BRANCH_PREFIX.length), branch, null, t))
  }
  return out.sort((a, b) => a.runId.localeCompare(b.runId))
}

async function describe(
  runId: string,
  branch: string,
  baseSha: string | null,
  t: ListedWorktree | null,
): Promise<KeelWorktree> {
  if (!t)
    return {
      runId,
      state: "orphan_ref",
      path: null,
      branch,
      baseSha,
      headSha: null,
      dirty: null,
      meta: null,
    }
  const present = !t.prunable && existsSync(t.path)
  return {
    runId,
    state: baseSha === null ? "unregistered" : present ? "active" : "missing",
    path: t.path,
    branch,
    baseSha,
    headSha: t.head,
    dirty: present ? (await statusEntries(t.path)).length > 0 : null,
    meta: present ? await readMeta(t.path) : null,
  }
}

export type ChangedFile = {
  path: string
  /** Código XY de `git status --porcelain=v1` (p. ej. ` M`, `??`, `A `). */
  status: string
}

export type Changes = {
  headSha: string
  /** Commits del worktree por encima de la base. */
  commitsAhead: number
  dirty: boolean
  files: ChangedFile[]
}

/** Qué cambió en un worktree respecto a su base: commits nuevos y archivos sin commit. */
export async function captureChanges(path: string, baseSha: string): Promise<Changes> {
  const headSha = (await git(["rev-parse", "HEAD"], { cwd: path })).stdout.trim()
  const ahead = Number(
    (await git(["rev-list", "--count", `${baseSha}..HEAD`], { cwd: path })).stdout.trim(),
  )
  const files = await statusEntries(path)
  return { headSha, commitsAhead: ahead, dirty: files.length > 0, files }
}

/**
 * Guarda los cambios sin commit (incluidos los no rastreados) en un commit
 * colgado de `refs/keel/rescue/<runId>/<stamp>`, sin tocar el índice ni la rama
 * del worktree. Devuelve el ref, o null si no había nada que rescatar.
 */
export async function preserveChanges(
  repo: GitRepo,
  opts: { runId: string; path: string },
): Promise<string | null> {
  assertRunId(opts.runId)
  if ((await statusEntries(opts.path)).length === 0) return null
  const index = join(tmpdir(), `keel-rescue-${randomUUID()}.index`)
  const env = {
    GIT_INDEX_FILE: index,
    GIT_AUTHOR_NAME: "keel",
    GIT_AUTHOR_EMAIL: "keel@localhost",
    GIT_COMMITTER_NAME: "keel",
    GIT_COMMITTER_EMAIL: "keel@localhost",
  }
  try {
    await git(["read-tree", "HEAD"], { cwd: opts.path, env })
    await git(["add", "-A"], { cwd: opts.path, env })
    const tree = (await git(["write-tree"], { cwd: opts.path, env })).stdout.trim()
    const commit = (
      await git(["commit-tree", tree, "-p", "HEAD", "-m", `keel: rescate de ${opts.runId}`], {
        cwd: opts.path,
        env,
      })
    ).stdout.trim()
    const ref = `${RESCUE_REF_PREFIX}${opts.runId}/${new Date().toISOString().replace(/[-:.]/g, "")}`
    await write(repo, () => git(["update-ref", ref, commit, ""], { cwd: repo.root }))
    return ref
  } finally {
    await rm(index, { force: true })
  }
}

export type RemoveResult = {
  removed: boolean
  /** Ref con los cambios rescatados, si los había. */
  rescueRef: string | null
  /** La rama se conserva si tiene commits sobre la base o hubo rescate. */
  branchKept: boolean
}

/**
 * Quita el worktree del run y su ref. Idempotente: un run sin rastro devuelve
 * `removed: false`. Rescata antes de borrar; nunca pierde trabajo.
 */
export async function removeWorktree(repo: GitRepo, runId: string): Promise<RemoveResult> {
  assertRunId(runId)
  const entry = (await reconcile(repo)).find((w) => w.runId === runId)
  if (!entry) return { removed: false, rescueRef: null, branchKept: false }
  let rescueRef: string | null = null
  let ahead = 0
  if (entry.state === "active" && entry.path) {
    rescueRef = await preserveChanges(repo, { runId, path: entry.path })
    if (entry.baseSha) ahead = (await captureChanges(entry.path, entry.baseSha)).commitsAhead
  }
  await write(repo, async () => {
    if (entry.state === "active" && entry.path)
      await git(["worktree", "remove", "--force", entry.path], { cwd: repo.root })
    else if (entry.state === "missing") await git(["worktree", "prune"], { cwd: repo.root })
  })
  const branchKept = ahead > 0 || rescueRef !== null || entry.state === "unregistered"
  await write(repo, async () => {
    if (!branchKept && (await refExists(repo, `refs/heads/${entry.branch}`)))
      await git(["branch", "-D", entry.branch], { cwd: repo.root })
    if (entry.baseSha)
      await git(["update-ref", "-d", `${RUN_REF_PREFIX}${runId}`], { cwd: repo.root })
  })
  return { removed: true, rescueRef, branchKept }
}

// --- lectura de git ------------------------------------------------------------------

type ListedWorktree = {
  path: string
  head: string | null
  branch: string | null
  prunable: boolean
}

/** `git worktree list --porcelain -z`: campos separados por NUL, registros por NUL doble. */
async function listWorktrees(repo: GitRepo): Promise<ListedWorktree[]> {
  const { stdout } = await git(["worktree", "list", "--porcelain", "-z"], { cwd: repo.root })
  const out: ListedWorktree[] = []
  let cur: ListedWorktree | null = null
  for (const field of stdout.split("\0")) {
    if (field === "") {
      if (cur) out.push(cur)
      cur = null
      continue
    }
    const sp = field.indexOf(" ")
    const key = sp === -1 ? field : field.slice(0, sp)
    const value = sp === -1 ? "" : field.slice(sp + 1)
    if (key === "worktree")
      cur = { path: canonical(value), head: null, branch: null, prunable: false }
    else if (!cur) continue
    else if (key === "HEAD") cur.head = value
    else if (key === "branch") cur.branch = value
    else if (key === "prunable") cur.prunable = true
  }
  if (cur) out.push(cur)
  return out
}

async function runRefs(repo: GitRepo): Promise<Map<string, string>> {
  const { stdout } = await git(
    ["for-each-ref", "--format=%(refname) %(objectname)", RUN_REF_PREFIX],
    { cwd: repo.root },
  )
  const refs = new Map<string, string>()
  for (const line of stdout.split("\n")) {
    const [name, sha] = line.trim().split(" ")
    if (name && sha) refs.set(name.slice(RUN_REF_PREFIX.length), sha)
  }
  return refs
}

async function refExists(repo: GitRepo, ref: string): Promise<boolean> {
  try {
    await git(["show-ref", "--verify", "--quiet", ref], { cwd: repo.root })
    return true
  } catch {
    return false
  }
}

async function statusEntries(path: string): Promise<ChangedFile[]> {
  const { stdout } = await git(["status", "--porcelain=v1", "-z", "--untracked-files=all"], {
    cwd: path,
  })
  const out: ChangedFile[] = []
  const fields = stdout.split("\0")
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i] as string
    if (f.length < 4) continue
    const status = f.slice(0, 2)
    out.push({ path: f.slice(3), status })
    // Renombres y copias traen la ruta de origen en el campo siguiente.
    if (status[0] === "R" || status[0] === "C") i++
  }
  return out
}

/**
 * Forma canónica de una ruta, para que las de git y las del llamador coincidan.
 * En Windows git lista `C:/…` aunque se haya creado con `C:\…`, y el temporal del
 * sistema puede venir en formato 8.3 (`RUNNER~1`) mientras git da el nombre largo
 * (medido en el runner de GitHub, 2026-10-23). `realpath.native` resuelve las dos
 * cosas; si la ruta ya no existe, queda `resolve`.
 */
export function canonical(path: string): string {
  try {
    return realpathSync.native(path)
  } catch {
    return resolve(path)
  }
}

async function worktreeGitDir(path: string): Promise<string> {
  const { stdout } = await git(["rev-parse", "--path-format=absolute", "--git-dir"], { cwd: path })
  return resolve(stdout.trim())
}

async function readMeta(path: string): Promise<WorktreeMeta | null> {
  try {
    const raw = await readFile(join(await worktreeGitDir(path), META_FILE), "utf8")
    return JSON.parse(raw) as WorktreeMeta
  } catch {
    return null
  }
}
