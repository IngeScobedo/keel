# Architecture Decision Records de Keel

Formato: contexto → decisión → consecuencias → alternativas. **Un ADR aceptado
no se edita: se supersede** con uno nuevo que declare a cuál reemplaza. Los ADRs
mandan sobre el SDD, el README y cualquier comentario de código.

Keel arranca su propia serie. Los ADRs de Mirador están en
`../inherited/mirador/adr/` tal cual se escribieron y **no se editan aquí**:
ADR-0001 de Keel dice cuáles se adoptan como regla y cuáles no aplican.

| #                                                               | Título                                                                                                               | Estado                 | Criticidad |
| --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ---------------------- | ---------- |
| [0001](./0001-keel-producto-nuevo-y-herencia-de-mirador.md)     | Keel es producto nuevo; qué hereda de Mirador y qué no                                                               | Aceptado (2026-10-23)  | **Máxima** |
| [0002](./0002-proveedores-autenticacion-y-costo.md)             | Proveedores vía SDK oficial, cero manejo de credenciales, costo etiquetado                                           | Aceptado (2026-10-23)  | **Máxima** |
| [0003](./0003-runtime-del-daemon-typescript-primero.md)         | Runtime del daemon: TypeScript sobre Bun primero, Rust diferido tras el spike                                        | Aceptado (2026-10-23)  | Alta       |
| [0004](./0004-store-sqlite-wal.md)                              | Store: SQLite WAL local, envelope de Mirador conservado                                                              | Aceptado (2026-10-23)  | Alta       |
| [0005](./0005-ipc-json-rpc-ndjson-sobre-socket-local.md)        | IPC: JSON-RPC 2.0 en NDJSON sobre socket Unix / Named Pipe; los clientes nunca escriben la base                      | Aceptado (2026-10-23)  | Alta       |
| [0006](./0006-vocabulario-de-estados.md)                        | Vocabulario de estados: tres niveles (tarea, run, nodo de ejecución) y proyección a tablero                          | Aceptado (2026-10-23)  | **Máxima** |
| [0007](./0007-keel-como-kit-librerias-reutilizables.md)         | Keel como kit: librerías reutilizables y el daemon como composición                                                  | Aceptado (2026-10-23)  | Alta       |
| [0008](./0008-adaptador-codex.md)                               | Adaptador de Codex: transportes SDK y App Server, suscripción local con opción explícita, aprobaciones por capacidad | Aceptado (2026-10-22)  | Alta       |
| [0009](./0009-tools-mcp-y-actor-agente.md)                      | Acceso de agentes a Keel por MCP e identidad de ejecución                                                            | Aceptado (2026-10-22)  | **Máxima** |
| [0010](./0010-workspace-driver-y-modo-sin-vcs.md)               | `WorkspaceDriver` y modo sin VCS                                                                                     | Aceptado (2026-10-22)  | Alta       |
| [0011](./0011-observabilidad-eventos-semanticos-y-cobertura.md) | Observabilidad: eventos de origen, eventos semánticos y cobertura declarada                                          | Aceptado (2026-10-23)  | Alta       |
| [0012](./0012-artefactos-evidencias-y-retencion.md)             | Artefactos direccionados por contenido, evidencias con procedencia y retención                                       | Aceptado (2026-10-23)  | Alta       |
| [0013](./0013-intermediario-de-recursos-y-secretos.md)          | Intermediario de recursos: secretos por referencia y permisos por operación                                          | Aceptado (2026-10-23)  | **Máxima** |
| [0014](./0014-integraciones-plugins-y-visualizadores.md)        | Integraciones en tres niveles, plugins fuera de proceso y visualizadores                                             | Aceptado (2026-10-23)  | Alta       |
| [0015](./0015-operaciones-git-con-plan-aprobado.md)             | Operaciones de git del agente con plan aprobado y verificado                                                         | Aceptado (2026-10-23)  | Alta       |
| [0016](./0016-investigaciones-y-reportes-con-evidencia.md)      | Investigaciones y reportes con evidencia                                                                             | Aceptado (2026-10-23)  | Alta       |
| [0017](./0017-contexto-para-agentes-y-busqueda.md)              | Contexto para agentes: tarea vinculada, recursos MCP y búsqueda                                                      | Aceptado (2026-10-23)  | Media      |
| [0018](./0018-identidad-del-agente-en-el-sistema.md)            | Identidad del agente fuera de las tools: dos puertas, shell aislada y atribución                                     | Aceptado (2026-10-23)  | **Máxima** |
| [0019](./0019-uso-interactivo-desde-la-gui.md)                  | Uso interactivo desde la GUI: daemon de usuario, proyectos, conversación y permisos                                  | Aceptado (2026-10-23)  | Alta       |
| [0020](./0020-chat-del-run-como-superficie-de-foco.md)          | El chat del run como superficie de foco: tarjetas por intención, aprobaciones por patrón y control en vivo           | Aceptado (2026-10-26)  | Alta       |
| [0021](./0021-keel-conduce-el-metodo.md)                        | Keel conduce el método: etapas con gates, documentos de la tarea y una conversación por tarea                        | Aceptado (2026-10-26)  | **Máxima** |
| [0022](./0022-tarea-padre-y-subtareas.md)                       | Tarea padre y subtareas: una feature es un árbol de tareas con su rama                                               | Aceptado (2026-10-26)  | Alta       |
| [0023](./0023-el-agente-pide-lo-que-le-falta.md)                | El agente pide lo que le falta: `setup_request` y la GUI que responde                                                | Rechazado (2026-10-26) | Alta       |
| [0024](./0024-la-conversacion-del-proyecto.md)                  | La conversación del proyecto: consultas sin tarea, de donde nacen tareas                                             | Aceptado (2026-10-26)  | Media      |
| [0025](./0025-vault-y-broker.md)                                | Vault y broker: Keel guarda las conexiones y el agente sólo pide operaciones                                         | Aceptado (2026-10-26)  | **Máxima** |
| [0026](./0026-prod-pregunta-y-se-puede-quitar.md)               | En producción Keel pregunta, y el humano puede quitar la pregunta asumiendo el riesgo                                | Propuesto              | Alta       |
| [0027](./0027-cerrar-a-mano-con-evidencia.md)                   | Cerrar a mano una tarea, con su motivo y su evidencia                                                                | Aceptado (2026-10-26)  | Media      |
| [0028](./0028-base-al-dia-y-sin-tope-de-turnos.md)              | La rama base al día antes de trabajar, y sin tope de turnos ni de tiempo por defecto                                 | Aceptado (2026-10-26)  | Media      |

## Estado

Están **Aceptados**: 0008, 0009 y 0010 el 2026-10-22; 0001 a 0007 y 0011 a 0019
el 2026-10-23; 0020, 0021, 0022, 0024 y 0025 el 2026-10-26, por el humano. 0023
quedó **Rechazado** el 2026-10-26: lo reemplaza 0025. 0026 y 0027 están
**Propuestos**. Los escribió Claude a petición del humano a partir del SDD, los
ADRs de Mirador, el canvas de pen.dev y los docs oficiales de Anthropic
verificados en su fecha. Uno nuevo nace como **Propuesto** y sólo el humano lo
acepta; uno aceptado no se edita: se supersede, y las desviaciones que se
encuentren al implementarlo van a `../reviews/`.

## Orden de lectura

0001 → 0002 → 0006 → 0004 → 0005 → 0003 → 0007 → 0009 → 0018 → 0008 → 0010 →
0011 → 0012 → 0013 → 0015 → 0014 → 0016 → 0017 → 0019 → 0020 → 0021 → 0022 →
0023 → 0024 → 0025 → 0026 → 0027 → 0028. Los dos primeros son el porqué; 0006 es
lo que bloquea el primer componente de UI; 0004, 0005 y 0003 son consecuencias;
0007 reparte el código en librerías reutilizables y producto.

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
