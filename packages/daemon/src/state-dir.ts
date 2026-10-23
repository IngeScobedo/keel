import { homedir } from "node:os"
import { join } from "node:path"

/**
 * Directorio de estado privado de Keel: `$XDG_STATE_HOME/keel` (por defecto
 * `~/.local/state/keel`), o `%LOCALAPPDATA%\keel` en Windows. Ahí viven los
 * worktrees, los snapshots y los tokens de los runs.
 */
export function defaultStateDir(
  platform: NodeJS.Platform = process.platform,
  env: Record<string, string | undefined> = process.env,
): string {
  if (platform === "win32")
    return join(env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "keel")
  return join(env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "keel")
}
