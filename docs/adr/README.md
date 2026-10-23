# Architecture Decision Records de Keel

Formato: contexto → decisión → consecuencias → alternativas. **Un ADR aceptado
no se edita: se supersede** con uno nuevo que declare a cuál reemplaza. Los ADRs
mandan sobre el SDD, el README y cualquier comentario de código.

Keel arranca su propia serie. Los ADRs de Mirador están en
`../inherited/mirador/adr/` tal cual se escribieron y **no se editan aquí**:
ADR-0001 de Keel dice cuáles se adoptan como regla y cuáles no aplican.

| #                                                           | Título                                                                                                               | Estado                            | Criticidad |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | --------------------------------- | ---------- |
| [0001](./0001-keel-producto-nuevo-y-herencia-de-mirador.md) | Keel es producto nuevo; qué hereda de Mirador y qué no                                                               | Propuesto                         | **Máxima** |
| [0002](./0002-proveedores-autenticacion-y-costo.md)         | Proveedores vía SDK oficial, cero manejo de credenciales, costo etiquetado                                           | Propuesto                         | **Máxima** |
| [0003](./0003-runtime-del-daemon-typescript-primero.md)     | Runtime del daemon: TypeScript sobre Bun primero, Rust diferido tras el spike                                        | Propuesto (condicionado al spike) | Alta       |
| [0004](./0004-store-sqlite-wal.md)                          | Store: SQLite WAL local, envelope de Mirador conservado                                                              | Propuesto                         | Alta       |
| [0005](./0005-ipc-json-rpc-ndjson-sobre-socket-local.md)    | IPC: JSON-RPC 2.0 en NDJSON sobre socket Unix / Named Pipe; los clientes nunca escriben la base                      | Propuesto                         | Alta       |
| [0006](./0006-vocabulario-de-estados.md)                    | Vocabulario de estados: tres niveles (tarea, run, nodo de ejecución) y proyección a tablero                          | Propuesto (decisiones tomadas)    | **Máxima** |
| [0007](./0007-keel-como-kit-librerias-reutilizables.md)     | Keel como kit: librerías reutilizables y el daemon como composición                                                  | Propuesto                         | Alta       |
| [0008](./0008-adaptador-codex.md)                           | Adaptador de Codex: transportes SDK y App Server, suscripción local con opción explícita, aprobaciones por capacidad | Propuesto                         | Alta       |
| [0009](./0009-tools-mcp-y-actor-agente.md)                  | Acceso de agentes a Keel por MCP e identidad de ejecución                                                            | Propuesto                         | **Máxima** |
| [0010](./0010-workspace-driver-y-modo-sin-vcs.md)           | `WorkspaceDriver` y modo sin VCS                                                                                     | Aceptado (2026-10-22)             | Alta       |

## Estado «Propuesto»

Todos los ADRs de esta serie están en **Propuesto**; 0006 tiene sus tres
decisiones tomadas por el humano (2026-10-09) y aplicadas, y aun así el cambio
de estado es suyo. Los escribió Claude a petición del humano el 2026-10-08 a
partir del SDD, los ADRs de Mirador, el canvas de pen.dev y los docs oficiales
de Anthropic verificados ese día. Pasan a **Aceptado** cuando el humano los lea,
corrija y cambie el estado; hasta entonces el código que dependa de uno se
escribe como si fuera a aceptarse, y se reescribe si no.

## Orden de lectura

0001 → 0002 → 0006 → 0004 → 0005 → 0003 → 0007 → 0009 → 0008 → 0010. Los dos
primeros son el porqué; 0006 es lo que bloquea el primer componente de UI; 0004,
0005 y 0003 son consecuencias; 0007 reparte el código en librerías reutilizables
y producto.

## Decisiones abiertas (no decididas a propósito)

- **Codex y suscripción de ChatGPT.** Mismo análisis que ADR-0002 para OpenAI.
  El uso local con la propia cuenta va detrás de una opción explícita;
  distribuir Keel con ese modo espera a verificar los términos (ADR-0008 §2).
- **Qué pasa con `collector`, `web` y `hook-bridge` de Mirador.** Quedan en su
  repo como archivo. Si Keel necesita un adaptador de hooks del CLI, se
  reescribe contra ADR-0005.
- **Rust.** ADR-0003 lo difiere, no lo rechaza. Se reabre con la evidencia del
  spike.
- **Distribución del binario.** Compilar con `bun build --compile` o empaquetar
  con Tauri; se decide cuando exista algo que distribuir.
