/**
 * Ejecución de `git` con errores tipados. Sólo APIs de Node (ADR-0007 §4).
 *
 * Nunca pasa por un shell: los argumentos van tal cual a `execFile`. El
 * entorno fija `LC_ALL=C` para que los mensajes que se clasifican (locks, repo
 * inexistente) no dependan del idioma del usuario.
 */
import { execFile } from "node:child_process"

export type GitErrorKind =
  /** Otro proceso tiene un lock (`index.lock`, `<ref>.lock`); se agotaron los reintentos. */
  | "locked"
  | "not_a_repository"
  /** La operación chocaría con algo existente: worktree, rama o ref ya presentes. */
  | "conflict"
  | "invalid_argument"
  | "failed"

export class GitError extends Error {
  readonly kind: GitErrorKind
  readonly args: readonly string[]
  readonly stderr: string
  readonly exitCode: number | null
  constructor(
    kind: GitErrorKind,
    message: string,
    detail: { args?: readonly string[]; stderr?: string; exitCode?: number | null } = {},
  ) {
    super(message)
    this.name = "GitError"
    this.kind = kind
    this.args = detail.args ?? []
    this.stderr = detail.stderr ?? ""
    this.exitCode = detail.exitCode ?? null
  }
}

export type GitResult = { stdout: string; stderr: string }

export type GitExecOptions = {
  cwd: string
  env?: Record<string, string | undefined>
  /** Máximo de bytes de salida; por defecto 64 MiB. */
  maxBuffer?: number
}

/** Corre `git <args>` en `cwd`. Rechaza con `GitError` clasificado. */
export function git(args: readonly string[], opts: GitExecOptions): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      [...args],
      {
        cwd: opts.cwd,
        env: { ...process.env, ...opts.env, LC_ALL: "C", GIT_TERMINAL_PROMPT: "0" },
        maxBuffer: opts.maxBuffer ?? 64 * 1024 * 1024,
        encoding: "utf8",
      },
      (err, stdout, stderr) => {
        if (!err) return resolve({ stdout, stderr })
        const code = typeof err.code === "number" ? err.code : null
        reject(
          new GitError(classify(stderr), `git ${args[0] ?? ""} falló: ${firstLine(stderr)}`, {
            args,
            stderr,
            exitCode: code,
          }),
        )
      },
    )
  })
}

function classify(stderr: string): GitErrorKind {
  // Un lock ajeno siempre trae «Unable to create '….lock': File exists».
  if (/Unable to create '[^']*\.lock': File exists/i.test(stderr)) return "locked"
  if (/not a git repository/i.test(stderr)) return "not_a_repository"
  // «cannot lock ref» sin el archivo de lock es un compare-and-set fallido, no un lock.
  if (
    /already exists|is already (checked out|used by worktree)|but expected|cannot lock ref/i.test(
      stderr,
    )
  )
    return "conflict"
  return "failed"
}

function firstLine(s: string): string {
  return s.trim().split("\n")[0] ?? ""
}

export type RetryPolicy = { attempts: number; baseDelayMs: number; maxDelayMs: number }

export const DEFAULT_RETRY: RetryPolicy = { attempts: 6, baseDelayMs: 25, maxDelayMs: 400 }

/**
 * Reintenta `fn` mientras falle con `locked`, con backoff exponencial acotado.
 * Nunca borra el archivo de lock: es de otro proceso (o del humano).
 */
export async function retryOnLock<T>(
  fn: () => Promise<T>,
  policy: RetryPolicy = DEFAULT_RETRY,
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn()
    } catch (e) {
      if (!(e instanceof GitError) || e.kind !== "locked" || attempt >= policy.attempts) throw e
      const delay = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** (attempt - 1))
      await new Promise((r) => setTimeout(r, delay))
    }
  }
}
