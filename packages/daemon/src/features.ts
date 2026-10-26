/**
 * La rama de una feature y la integración de sus subtareas (ADR-0022 §2), con git y
 * sin checkout: la rama de la feature no está abierta en ningún worktree mientras
 * trabajan las hijas, así que se mueve con `update-ref` (compare-and-set) y, si hace
 * falta un merge, con `merge-tree --write-tree` y `commit-tree`.
 */
import { git } from "@keel/git"

/** `Capítulos en el detalle` → `capitulos-en-el-detalle`, como mucho 40 caracteres. */
export function slug(title: string): string {
  return title
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "")
}

/** `feat/KEEL-12-capitulos`, con el prefijo del perfil del proyecto. */
export function featureBranchName(prefix: string, displayId: string, title: string): string {
  const s = slug(title)
  return `${prefix}${displayId}${s ? `-${s}` : ""}`
}

async function revParse(root: string, ref: string): Promise<string | null> {
  try {
    return (await git(["rev-parse", "--verify", `${ref}^{commit}`], { cwd: root })).stdout.trim()
  } catch {
    return null
  }
}

/**
 * Crea la rama de la feature desde `base` (la rama principal del proyecto). Si ya
 * existe y apunta a un ancestro de la base o a la base, se reutiliza: así un reintento
 * no falla.
 */
export async function createFeatureBranch(
  root: string,
  name: string,
  base: string,
): Promise<{ sha: string; created: boolean }> {
  const baseSha = await revParse(root, base)
  if (!baseSha) throw new Error(`la base ${base} no existe en el repo`)
  const existing = await revParse(root, `refs/heads/${name}`)
  if (existing) return { sha: existing, created: false }
  await git(["update-ref", `refs/heads/${name}`, baseSha, ""], { cwd: root })
  return { sha: baseSha, created: true }
}

async function isAncestor(root: string, a: string, b: string): Promise<boolean> {
  const p = Bun.spawn(["git", "merge-base", "--is-ancestor", a, b], {
    cwd: root,
    stdout: "ignore",
    stderr: "ignore",
  })
  return (await p.exited) === 0
}

export type Integration =
  | { ok: true; sha: string; mode: "fast_forward" | "merge" | "already" }
  | { ok: false; conflicts: string[]; message: string }

/**
 * Lleva `from` (la rama o el commit de la subtarea) a la rama de la feature. Avanza
 * sin merge si se puede; si no, hace el merge sin tocar ningún árbol de trabajo. Un
 * conflicto no cambia nada y devuelve los archivos.
 */
export async function integrateInto(
  root: string,
  feature: string,
  from: string,
  o: { message: string; env?: Record<string, string> },
): Promise<Integration> {
  const featSha = await revParse(root, `refs/heads/${feature}`)
  if (!featSha) return { ok: false, conflicts: [], message: `la rama ${feature} no existe` }
  const fromSha = await revParse(root, from)
  if (!fromSha) return { ok: false, conflicts: [], message: `${from} no existe` }
  if (await isAncestor(root, fromSha, featSha)) return { ok: true, sha: featSha, mode: "already" }
  if (await isAncestor(root, featSha, fromSha)) {
    await git(["update-ref", `refs/heads/${feature}`, fromSha, featSha], { cwd: root })
    return { ok: true, sha: fromSha, mode: "fast_forward" }
  }
  const mt = Bun.spawn(
    ["git", "merge-tree", "--write-tree", "--name-only", "--no-messages", featSha, fromSha],
    { cwd: root, stdout: "pipe", stderr: "pipe", env: { ...process.env, LC_ALL: "C" } },
  )
  const [out, err] = await Promise.all([
    new Response(mt.stdout).text(),
    new Response(mt.stderr).text(),
  ])
  const code = await mt.exited
  const lines = out.trim().split("\n")
  if (code === 1)
    return {
      ok: false,
      conflicts: lines.slice(1).filter(Boolean),
      message: "la subtarea choca con lo que ya está en la feature",
    }
  if (code !== 0)
    return { ok: false, conflicts: [], message: `git merge-tree falló: ${err.trim()}` }
  const tree = lines[0] as string
  const commit = (
    await git(["commit-tree", tree, "-p", featSha, "-p", fromSha, "-m", o.message], {
      cwd: root,
      ...(o.env ? { env: o.env } : {}),
    })
  ).stdout.trim()
  await git(["update-ref", `refs/heads/${feature}`, commit, featSha], { cwd: root })
  return { ok: true, sha: commit, mode: "merge" }
}
