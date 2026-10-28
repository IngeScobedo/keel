/**
 * La rama base al día antes de trabajar (ADR-0028): `git fetch` sin terminal y
 * `git pull --ff-only` en el checkout del humano, a pedido suyo. Keel nunca hace merge,
 * rebase ni reset, ni pull de otra rama que la actual.
 */

export type BaseState = {
  branch: string | null
  upstream: string | null
  ahead: number
  behind: number
  fetched: boolean
  error: string | null
}

async function git(
  root: string,
  args: string[],
  env: Record<string, string>,
  timeoutMs = 60_000,
): Promise<{ code: number; out: string; err: string }> {
  const p = Bun.spawn(["git", ...args], {
    cwd: root,
    env: { ...(process.env as Record<string, string>), LC_ALL: "C", ...env },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  const timer = setTimeout(() => p.kill(), timeoutMs)
  const [out, err] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
  ])
  const code = await p.exited
  clearTimeout(timer)
  return { code, out: out.trim(), err: err.trim() }
}

/** El mensaje útil de git: su última línea de error, sin ruido de progreso. */
function gitError(err: string, fallback: string): string {
  const lines = err
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !/^(remote: )?(Counting|Compressing|Receiving|Resolving)/.test(l))
  return lines.slice(-2).join(" · ") || fallback
}

async function counts(root: string): Promise<{ ahead: number; behind: number }> {
  const r = await git(root, ["rev-list", "--left-right", "--count", "HEAD...@{u}"], {})
  const [ahead, behind] = r.out.split(/\s+/).map(Number)
  return { ahead: ahead ?? 0, behind: behind ?? 0 }
}

/** Consulta el remoto de la rama actual y dice cuánto va atrás y adelante. */
export async function checkBase(root: string, env: Record<string, string>): Promise<BaseState> {
  const branch = (await git(root, ["rev-parse", "--abbrev-ref", "HEAD"], {})).out || null
  const up = await git(root, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], {})
  if (up.code !== 0 || !branch || branch === "HEAD")
    return {
      branch: branch === "HEAD" ? null : branch,
      upstream: null,
      ahead: 0,
      behind: 0,
      fetched: false,
      error:
        branch === "HEAD" ? "el checkout no está en una rama" : "la rama no sigue a ningún remoto",
    }
  const upstream = up.out
  const slash = upstream.indexOf("/")
  const remote = upstream.slice(0, slash)
  const remoteBranch = upstream.slice(slash + 1)
  const f = await git(root, ["fetch", "--quiet", remote, remoteBranch], env, 45_000)
  const c = await counts(root)
  return {
    branch,
    upstream,
    ...c,
    fetched: f.code === 0,
    error: f.code === 0 ? null : gitError(f.err, `git fetch terminó con ${f.code}`),
  }
}

/** Sólo avanza: `git pull --ff-only` de la rama actual. Si no puede, no toca nada. */
export async function pullBase(root: string, env: Record<string, string>): Promise<BaseState> {
  const p = await git(root, ["pull", "--ff-only", "--quiet"], env, 90_000)
  if (p.code !== 0) throw new Error(gitError(p.err, `git pull terminó con ${p.code}`))
  return checkBase(root, env)
}

/**
 * ADR-0031 §3: desde dónde se despliega. La base al día (con fetch, como ADR-0028), el
 * commit y los cambios sin commit en la carpeta del playbook; lo ignorado por git
 * (`vault.yml`, el inventario) no cuenta como cambio.
 */
export async function deployState(
  root: string,
  dir: string,
  env: Record<string, string>,
): Promise<{
  commit: string | null
  upstream: string | null
  behind: number
  dirty: string[]
  error: string | null
}> {
  const base = await checkBase(root, env)
  const head = await git(root, ["rev-parse", "HEAD"], {})
  const status = await git(root, ["status", "--porcelain", "--untracked-files=all", "--", dir], {})
  return {
    commit: head.code === 0 ? head.out : null,
    upstream: base.upstream,
    behind: base.behind,
    dirty: status.out
      .split(/\r?\n/)
      .map((l) => l.slice(3).trim())
      .filter(Boolean),
    error: base.error,
  }
}
