/**
 * La shell del agente no ve la puerta humana (ADR-0018 §3), en Linux y WSL2
 * con bubblewrap. La raíz queda de solo lectura; el worktree, el estado propio
 * del proveedor y lo que el agente necesita escribir se montan con escritura;
 * la carpeta del socket humano y el estado de Keel se tapan con un `tmpfs`, y
 * encima se montan sólo la puerta de agentes y la carpeta del token del run.
 *
 * Medido (docs/reviews/2026-10-23-sandbox-socket-humano.md): una raíz de solo
 * lectura no impide `connect()` al socket; taparlo sí. La red no se corta: el
 * proveedor la necesita para hablar con su API, y bubblewrap no filtra por
 * destino (docs/reviews/2026-10-23-sandbox-agente.md).
 */
import { existsSync } from "node:fs"
/** `bwrap` del sistema, o null si no hay (otra plataforma o sin instalar). */
export function bwrapPath(platform = process.platform) {
  if (platform !== "linux") return null
  return Bun.which("bwrap")
}
/**
 * Argumentos de bubblewrap; el orden importa: primero se tapa, después se reabre.
 * Lo que no existe al lanzar (p. ej., el token de un run sin puente) no se monta.
 */
export function bwrapArgs(spec, exists = existsSync) {
  const bind = (p) => (exists(p) ? ["--bind", p, p] : [])
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
    // El agente no ve los procesos de fuera (ni `/proc/<daemon>/root`) y muere con su padre.
    "--unshare-pid",
    "--die-with-parent",
    "--",
  ]
}
/** El mismo comando, dentro del sandbox. */
export function wrapCommand(bwrap, spec, command, args) {
  return { command: bwrap, args: [...bwrapArgs(spec), command, ...args] }
}
//# sourceMappingURL=sandbox.js.map
