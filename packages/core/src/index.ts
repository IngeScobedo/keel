/**
 * @keel/core — superficie publica del dominio (correlacion heredada de Mirador, ADR-0001).
 *
 * Contrato: cero I/O y runtime-agnostico. Sin `Bun`, sin `node:*`, sin globals
 * de navegador. Lo impone el compilador via `"types": []` en tsconfig.json.
 */

export * from "./correlation.js"
export * from "./envelope.js"
export * from "./lifecycle.js"
export * from "./protocol.js"
export * from "./schemas.js"
export * from "./ulid.js"
export * from "./visual-state.js"
