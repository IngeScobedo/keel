/**
 * Dónde escucha el daemon (ADR-0005 §1): socket Unix en POSIX y WSL2, y socket
 * AF_UNIX en `%LOCALAPPDATA%\keel\keel.sock` en Windows. En Windows la ACL la
 * hereda del perfil del usuario (SYSTEM, Administradores y el usuario, medido
 * el 2026-10-23). El Named Pipe que crea Bun daba lectura a Todos y a
 * ANONYMOUS LOGON y Bun no deja cambiarlo, por eso no se usa. Una ruta
 * `\\.\pipe\…` explícita se sigue aceptando, sin mkdir, chmod ni unlink.
 */
import { homedir } from "node:os"
import { join } from "node:path"

const PIPE_PREFIX = "\\\\.\\pipe\\"

export function isNamedPipe(path: string): boolean {
  return path.startsWith(PIPE_PREFIX)
}

export type EndpointEnv = {
  platform?: NodeJS.Platform
  env?: Record<string, string | undefined>
  home?: string
}

/** Ruta por defecto del endpoint del daemon para esta plataforma. */
export function defaultEndpoint(e: EndpointEnv = {}): string {
  const platform = e.platform ?? process.platform
  const env = e.env ?? process.env
  if (platform === "win32")
    return join(
      env.LOCALAPPDATA || join(e.home ?? homedir(), "AppData", "Local"),
      "keel",
      "keel.sock",
    )
  const base = env.XDG_RUNTIME_DIR
    ? join(env.XDG_RUNTIME_DIR, "keel")
    : join(e.home ?? homedir(), ".keel")
  return join(base, "keel.sock")
}

/**
 * La puerta de agentes junto a la humana (ADR-0018 §2): `keel.sock` →
 * `keel-agent.sock`; un Named Pipe explícito lleva el sufijo `-agent`.
 */
export function agentDoorPath(humanPath: string): string {
  if (isNamedPipe(humanPath)) return `${humanPath}-agent`
  return humanPath.endsWith(".sock") ? `${humanPath.slice(0, -5)}-agent.sock` : `${humanPath}-agent`
}
