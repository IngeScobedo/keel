/**
 * Estado del árbol de trabajo para mostrarlo: rama, `HEAD`, upstream, adelanto
 * o atraso y archivos cambiados. Sólo lee (`git status --porcelain=v2`).
 */
import { git } from "./exec.js"

export type RepoStatus = {
  /** null con `HEAD` separado. */
  branch: string | null
  /** null en un repo sin commits. */
  head: string | null
  upstream: string | null
  ahead: number
  behind: number
  /** Archivos con cambios, preparados o no, incluidos los sin seguimiento. */
  changed: number
  untracked: number
}

export async function repoStatus(path: string): Promise<RepoStatus> {
  const { stdout } = await git(["status", "--porcelain=v2", "--branch", "-z"], { cwd: path })
  const out: RepoStatus = {
    branch: null,
    head: null,
    upstream: null,
    ahead: 0,
    behind: 0,
    changed: 0,
    untracked: 0,
  }
  const records = stdout.split("\0")
  for (let i = 0; i < records.length; i++) {
    const r = records[i] as string
    if (r.startsWith("# branch.oid ")) {
      const oid = r.slice(13)
      out.head = oid === "(initial)" ? null : oid
    } else if (r.startsWith("# branch.head ")) {
      const head = r.slice(14)
      out.branch = head === "(detached)" ? null : head
    } else if (r.startsWith("# branch.upstream ")) out.upstream = r.slice(18)
    else if (r.startsWith("# branch.ab ")) {
      const m = /^\+(\d+) -(\d+)$/.exec(r.slice(12))
      if (m) {
        out.ahead = Number(m[1])
        out.behind = Number(m[2])
      }
    } else if (r.startsWith("? ")) {
      out.changed++
      out.untracked++
    } else if (r.startsWith("1 ") || r.startsWith("u ")) out.changed++
    else if (r.startsWith("2 ")) {
      out.changed++
      i++ // un renombrado trae la ruta original en el registro siguiente
    }
  }
  return out
}
