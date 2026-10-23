# ADR-0006: Vocabulario de estados — tres niveles y una proyección a tablero

- **Estado:** Aceptado (2026-10-23). Las decisiones de la sección «Decisiones
  del humano» son del 2026-10-09 y están aplicadas al SDD 03 y al canvas.
- **Fecha:** 2026-10-08 (propuesto), 2026-10-09 (decisiones aplicadas)
- **Criticidad:** Máxima — bloquea `StateBadge`, `StatusDot`, el tablero y la
  máquina de estados
- **Relacionados:** SDD 01 §3, SDD 03 (`work_items.lifecycle`, `runs.status`,
  `tool_calls.state`), ADR-0005 (el daemon emite el estado visual),
  `../design/canvas-inventory.md`

## Contexto

Hay tres vocabularios que no cuadran:

| Dónde                                                            | Valores                                                                                                                                        |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| SDD 01/03, `work_items.lifecycle`                                | `triage, planned, running, waiting_human, blocked, needs_review, failed, done`                                                                 |
| SDD 01/03, `runs.status` (antes de este ADR)                     | `queued, initializing, running, paused, completed, failed, cancelled, budget_exceeded`                                                         |
| Canvas pen.dev, `ds/StatusDot` y `ds/StatusBadge` (11 variantes) | `queued, planning, running, waiting_human, blocked, succeeded, failed, cancelled, interrupted, orphan, budget_stop`                            |
| Canvas, columnas del Board                                       | `Backlog, Ready, In Progress, In Review, Done`, con badges `Queued, Planning, Running, Needs review, Needs you, Blocked, Succeeded, Cancelled` |

Además `tool_calls.state` era `pending, done, failed, orphan`, los agentes
tienen `running / succeeded / failed / orphan / waiting_human` en `ds/AgentRow`,
y `agent_instances` y `workflow_nodes` no tenían columna de estado.

El canvas no está «mal»: sus 11 estados son el vocabulario de **nodos de
ejecución** (agentes, tool calls, runs vistos como cosas que corren), mientras
que el `lifecycle` del SDD es el de la **tarea** como unidad de trabajo humano.
Son niveles distintos y el diseño los mezcla en un solo componente porque un
badge es un badge.

## Decisión

1. **Tres niveles, tres enumeraciones, un solo componente visual.**

   | Nivel             | Entidad                                           | Estados                                                                                                                                                                  | Autoridad                                         |
   | ----------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------- |
   | Tarea             | `work_items.lifecycle`                            | `triage, planned, running, waiting_human, blocked, needs_review, failed, done` (SDD, sin cambios)                                                                        | Máquina de estados del daemon; `done` sólo humano |
   | Intento           | `runs.status`                                     | `queued, initializing, running, paused, waiting_human, completed, failed, cancelled, interrupted, budget_exceeded`                                                       | Supervisor de procesos                            |
   | Nodo de ejecución | `agent_instances`, `workflow_nodes`, `tool_calls` | `pending, running, waiting_human, succeeded, failed, cancelled, interrupted, orphan` — columna `state`, proyección calculada por el daemon desde `events` (`@keel/core`) | Daemon; nunca un cliente                          |

   Cambios que esto impone al SDD 03 (aplicados el 2026-10-09):

   - `runs.status` gana `waiting_human` e `interrupted`. **`interrupted` es
     terminal**: el reintento tras un rate limit o una caída es un run nuevo,
     coherente con «reanudar la conexión no presupone reanudar tool calls» (SDD
     02 §3). Por eso `idx_live_run` cubre
     `queued, initializing, running, paused, waiting_human` y **no**
     `interrupted`. Sin este cambio un run en `waiting_human` no contaba como
     vivo y el índice habría permitido lanzar un segundo run de la misma tarea.
   - `runs.purpose IN ('plan', 'execute', 'triage_eval')`, default `execute`. Es
     el hecho observable detrás del visual `planning` (abajo).
   - `tool_calls.state`: `done` pasa a `succeeded` y se añaden `running`,
     `waiting_human`, `cancelled`, `interrupted`. Una traducción menos.
   - `workflow_nodes.state` y `agent_instances.state` nuevos, misma enumeración.
   - `agent_instances.parent_source` gana `sdk` (ADR-0002 §4). Caso observado:
     el spike del 2026-10-08 recibió `agent_id` y `parent_tool_use_id` en los
     mensajes del subagente (`FINDINGS.md`, primera corrida); sin ese caso el
     valor se habría quitado.

2. **Mapeo a estado visual** (lo que el componente pinta). Son **13** visuales:
   los 11 del canvas más `needs_review` y `paused`.

   | Visual          | Familia de color | Tarea                                       | Run                                          | Nodo                                    |
   | --------------- | ---------------- | ------------------------------------------- | -------------------------------------------- | --------------------------------------- |
   | `queued`        | neutro           | `triage` sin run, `planned` sin run         | `queued`, `initializing`                     | `pending`                               |
   | `planning`      | violeta          | `triage` con run vivo de `purpose = 'plan'` | run vivo con `purpose = 'plan'`              | —                                       |
   | `paused`        | neutro           | —                                           | `paused`                                     | —                                       |
   | `running`       | azul             | `running`                                   | `running` (`purpose = 'execute'`)            | `running`                               |
   | `waiting_human` | ámbar            | `waiting_human`                             | `waiting_human`                              | `waiting_human`                         |
   | `needs_review`  | ámbar            | `needs_review`                              | —                                            | —                                       |
   | `blocked`       | naranja          | `blocked`                                   | —                                            | —                                       |
   | `succeeded`     | verde            | `done`                                      | `completed`                                  | `succeeded`                             |
   | `failed`        | rojo             | `failed`                                    | `failed`                                     | `failed`                                |
   | `cancelled`     | gris             | —                                           | `cancelled`                                  | `cancelled`                             |
   | `interrupted`   | teal             | —                                           | `interrupted` (rate limit, red, StopFailure) | `interrupted`                           |
   | `orphan`        | magenta          | —                                           | —                                            | `orphan` (sin cierre, ADR-0008 Mirador) |
   | `budget_stop`   | rosa             | —                                           | `budget_exceeded`                            | —                                       |

   Reglas de lectura:

   - **La forma difiere por visual**, también entre los que comparten color:
     `ds/StatusDot` no lleva texto y con mismo color y misma forma dos estados
     serían indistinguibles. `needs_review` y `paused` reciben forma propia.
   - **El badge muestra el texto del estado real** (`needs_review`, no
     `waiting_human`) y toma del visual sólo forma y color.
   - **«Needs you» es un filtro, no un estado:** todo lo ámbar (`waiting_human`
     y `needs_review`). `paused` nunca es ámbar porque no pide una decisión,
     pide que alguien lo reanude cuando quiera; si la pausa la provocó algo que
     exige decisión, el run está en `waiting_human`.
   - `planning` sólo existe con un run vivo de `purpose = 'plan'` detrás. Una
     tarea cuyo Reasoner no corre no está «planning»: está `queued`.

3. **El estado visual lo calcula el daemon**, no el cliente. Cada entidad
   proyectada que viaja por ADR-0005 (`work_item`, `run`, `agent`, `workflow`,
   `tool_call`) lleva `visual_state` ya resuelto con la tabla 2, que vive en
   `@keel/core` con un test exhaustivo (`satisfies Record<…, Visual>`). La TUI
   en Rust y la GUI en React pintan lo que reciben; ninguna reimplementa el
   mapeo. Es la forma de que la regla no se bifurque entre dos lenguajes.

   `visual_state` es **parte del envelope versionado** de ADR-0005: sus 13
   valores son contrato; añadir uno es un cambio de protocolo con nueva versión.
   Los clientes tienen fallback explícito para un valor desconocido: pintar
   neutro con el texto crudo del estado, nunca ocultar la entidad. La tabla 2 es
   el artefacto canónico y se materializa como fixtures de conformidad
   `(entidad, estado, purpose) → visual_state` en `@keel/core`, testeadas en el
   daemon con cobertura exhaustiva de las tres enumeraciones.

4. **`board_status` es una proyección configurable por proyecto** (SDD 01 §3) y
   **no** un cuarto vocabulario del dominio. Las columnas del canvas
   (`Backlog, Ready, In Progress, In Review, Done`) son el default; el mapeo no
   puede saltarse las guardas del `lifecycle`.

5. **`end_reason` del run** se conserva como causa, separado del estado. Sus
   valores son `completed`, `interrupted`, `timeout`, `budget_exceeded`,
   `rate_limit`, `fatal_error` y `cancelled`. `rate_limit` y `StopFailure`
   producen `interrupted`, no `failed`: la distinción que Mirador aprendió (F2
   del backlog).

6. **El canvas se actualiza**, no el modelo: `ds/StatusBadge` y `ds/StatusDot`
   ganan las variantes `needs_review` (familia ámbar, forma propia) y `paused`
   (familia neutra, forma de pausa); el Board de ejemplo deja de usar «Needs
   you» como estado y lo usa como filtro. Pendiente en el canvas.

## Decisiones del humano (2026-10-09)

1. **`needs_review`: familia ámbar, forma propia.** Comparte el ámbar porque
   cumple el criterio «la pelota está en tu cancha». Necesita forma propia
   porque el argumento del texto en el badge no aplica a `StatusDot`. No son
   equivalentes en urgencia: `waiting_human` tiene un agente detenido;
   `needs_review` es un handoff que puede esperar.
2. **`planning` se conserva, con el mapeo corregido.** Fundirlo en `queued`
   mostraría inactiva a una tarea que consume tokens, contra la línea de Mirador
   de no ocultar ni inventar. Pero según la máquina de estados del SDD,
   `triage → planned` exige «alcance y plan válidos»: el Reasoner trabaja en
   `triage`, no en `planned`. Sin un hecho observable detrás, `planning` sería
   un estado inventado; el hecho es `runs.purpose = 'plan'` con el run vivo.
3. **`paused` es neutro, nunca ámbar, con forma propia.** Pintarlo
   `waiting_human` inflaría la cola de atención. Mejor un visual más que un
   ámbar mentiroso.

## Condiciones (estado al 2026-10-09)

| Condición                                                            | Estado                                                                                                 |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Revalidación completa del DDL sobre el esquema corregido             | Resuelta: `bun run docs:validate-ddl`, 62 comprobaciones en `bun:sqlite` 3.53.2 con FTS5 y vec0 0.1.9. |
| Validación versionada en el repo y en CI                             | Resuelta: `scripts/validate-ddl.ts`, `.github/workflows/ci.yml`.                                       |
| `parent_source = 'sdk'` con caso observado                           | Resuelta: ver punto 1 y `FINDINGS.md`.                                                                 |
| `visual_state` como contrato del protocolo                           | Texto resuelto (punto 3); la función y los fixtures en `@keel/core` son trabajo de la Fase 0.          |
| Canvas: variantes `needs_review` y `paused`, «Needs you» como filtro | Aplicado el 2026-10-09; la forma de `needs_review` se revisó en escala de grises (inventario).         |

Correcciones que condicionaron las decisiones y que este ADR aplica al SDD 03:
`idx_live_run` con `waiting_human`, `interrupted` terminal, `runs.purpose`, el
nivel de nodo materializado como columna `state`, y el mapeo resuelto en el
daemon para que la TUI no lo reimplemente. El DDL modificado se re-ejecutó el
2026-10-09 en SQLite 3.53.1 con cuatro comprobaciones nuevas: `idx_live_run`
rechaza un segundo run vivo cuando el primero está en `waiting_human`;
`interrupted` permite un run nuevo; los `CHECK` rechazan `purpose` inválido y el
valor viejo `done` en `tool_calls.state`; `foreign_key_check` limpio.

## Consecuencias

**Positivas**

- El componente de estado se implementa una vez, con una tabla de mapeo testeada
  y resuelta en un solo sitio.
- El SDD no cambia su máquina de estados; el canvas gana dos variantes.
- Las lecciones de Mirador (`orphan`, `interrupted` por rate limit) tienen
  sitio.
- `idx_live_run` vuelve a garantizar «un run vivo por tarea» con los estados
  nuevos.

**Negativas**

- Tres enumeraciones son más que una; se mitiga con la tabla única en
  `@keel/core` y `visual_state` en el protocolo.
- Hay que tocar el canvas (dos variantes nuevas, un ejemplo de Board).
- `runs.purpose` es una columna más que el scheduler tiene que poblar bien; un
  run de planificación mal etiquetado se pintaría `running`.

## Alternativas consideradas

- **Un solo vocabulario de 11 estados para todo.** Rechazada: `needs_review` y
  `done` son decisiones humanas que no tienen sentido en un tool call, y
  `orphan` no tiene sentido en una tarea.
- **Renombrar el SDD al vocabulario del canvas.** Rechazada: perdería
  `needs_review`, que es la guarda central del producto («cierre humano»).
- **Mapeo como dato con codegen hacia TS y Rust más test de conformidad.**
  Válida; descartada frente a `visual_state` calculado en el daemon porque deja
  a los clientes sin lógica, que es lo que ADR-0005 quiere.
- **`paused` pintado `waiting_human`.** Rechazada: no pide decisión.
