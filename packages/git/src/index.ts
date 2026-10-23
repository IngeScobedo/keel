/**
 * @keel/git — worktrees aislados por run, captura y rescate de cambios y
 * reconciliación tras un crash, con el estado guardado en el propio
 * repositorio (ADR-0007 §5).
 *
 * Contrato: librería sin decisiones de producto. No abre el store de Keel ni
 * emite sus eventos; quien la usa persiste lo que devuelve. Sólo APIs de Node.
 */

export * from "./exec.js"
export * from "./lock.js"
export * from "./status.js"
export * from "./worktrees.js"
