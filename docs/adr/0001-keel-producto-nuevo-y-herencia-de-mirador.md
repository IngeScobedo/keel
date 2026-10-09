# ADR-0001: Keel es producto nuevo; qué hereda de Mirador y qué no

- **Estado:** Propuesto
- **Fecha:** 2026-10-08
- **Criticidad:** Máxima — define el alcance de todo lo demás
- **Relacionados:** ADRs de Mirador en `../inherited/mirador/adr/`; SDD 01–04 en
  `../sdd/`

## Contexto

Mirador (repo `cc-ui`) es un observador externo de sesiones de Claude Code:
hooks del CLI → spool → collector Fastify → Postgres `jsonb` → web React con
SSE. Entregó dos fases y, sobre todo, un modelo de correlación medido contra
6,721 eventos reales (ADR-0008 y ADR-0010 de Mirador) y un backlog de UI con
hallazgos concretos.

Keel es otra cosa: un harness de ingeniería centrado en la tarea (`WorkItem`),
con daemon, clientes TUI y GUI, scheduler de lanes, Contract Hub y Research Hub,
que **corre a los agentes sobre los SDKs oficiales** de Claude y Codex en vez de
observar un CLI ajeno. Es el modo «runtime» que ADR-0001 de Mirador dejó detrás
de un adaptador y nunca construyó.

Tratar a Keel como «evolución de Mirador» obliga a arrastrar un stack (Fastify,
Postgres, SSE, hook-bridge como transporte primario) que no sirve al runtime y
contradice el SDD. Tratarlo como producto nuevo sin herencia tira al suelo lo
único de Mirador que costó conseguir: reglas medidas.

## Decisión

1. **Keel es un repo y un producto nuevos.** `cc-ui` queda como archivo y
   donante de fixtures. Ningún paquete de Mirador se importa como dependencia;
   lo que sirve se copia y se renombra (`@keel/core`).

2. **Se heredan reglas, no infraestructura.** Los siguientes ADRs de Mirador se
   adoptan como norma vinculante de Keel, leídos en `../inherited/mirador/adr/`:

   | ADR Mirador | Qué se adopta                                                                                                                                                              | Qué cambia en Keel                                                                               |
   | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
   | 0001        | El invariante del adaptador: cada fuente traduce a un evento canónico y **nada por encima del bus sabe de qué proveedor vino**.                                            | Los adaptadores son los SDKs (Claude, Codex); el `HookAdapter` del CLI pasa a opcional y futuro. |
   | 0002        | Envelope delgado + `raw` íntegro; `kind` es string libre; nunca truncar en silencio; blobs con preview y puntero; append-only.                                             | El store es SQLite (ADR-0004), no Postgres. La sección «El store» de 0002 **no aplica**.         |
   | 0004        | `agent_ro`/`agent_rw` impuestos en la base; `deny-on-timeout`; `async` no es gate; secretos fuera del store; redacción best-effort y dicha así; bind local.                | Se amplía con ADR-0002 de Keel (credenciales de proveedores).                                    |
   | 0008        | Taxonomías de agente abiertas; `Stop` es fin de turno; `PostToolBatch` se ingiere y no cuenta; `tool_use_id` siempre; `transcript_path` identifica; `agent_type` sin enum. | Se conserva íntegro como modelo para fuentes sin identidad nativa (CLI, Codex).                  |
   | 0010        | Árbol de tres niveles con nodos-agente y nodos-task; `parent_source` con proveniencia; `parent_discrepancy` nunca silenciado; runs por actividad real.                     | Se añade un canal 0 `sdk` (certeza nativa del SDK) por encima de los tres de 0010. Ver spike.    |

3. **No se adoptan** (ni se supersede: simplemente no rigen en Keel): 0003
   (histórico), 0005 (Fastify, Postgres, SSE, estructura de paquetes de
   Mirador), 0006 (spool + POST del hook-bridge), 0007 (sólo en lo que fija Bun
   como runtime de _ese_ repo; Keel decide el suyo en ADR-0003).

4. **Los fixtures redactados de Mirador** (`packages/core/__fixtures__`, 4
   ficheros NDJSON, 15 sesiones) se copian a Keel y siguen siendo el oráculo de
   `@keel/core` para el modelo de correlación heredado. Los fixtures del modo
   runtime se graban nuevos con el spike.

5. **El SDD (`../sdd/01–04`) es la especificación funcional; los ADRs son la
   autoridad.** Donde el SDD y un ADR choquen, gana el ADR y se corrige el SDD.
   Los borradores previos (`docs/01-04` de `cc-ui`) no se traen: contienen
   decisiones que este ADR y ADR-0002 rechazan (parseo de tokens OAuth, overlap
   de lanes por prefijo, tokens de diseño inventados).

6. **El canvas de pen.dev es la fuente de verdad visual.** Sus tokens exportados
   viven en `../design/tokens.json` y su inventario en
   `../design/canvas-inventory.md`. Cuando el SDD y el canvas difieran en
   vocabulario (estados, nombres de archivo), lo resuelve un ADR (0006 para
   estados), no el gusto del implementador.

## Consecuencias

**Positivas**

- Keel arranca sin deuda de un stack pensado para otro problema.
- El conocimiento caro de Mirador (correlación medida, lecciones de hooks,
  seguridad) entra como regla desde el día uno.
- `cc-ui` deja de necesitar mantenimiento.

**Negativas**

- Dos repos con historia: hay que recordar que los ADRs heredados se leen en su
  copia, no se editan.
- `@keel/core` carga 26 MB de fixtures que sólo sirven al modo observador.
  Aceptado: son el único oráculo real hasta que el spike produzca el del
  runtime.
- El modo observador (hooks del CLI) queda sin implementación en Keel. Si vuelve
  a hacer falta, se escribe un adaptador nuevo contra ADR-0005; el `hook-bridge`
  de Mirador es referencia, no base.

## Alternativas consideradas

- **Evolucionar `cc-ui` in place, superseding sus ADRs uno a uno.** Rechazada:
  casi todos cambian (store, transporte, runtime, modo de operación) y el
  historial se vuelve ruido.
- **Keel sin herencia, desde cero.** Rechazada: reescribir la correlación sin
  los fixtures ni las tasas medidas repetiría errores que ya costaron una fase.
- **Monorepo único con Mirador y Keel.** Rechazada: Mirador no va a evolucionar;
  compartir toolchain y CI con un archivo sólo añade fricción.
