/**
 * ADR-0021 §4: «al entrar a `implement`, Keel captura el baseline». Una subtarea nace
 * ya en implement y un padre de feature revisa cuando sus hijas ya integraron: tomar el
 * baseline en su worktree lo mide con el cambio puesto, y el rojo del cambio pasa por
 * deuda (KEEL-13, 2026-11-02). El baseline se mide en el commit base, en un worktree
 * aparte que se borra al terminar; si el worktree de la tarea sigue en ese commit y
 * limpio, se mide ahí mismo.
 */
import { randomBytes } from "node:crypto"
import { rmSync } from "node:fs"
import { join } from "node:path"
import { git } from "./base-sync.js"

/** El worktree está en `sha` y sin cambios: medir ahí es medir el base. */
export async function pristineAt(cwd: string, sha: string): Promise<boolean> {
  const head = await git(cwd, ["rev-parse", "HEAD"], {})
  if (head.code !== 0 || head.out !== sha) return false
  const st = await git(cwd, ["status", "--porcelain"], {})
  return st.code === 0 && st.out === ""
}

export async function headOf(cwd: string): Promise<string | null> {
  const r = await git(cwd, ["rev-parse", "HEAD"], {})
  return r.code === 0 ? r.out : null
}

/**
 * Corre `fn` en un worktree desacoplado en `sha`, bajo `dir` (dentro de los worktrees de
 * Keel, para que el `setup` del perfil lo prepare), y lo quita al terminar.
 */
export async function atCommit<T>(
  repo: string,
  sha: string,
  dir: string,
  fn: (cwd: string) => Promise<T>,
): Promise<T> {
  const cwd = join(dir, `${sha.slice(0, 12)}-${randomBytes(4).toString("hex")}`)
  const add = await git(repo, ["worktree", "add", "--detach", cwd, sha], {}, 120_000)
  if (add.code !== 0) throw new Error(`git worktree add: ${add.err || add.out}`)
  try {
    return await fn(cwd)
  } finally {
    // `--force`: las dependencias instaladas no están en git.
    const rm = await git(repo, ["worktree", "remove", "--force", cwd], {}, 120_000)
    if (rm.code !== 0) {
      rmSync(cwd, { recursive: true, force: true })
      await git(repo, ["worktree", "prune"], {})
    }
  }
}
