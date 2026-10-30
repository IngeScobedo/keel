/**
 * Los cambios de una tarea respecto a su base: commits con sus archivos y el diff
 * completo, incluido lo que aún no está en un commit y los archivos nuevos. Se lee del
 * worktree mientras vive y se guarda como evidencia `diff` (ADR-0012 §3 y §7) antes de
 * liberarlo, así la historia no se pierde al mergear y cerrar la tarea.
 */
import { git } from "./base-sync.js"

export type FileStat = { path: string; additions: number; deletions: number }
export type CommitRecord = {
  sha: string
  subject: string
  author: string
  date: string
  files: FileStat[]
}
export type ChangeRecord = {
  branch: string | null
  base_sha: string
  head_sha: string | null
  commits: CommitRecord[]
  files: FileStat[]
  diff: string
}

function numstat(lines: string[]): FileStat[] {
  return lines
    .map((l) => l.split("\t"))
    .filter((p) => p.length >= 3)
    .map(([a = "0", d = "0", ...path]) => ({
      path: path.join("\t"),
      // Un binario viene con «-».
      additions: a === "-" ? 0 : Number(a),
      deletions: d === "-" ? 0 : Number(d),
    }))
}

/** Lo que cambió en `worktree` desde `baseSha`, con la historia de commits. */
export async function readChanges(worktree: string, baseSha: string): Promise<ChangeRecord> {
  const branch = (await git(worktree, ["rev-parse", "--abbrev-ref", "HEAD"], {})).out || null
  const head = await git(worktree, ["rev-parse", "HEAD"], {})
  const log = await git(
    worktree,
    ["log", "--reverse", "--format=%x1e%H%x1f%s%x1f%an%x1f%cI", "--numstat", `${baseSha}..HEAD`],
    {},
  )
  const commits = log.out
    .split("\x1e")
    .map((x) => x.trim())
    .filter(Boolean)
    .map((block) => {
      const [first = "", ...rest] = block.split("\n")
      const [sha = "", subject = "", author = "", date = ""] = first.split("\x1f")
      return { sha, subject, author, date, files: numstat(rest.filter(Boolean)) }
    })
  // Contra la base, con lo que aún no está en un commit.
  const tracked = await git(worktree, ["diff", "--no-color", baseSha], {})
  const stats = numstat((await git(worktree, ["diff", "--numstat", baseSha], {})).out.split("\n"))
  const untracked = (await git(worktree, ["ls-files", "--others", "--exclude-standard"], {})).out
    .split("\n")
    .filter(Boolean)
  let diff = tracked.out
  for (const f of untracked) {
    // `--no-index` sale con 1 cuando hay diferencias: es lo esperado.
    const d = await git(worktree, ["diff", "--no-color", "--no-index", "/dev/null", f], {})
    if (d.out) diff += `${diff ? "\n" : ""}${d.out}`
    const lines = d.out.split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++")).length
    stats.push({ path: f, additions: lines, deletions: 0 })
  }
  return {
    branch: branch === "HEAD" ? null : branch,
    base_sha: baseSha,
    head_sha: head.code === 0 ? head.out : null,
    commits,
    files: stats,
    diff: diff ? `${diff}\n` : "",
  }
}

/**
 * Lo que cambió una rama desde `baseSha`, sin worktree: la rama de una feature junta lo
 * que integraron sus subtareas (ADR-0022), con sus commits y los de integración.
 */
export async function readRefChanges(
  root: string,
  baseSha: string,
  branch: string,
): Promise<ChangeRecord | null> {
  const head = await git(
    root,
    ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}^{commit}`],
    {},
  )
  if (head.code !== 0) return null
  const log = await git(
    root,
    [
      "log",
      "--reverse",
      "--format=%x1e%H%x1f%s%x1f%an%x1f%cI",
      "--numstat",
      `${baseSha}..${head.out}`,
    ],
    {},
  )
  const commits = log.out
    .split("\x1e")
    .map((x) => x.trim())
    .filter(Boolean)
    .map((block) => {
      const [first = "", ...rest] = block.split("\n")
      const [sha = "", subject = "", author = "", date = ""] = first.split("\x1f")
      return { sha, subject, author, date, files: numstat(rest.filter(Boolean)) }
    })
  const diff = await git(root, ["diff", "--no-color", baseSha, head.out], {})
  const stats = numstat(
    (await git(root, ["diff", "--numstat", baseSha, head.out], {})).out.split("\n"),
  )
  return {
    branch,
    base_sha: baseSha,
    head_sha: head.out,
    commits,
    files: stats,
    diff: diff.out ? `${diff.out}\n` : "",
  }
}

/** «3 commits · +40 −2 en 5 archivos». */
export function changesSummary(r: { commits: unknown[]; files: FileStat[] }): string {
  const add = r.files.reduce((s, f) => s + f.additions, 0)
  const del = r.files.reduce((s, f) => s + f.deletions, 0)
  const c = r.commits.length
  return `${c} commit${c === 1 ? "" : "s"} · +${add} −${del} en ${r.files.length} archivo${r.files.length === 1 ? "" : "s"}`
}
