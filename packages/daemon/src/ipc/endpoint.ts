/**
 * Dónde escucha el daemon (ADR-0005 §1): socket Unix en POSIX y WSL2, Named
 * Pipe en Windows nativo. Bun usa la misma API (`Bun.listen({ unix })`) para
 * los dos; un Named Pipe no es un archivo y no lleva mkdir, chmod ni unlink.
 *
 * Probado en Windows nativo con Bun 1.3.11 (`scripts/probe-windows-pipe.ts`).
 * Pendiente: ADR-0005 pide el pipe con la ACL del usuario; Bun no expone el
 * descriptor de seguridad y el DACL por defecto no está verificado. Ver
 * docs/benchmarks/README.md.
 */
import { homedir, userInfo } from "node:os"
import { join } from "node:path"

const PIPE_PREFIX = "\\\\.\\pipe\\"

export function isNamedPipe(path: string): boolean {
  return path.startsWith(PIPE_PREFIX)
}

export type EndpointEnv = {
  platform?: NodeJS.Platform
  env?: Record<string, string | undefined>
  home?: string
  user?: string
}

/** Ruta por defecto del endpoint del daemon para esta plataforma. */
export function defaultEndpoint(e: EndpointEnv = {}): string {
  const platform = e.platform ?? process.platform
  const env = e.env ?? process.env
  if (platform === "win32") {
    const user = (e.user ?? userInfo().username).replace(/[^A-Za-z0-9._-]/g, "_")
    return `${PIPE_PREFIX}keel-daemon-${user}`
  }
  const base = env.XDG_RUNTIME_DIR
    ? join(env.XDG_RUNTIME_DIR, "keel")
    : join(e.home ?? homedir(), ".keel")
  return join(base, "keel.sock")
}
