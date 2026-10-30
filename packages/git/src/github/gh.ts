/**
 * El `gh` del humano, con errores tipados (ADR-0043 §1). Nunca pasa por un shell, nunca
 * pide el token (`--show-token`) y nunca lee el almacén de `gh`: `gh` usa su sesión y
 * Keel sólo ve lo que devuelve. Sólo APIs de Node (ADR-0007 §4).
 */
import { execFile } from "node:child_process"
import type { z } from "zod"

export type GhErrorKind =
  /** No hay `gh` en el PATH (o en la ruta dada). */
  | "missing"
  /** `gh` no tiene sesión para el host. */
  | "unauthenticated"
  | "not_found"
  /** GitHub rechazó la operación: la cabeza cambió, hay conflictos, falta review… */
  | "rejected"
  | "failed"

export class GhError extends Error {
  readonly kind: GhErrorKind
  readonly args: readonly string[]
  readonly stderr: string
  constructor(kind: GhErrorKind, message: string, args: readonly string[] = [], stderr = "") {
    super(message)
    this.name = "GhError"
    this.kind = kind
    this.args = args
    this.stderr = stderr
  }
}

export type GhOptions = {
  /** El repo local: `gh` deduce el repo de GitHub de su remoto. */
  cwd: string
  /** Ruta de `gh`; por defecto, el del PATH. */
  gh?: string
  timeoutMs?: number
}

const QUIET_ENV = {
  GH_PROMPT_DISABLED: "1",
  GH_NO_UPDATE_NOTIFIER: "1",
  GH_PAGER: "",
  NO_COLOR: "1",
  CLICOLOR: "0",
}

function classify(stderr: string): GhErrorKind {
  if (/gh auth login|not logged in|authentication required|HTTP 401/i.test(stderr))
    return "unauthenticated"
  if (/HTTP 404|could not resolve|no pull requests found|not found/i.test(stderr))
    return "not_found"
  if (
    /not mergeable|head branch was modified|merge conflict|review is required|HTTP 405|HTTP 409|HTTP 422/i.test(
      stderr,
    )
  )
    return "rejected"
  return "failed"
}

/** Corre `gh <args>` y devuelve su salida estándar. */
export function gh(args: readonly string[], opts: GhOptions): Promise<string> {
  const bin = opts.gh ?? "gh"
  return new Promise((resolve, reject) => {
    execFile(
      bin,
      [...args],
      {
        cwd: opts.cwd,
        env: { ...process.env, ...QUIET_ENV },
        maxBuffer: 32 * 1024 * 1024,
        timeout: opts.timeoutMs ?? 60_000,
        windowsHide: true,
      },
      (err, stdout, stderr) => {
        if (!err) return resolve(String(stdout))
        const e = err as NodeJS.ErrnoException & { code?: string | number }
        if (e.code === "ENOENT")
          return reject(new GhError("missing", `no encontré gh (${bin})`, args))
        const msg = String(stderr).trim() || e.message
        reject(new GhError(classify(msg), msg.split("\n").slice(-3).join(" "), args, msg))
      },
    )
  })
}

/** `gh … --json`, validado: lo que cruza el proceso pasa por su esquema. */
export async function ghJson<S extends z.ZodType>(
  schema: S,
  args: readonly string[],
  opts: GhOptions,
): Promise<z.infer<S>> {
  const out = await gh(args, opts)
  try {
    return schema.parse(JSON.parse(out))
  } catch (e) {
    throw new GhError("failed", `gh devolvió algo inesperado: ${(e as Error).message}`, args)
  }
}
