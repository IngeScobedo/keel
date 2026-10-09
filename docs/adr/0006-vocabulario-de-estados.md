# ADR-0006: Vocabulario de estados — tres niveles y una proyección a tablero

- **Estado:** Propuesto. **Requiere decisión del humano**: este ADR propone una
  reconciliación; no la da por hecha.
- **Fecha:** 2026-10-08
- **Criticidad:** Máxima — bloquea `StateBadge`, `StatusDot`, el tablero y la
  máquina de estados
- **Relacionados:** SDD 01 §3, SDD 03 (`work_items.lifecycle`, `runs.status`),
  `../design/canvas-inventory.md`

## Contexto

Hay tres vocabularios que no cuadran:

| Dónde                                                            | Valores                                                                                                                                        |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| SDD 01/03, `work_items.lifecycle`                                | `triage, planned, running, waiting_human, blocked, needs_review, failed, done`                                                                 |
| SDD 01/03, `runs.status`                                         | `queued, initializing, running, paused, completed, failed, cancelled, budget_exceeded`                                                         |
| Canvas pen.dev, `ds/StatusDot` y `ds/StatusBadge` (11 variantes) | `queued, planning, running, waiting_human, blocked, succeeded, failed, cancelled, interrupted, orphan, budget_stop`                            |
| Canvas, columnas del Board                                       | `Backlog, Ready, In Progress, In Review, Done`, con badges `Queued, Planning, Running, Needs review, Needs you, Blocked, Succeeded, Cancelled` |

Además `tool_calls.state` es `pending, done, failed, orphan` y los agentes
tienen `running / succeeded / failed / orphan / waiting_human` en `ds/AgentRow`.

El canvas no está «mal»: sus 11 estados son el vocabulario de **nodos de
ejecución** (agentes, tool calls, runs vistos como cosas que corren), mientras
que el `lifecycle` del SDD es el de la **tarea** como unidad de trabajo humano.
Son niveles distintos y el diseño los mezcla en un solo componente porque un
badge es un badge.

## Decisión propuesta

1. **Tres niveles, tres enumeraciones, un solo componente visual.**

   | Nivel             | Entidad                                           | Estados                                                                                                                                                    | Autoridad                                         |
   | ----------------- | ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
   | Tarea             | `work_items.lifecycle`                            | `triage, planned, running, waiting_human, blocked, needs_review, failed, done` (SDD, sin cambios)                                                          | Máquina de estados del daemon; `done` sólo humano |
   | Intento           | `runs.status`                                     | `queued, initializing, running, paused, waiting_human, completed, failed, cancelled, interrupted, budget_exceeded` (SDD + `waiting_human` + `interrupted`) | Supervisor de procesos                            |
   | Nodo de ejecución | `agent_instances`, `workflow_nodes`, `tool_calls` | `pending, running, waiting_human, succeeded, failed, cancelled, interrupted, orphan`                                                                       | Proyección desde `events` (`@keel/core`)          |

   `ds/StatusBadge` y `ds/StatusDot` reciben el **estado visual** de la tabla 2;
   la forma y el color por estado son los del canvas (la forma difiere por
   estado para leerse sin color).

2. **Mapeo a estado visual** (lo que el componente pinta):

   | Visual (canvas) | Tarea                           | Run                                          | Nodo                                    |
   | --------------- | ------------------------------- | -------------------------------------------- | --------------------------------------- |
   | `queued`        | `triage`, `planned` sin run     | `queued`, `initializing`                     | `pending`                               |
   | `planning`      | `planned` con Reasoner activo   | —                                            | —                                       |
   | `running`       | `running`                       | `running`                                    | `running`                               |
   | `waiting_human` | `waiting_human`, `needs_review` | `waiting_human`, `paused`                    | `waiting_human`                         |
   | `blocked`       | `blocked`                       | —                                            | —                                       |
   | `succeeded`     | `done`                          | `completed`                                  | `succeeded`                             |
   | `failed`        | `failed`                        | `failed`                                     | `failed`                                |
   | `cancelled`     | —                               | `cancelled`                                  | `cancelled`                             |
   | `interrupted`   | —                               | `interrupted` (rate limit, red, StopFailure) | `interrupted`                           |
   | `orphan`        | —                               | —                                            | `orphan` (sin cierre, ADR-0008 Mirador) |
   | `budget_stop`   | —                               | `budget_exceeded`                            | —                                       |

   El badge muestra **el texto del estado real** (`needs_review`, no
   `waiting_human`) y toma del visual sólo forma y color. Así `needs_review` y
   `waiting_human` comparten ámbar pero no se confunden.

3. **`board_status` es una proyección configurable por proyecto** (SDD 01 §3) y
   **no** un cuarto vocabulario del dominio. Las columnas del canvas
   (`Backlog, Ready, In Progress, In Review, Done`) son el default; el mapeo no
   puede saltarse las guardas del `lifecycle`.

4. **`end_reason` del run**
   (`completed, interrupted, timeout, budget_exceeded, rate_limit, fatal_error,
   cancelled`)
   se conserva como causa, separado del estado. `rate_limit` y `StopFailure`
   producen `interrupted`, no `failed`: la distinción que Mirador aprendió (F2
   del backlog).

5. **El canvas se actualiza**, no el modelo: `ds/StatusBadge` gana la variante
   `needs_review` (ámbar, forma de `waiting_human`) y el Board de ejemplo deja
   de usar «Needs you» como estado y lo usa como filtro.

## Lo que el humano tiene que decidir

- Si `needs_review` merece color propio (el canvas hoy no lo tiene) o comparte
  ámbar.
- Si `planning` existe como estado visual de tarea o se funde en `queued`.
- Si `paused` (run) se pinta `waiting_human` o `queued`.

## Consecuencias

**Positivas**

- El componente de estado se implementa una vez con una tabla de mapeo testeada.
- El SDD no cambia su máquina de estados; el canvas cambia una variante.
- Las lecciones de Mirador (`orphan`, `interrupted` por rate limit) tienen
  sitio.

**Negativas**

- Tres enumeraciones son más que una; se mitiga con la tabla única de mapeo en
  `@keel/core`.
- Hay que tocar el canvas (una variante nueva, un ejemplo de Board).

## Alternativas consideradas

- **Un solo vocabulario de 11 estados para todo.** Rechazada: `needs_review` y
  `done` son decisiones humanas que no tienen sentido en un tool call, y
  `orphan` no tiene sentido en una tarea.
- **Renombrar el SDD al vocabulario del canvas.** Rechazada: perdería
  `needs_review`, que es la guarda central del producto («cierre humano»).
