/**
 * La shell del agente no ve la puerta humana (ADR-0018 §3), en Linux y WSL2
 * con bubblewrap. La raíz queda de solo lectura; el worktree, el estado propio
 * del proveedor y lo que el agente necesita escribir se montan con escritura;
 * la carpeta del socket humano y el estado de Keel se tapan con un `tmpfs`, y
 * encima se montan sólo la puerta de agentes y la carpeta del token del run.
 *
 * ADR-0025 §10: también se tapan `$XDG_RUNTIME_DIR` (el bus de D-Bus y con él el
 * llavero), `~/.ssh` y el ssh-agent del humano (docs/reviews/2026-10-26-spike-vault-broker.md).
 *
 * Medido (docs/reviews/2026-10-23-sandbox-socket-humano.md): una raíz de solo
 * lectura no impide `connect()` al socket; taparlo sí. La red no se corta: el
 * proveedor la necesita para hablar con su API, y bubblewrap no filtra por
 * destino (docs/reviews/2026-10-23-sandbox-agente.md).
 */

import { existsSync } from "node:fs"

export type SandboxSpec = {
  /** Con escritura: worktree, `.git` común del repo, estado del proveedor. */
  writable: string[]
  /** Tapados con `tmpfs`: carpeta del socket humano, estado de Keel. */
  hidden: string[]
  /** Montados encima de lo tapado: puerta de agentes y carpeta del token. */
  reopened: string[]
  /**
   * ADR-0025 §10: variables que la shell del agente no hereda (el ssh-agent y el bus
   * de D-Bus del humano); sus rutas además están tapadas.
   */
  unsetenv?: string[]
}

/** `bwrap` del sistema, o null si no hay (otra plataforma o sin instalar). */
export function bwrapPath(platform: NodeJS.Platform = process.platform): string | null {
  if (platform !== "linux") return null
  return Bun.which("bwrap")
}

/**
 * Argumentos de bubblewrap; el orden importa: primero se tapa, después se reabre.
 * Lo que no existe al lanzar (p. ej., el token de un run sin puente) no se monta.
 */
export function bwrapArgs(
  spec: SandboxSpec,
  exists: (p: string) => boolean = existsSync,
): string[] {
  const bind = (p: string) => (exists(p) ? ["--bind", p, p] : [])
  return [
    "--ro-bind",
    "/",
    "/",
    "--dev",
    "/dev",
    "--proc",
    "/proc",
    "--tmpfs",
    "/tmp",
    ...spec.hidden.flatMap((p) => ["--tmpfs", p]),
    ...spec.writable.flatMap(bind),
    ...spec.reopened.flatMap(bind),
    ...(spec.unsetenv ?? []).flatMap((v) => ["--unsetenv", v]),
    // El agente no ve los procesos de fuera (ni `/proc/<daemon>/root`) y muere con su padre.
    "--unshare-pid",
    "--die-with-parent",
    "--",
  ]
}

/** El mismo comando, dentro del sandbox. */
export function wrapCommand(
  bwrap: string,
  spec: SandboxSpec,
  command: string,
  args: string[],
): { command: string; args: string[] } {
  return { command: bwrap, args: [...bwrapArgs(spec), command, ...args] }
}
