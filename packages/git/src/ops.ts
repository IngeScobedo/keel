/**
 * Operaciones de git para planes aprobados (ADR-0015): qué cambió, cuánto,
 * con qué hash de contenido, y el commit y el push que ejecuta quien aprueba.
 * Librería sin decisiones de producto: no sabe de aprobaciones ni de ramas
 * protegidas; nunca fuerza un push.
 */
import { createHash } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { git } from "./exec.js"

export type PlanFile = {
  path: string
  /** `M` modificado, `A` nuevo (también sin seguimiento), `D` borrado, `R` renombrado. */
  status: "M" | "A" | "D" | "R"
}

/** Archivos con cambios respecto de HEAD, incluidos los nuevos sin seguimiento. */
export async function changedFiles(path: string): Promise<PlanFile[]> {
  const { stdout } = await git(["status", "--porcelain=v2", "-z", "--untracked-files=all"], {
    cwd: path,
  })
  const out: PlanFile[] = []
  const recs = stdout.split("\0")
  for (let i = 0; i < recs.length; i++) {
    const r = recs[i] as string
    if (r.startsWith("? ")) out.push({ path: r.slice(2), status: "A" })
    else if (r.startsWith("1 ")) {
      const xy = r.split(" ")[1] as string
      const p = r.split(" ").slice(8).join(" ")
      out.push({ path: p, status: xy.includes("D") ? "D" : xy.includes("A") ? "A" : "M" })
    } else if (r.startsWith("2 ")) {
      out.push({ path: r.split(" ").slice(9).join(" "), status: "R" })
      i++ // ruta original
    }
  }
  // Orden por código, el mismo que `commitPaths`: la tarjeta y el commit coinciden.
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}

/**
 * Hash del contenido que se va a confirmar: cada ruta con el hash de su blob
 * en el árbol de trabajo (o `deleted`). Si un archivo cambia, el hash cambia.
 */
export async function contentHash(path: string, files: string[]): Promise<string> {
  const h = createHash("sha256")
  for (const f of [...files].sort()) {
    let blob = "deleted"
    try {
      blob = createHash("sha1")
        .update(readFileSync(join(path, f)))
        .digest("hex")
    } catch {
      // Borrado: queda como `deleted`.
    }
    h.update(`${f}\0${blob}\n`)
  }
  return h.digest("hex")
}

export async function headSha(path: string): Promise<string | null> {
  try {
    return (await git(["rev-parse", "HEAD"], { cwd: path })).stdout.trim()
  } catch {
    return null
  }
}

export async function currentBranch(path: string): Promise<string | null> {
  const b = (await git(["rev-parse", "--abbrev-ref", "HEAD"], { cwd: path })).stdout.trim()
  return b === "HEAD" ? null : b
}

/** Líneas añadidas y quitadas por archivo, contando los nuevos sin seguimiento. */
export async function numstat(
  path: string,
  files: PlanFile[],
): Promise<{ path: string; status: PlanFile["status"]; additions: number; deletions: number }[]> {
  const tracked = files.filter((f) => f.status !== "A").map((f) => f.path)
  const stats = new Map<string, { additions: number; deletions: number }>()
  if (tracked.length) {
    const { stdout } = await git(["diff", "HEAD", "--numstat", "-z", "--", ...tracked], {
      cwd: path,
    })
    for (const rec of stdout.split("\0")) {
      const m = /^(\d+|-)\t(\d+|-)\t(.*)$/.exec(rec)
      if (m)
        stats.set(m[3] as string, {
          additions: m[1] === "-" ? 0 : Number(m[1]),
          deletions: m[2] === "-" ? 0 : Number(m[2]),
        })
    }
  }
  return files.map((f) => {
    if (f.status === "A") {
      let lines = 0
      try {
        const text = readFileSync(join(path, f.path), "utf8")
        lines = text === "" ? 0 : text.split("\n").length - (text.endsWith("\n") ? 1 : 0)
      } catch {
        // Ilegible: 0.
      }
      return { ...f, additions: lines, deletions: 0 }
    }
    return { ...f, ...(stats.get(f.path) ?? { additions: 0, deletions: 0 }) }
  })
}

/** Diff unificado de esos archivos respecto de HEAD (los nuevos, contra vacío). */
export async function unifiedDiff(path: string, files: PlanFile[]): Promise<string> {
  const parts: string[] = []
  const tracked = files.filter((f) => f.status !== "A").map((f) => f.path)
  if (tracked.length)
    parts.push((await git(["diff", "HEAD", "--", ...tracked], { cwd: path })).stdout)
  for (const f of files.filter((x) => x.status === "A"))
    parts.push(
      (
        await git(["diff", "--no-index", "--", "/dev/null", f.path], { cwd: path }).catch(
          (e: { stdout?: string }) => ({ stdout: e.stdout ?? "" }),
        )
      ).stdout,
    )
  return parts.join("")
}

/**
 * Confirma exactamente esas rutas con ese mensaje. El autor sale del entorno
 * (`GIT_AUTHOR_*`): quien llama decide a nombre de quién.
 */
export async function commitPaths(
  path: string,
  opts: { message: string; files: string[]; env?: Record<string, string> },
): Promise<{ sha: string; files: string[] }> {
  const env = { ...process.env, ...opts.env }
  // Una ruta borrada cuyo borrado ya está en el índice (`git rm`) no casa con `git add`
  // («pathspec did not match»): las borradas se pasan con `git rm --cached`, que no falla.
  const gone = opts.files.filter((f) => !existsSync(join(path, f)))
  const present = opts.files.filter((f) => existsSync(join(path, f)))
  if (gone.length)
    await git(["rm", "-q", "--cached", "--ignore-unmatch", "--", ...gone], { cwd: path, env })
  if (present.length) await git(["add", "-A", "--", ...present], { cwd: path, env })
  await git(["commit", "-q", "-m", opts.message, "--", ...opts.files], { cwd: path, env })
  const sha = (await headSha(path)) as string
  const { stdout } = await git(["show", "--name-only", "--format=", sha], { cwd: path })
  return { sha, files: stdout.split("\n").filter(Boolean).sort() }
}

/**
 * Empuja la rama local `from` (por omisión, la misma) a `branch` del remoto. Nunca con
 * `--force`. El plan puede nombrar la rama de destino (`fix/…`) aunque el worktree esté
 * en `keel/<tarea>/…`.
 */
export async function pushBranch(
  path: string,
  opts: { remote: string; branch: string; from?: string },
): Promise<{ old_sha: string | null; new_sha: string }> {
  const ls = await git(["ls-remote", opts.remote, `refs/heads/${opts.branch}`], { cwd: path })
  const old = ls.stdout.trim().split(/\s+/)[0] || null
  await git(
    ["push", opts.remote, `refs/heads/${opts.from ?? opts.branch}:refs/heads/${opts.branch}`],
    {
      cwd: path,
    },
  )
  return { old_sha: old, new_sha: (await headSha(path)) as string }
}
