# ADR-008: Modelo de correlación revisado con evidencia de fixtures

> **Parcialmente superseded por [ADR-010](./0010-arbol-de-tres-niveles-y-semantica-de-run.md)**
> (2026-08-24): la resolución de padres (punto 1 y `parent_agent_id`) y la semántica de run
> (punto 6) se corrigen ahí con tasas medidas — el canal `tool_response.agentId` cubre 2/31
> casos reales. El resto de este ADR sigue vigente. El contenido original se conserva sin
> editar.

- **Estado:** Aceptado — parcialmente superseded por ADR-010 (padres y semántica de run)
- **Fecha:** 2026-08-24
- **Criticidad:** Máxima — hereda la de ADR-003
- **Supersede:** ADR-003 (completo). Lo que ADR-003 acertó se re-declara aquí explícitamente.
- **Relacionados:** ADR-002 (envelope), ADR-004 (nota sobre gates), ADR-007 (mediciones)
- **Evidencia:** `packages/core/__fixtures__/` — 4,633 eventos reales redactados (15 sesiones,
  21 kinds, 2026-08-20 → 2026-08-24, Claude Code 2.1.238). Cardinalidades verificadas con un
  oráculo independiente; la redacción preserva IDs compartidos y cardinalidad, así que las
  cifras de este ADR se pueden recomputar contra el repo.

## Contexto

ADR-003 se escribió antes de capturar un solo evento: era el mejor modelo deducible de la
documentación. La Fase 1 capturó trabajo real y varias de sus suposiciones no sobrevivieron
al contacto con los datos — y varios de los campos que resultan decisivos (`prompt_id`,
`background_tasks`, `duration_ms`, `agent_transcript_path`, `compact_summary`) ni siquiera
están documentados. Este ADR corrige lo refutado y conserva, con evidencia, lo que sí acertó.

## Decisión

### 1. Cinco taxonomías de agente, no una

`background_tasks[].type` distingue `monitor | shell | subagent | teammate | workflow` (los
5 aparecen en los datos), con **cuatro formatos de ID distintos**: hex de 17 para subagentes
(`tool_response.agentId`, `agent_id`), `wf_*` para workflows (`tool_response.runId`),
`nombre@team` para teammates (`tool_response.teammate_id`) y IDs cortos de 9 alfanuméricos
para las background tasks (`background_tasks[].id`, `taskId`/`task_id`). Cualquier parser que
asuma un solo formato de ID se rompe: `agent_id` y demás llaves de agente son **strings
opacos**.

El nodo unificador del ciclo de vida es **`background_tasks[]`** (presente en `Stop` y
`SubagentStop`, con `id`, `type`, `status` y descripción por tarea viva), no `SubagentStart`:
en los datos hay 72 `agent_id` distintos con `SubagentStop` y sólo 25 tienen `SubagentStart`.

### 2. `Stop` y `SubagentStop` son fin de turno, no cierre de ciclo de vida

Medido: 72 `SubagentStop` contra 25 `SubagentStart`, y ambos comparten el payload de `Stop`
(`background_tasks`, `session_crons`, `stop_hook_active`, `last_assistant_message`;
`SubagentStop` sólo añade `agent_id`, `agent_type`, `agent_transcript_path`). El cierre real
de una tarea se deriva de `background_tasks[]`: en los datos su `status` sólo registra
`running`, así que la señal observable de cierre es que la tarea **desaparece** de la lista
entre dos eventos consecutivos; si algún día llega un `status` terminal, se usa. `orphan`
(ADR-003) sigue existiendo encima de esto: 5 de 1,356 tool calls sin cierre (0.4%) — real
pero raro, estado de primera clase.

### 3. `PostToolBatch` es un evento compuesto: se ingiere, no cuenta

1,107 eventos `PostToolBatch` traen 1,352 `tool_use_id` dentro de `tool_calls[]`, frente a
1,356 `PreToolUse`: duplica ~100% de los tool calls (la cifra "~83%" que circuló salía de
dividir eventos batch entre `PostToolUse`, no de contar `tool_calls[]`). No trae
`tool_use_id` propio, cuando el envelope de ADR-002 tiene exactamente uno. Decisión: se
ingiere íntegro (`kind: 'PostToolBatch'`, `tool_use_id: null` — ADR-002 manda), los
`PostToolUse` individuales son **la autoridad** para la vista de tool calls, y el batch sólo
informa qué se agrupó en un mismo turno del modelo. Sin esta regla, todo conteo sale doble.

### 4. `tool_use_id` viene siempre: fuera la síntesis por hash

1,356/1,356 `PreToolUse`, 1,339/1,339 `PostToolUse` y 12/12 `PostToolUseFailure` traen
`tool_use_id`. La síntesis por hash y el flag `tool_use_id_synthetic` de ADR-003 resolvían un
problema imaginario: **se eliminan**. Si algún día un evento de tool llega sin id, se ingiere
con `tool_use_id: null` y no correlaciona (regla 3 de ADR-002); no se inventa.

### 5. `transcript_path` identifica; `cwd` es volátil

`transcript_path` está en el 100% de los eventos (4,633/4,633) y es 1:1 con `session_id`
(15 ↔ 15). `cwd` salta dentro de una sesión (21 `CwdChanged`; hasta 10 `cwd` distintos en una
misma sesión). La pertenencia a proyecto/sesión se resuelve por `transcript_path` /
`session_id`; `cwd` es un atributo del evento, nunca llave de agrupación.

### 6. `SessionStart.source` decide el run: `compact` continúa, `resume`/`fork` abren

Excepción explícita a la regla de ADR-003 ("`SessionStart` abre run"): la compactación emite
un `SessionStart` con `source: 'compact'` **dentro del mismo `session_id`** (observado:
`[fork, resume, compact]` sobre una misma sesión), así que ese `SessionStart` **no** abre run
nuevo — el run se marca con `compaction_seq`, como ya decía ADR-003. `resume` y `fork` sí
abren run nuevo ligado por `previous_run_id`. Distribución observada de `source`:
startup 11, resume 7, fork 1, compact 1. Como la compactación no corta ni la sesión ni el
run, una sesión puede abarcar tres días sin que ningún compact aparezca como frontera.

### 7. `compact_summary` llega íntegro en `PostCompact`

El único `PostCompact` capturado entrega el resumen **literal completo** (30,430 unidades
UTF-16) en `compact_summary`; `PreCompact` lleva `custom_instructions` y no lleva resumen.
Ambos comparten `prompt_id`: la compactación ocurre dentro de un turno, no entre turnos. Para
la vista de contexto de fase 5 esto elimina una inferencia entera: no hay que reconstruir qué
sobrevivió, se entrega. Sólo tenemos evidencia de `trigger: 'manual'`; `auto` existe en el
matcher del CLI pero **no lo hemos capturado** — la sesión de 3 días y 4,108 eventos no
registra ni un `PreCompact`, así que o el auto-compact no dispara estos hooks o no ocurrió;
no lo sabemos aún. Detalle adicional medido: el sumarizador corre como agente utilitario y su
`SubagentStop` lleva el resumen como `last_assistant_message` (misma longitud) — ver punto 9.

### 8. El gate de permisos no tiene evento de resolución — y no trae `tool_use_id`

30 `PermissionRequest`, cero `PermissionDenied`, ningún evento de aprobación. Y es peor de lo
que ADR-003 asumía: `PermissionRequest` **no trae `tool_use_id` ni `agent_id`** (campos:
`session_id`, `transcript_path`, `cwd`, `permission_mode`, `effort`, `tool_name`,
`tool_input`, `permission_suggestions`; `prompt_id` sólo en 3/30). El estado `blocked` no es
observable por join de id: el desenlace se infiere emparejando `(session_id, tool_name,
tool_input)` con el `PostToolUse`/`PostToolUseFailure` siguiente, y esa correlación se marca
como heurística en la UI.

**Nota a ADR-004** (se deja anotado, no se resuelve aquí): su diseño asume un ciclo de gate
observable que no existe en la superficie de hooks. El gate informado de mirador tendrá que
emitir su propio evento de resolución en vez de esperar uno del CLI.

### 9. `agent_type` es espacio abierto; `""` se normaliza a `null`

Cinco valores hoy: `"" | Explore | arq-binding | claude | workflow-subagent` — y
`arq-binding` viene de configuración del usuario. Sin enum, sin lista fija ni colores por
tipo en la UI (la regla 1 de ADR-002, aplicada a agentes).

Medido (Paso 0 del cierre de fase): `""` aparece **sólo** en `SubagentStop` (47/72) y **no**
es el stop del agente principal — 0/47 emparejan con un `Stop` por (sesión, `prompt_id`,
`last_assistant_message`). Son **agentes utilitarios internos del CLI**: el generador de
título de sesión (p50 de `last_assistant_message` = 35 caracteres) y el sumarizador de
compactación (uno con exactamente la longitud de `compact_summary`), sin `SubagentStart`, sin
tool calls, con `agent_id` sintético — los 47 coinciden exactamente con los 47 agent_id que
no tienen `SubagentStart`. Decisión: `""` → `null`, y un `SubagentStop` sin `SubagentStart`
previo y sin tool events se clasifica **agente utilitario**: dato de primera clase, fuera del
árbol de trabajo por default. Nunca se trata `""` como un tipo.

### 10. Teammates: ciclo incompleto, no invisible

`TeammateIdle` **sí dispara** (1 capturado): trae `teammate_name` y `team_name`, sin
`agent_id` ni `agent_type`. El teammate aparece además en `Agent.tool_response.teammate_id`
(`nombre@team`) y como `background_tasks[].type: 'teammate'`. No hay start/stop de teammate:
su ciclo se observa por `background_tasks[]` más `TeammateIdle`.

### Lo que ADR-003 acertó y se conserva

- **`run_id` propio (ULID nuestro).** La sesión mayor abarca 3 días y 4,108 eventos:
  `session_id` no es unidad de trabajo. Apertura/cierre como en ADR-003, con la excepción del
  punto 6.
- **`prompt_id` es el identificador de turno** que ADR-003 dio por inexistente (existe desde
  CLI 2.1.196; ausente en `SessionStart`/`InstructionsLoaded` y casi siempre en
  `PermissionRequest`). Se usa en correlación leyéndolo de `raw`; si acaba haciendo falta en
  el envelope, eso es una extensión de ADR-002 que se decide aparte.
- **`parent_agent_id` y `parent_pending`.** El padre no viene en `SubagentStart` (no trae ni
  padre ni `tool_use_id`): se resuelve porque el `PostToolUse` del tool que lanzó (`Agent`,
  `Workflow`) trae el id del hijo (`agentId`/`runId`/`teammate_id`) y ese evento sí trae el
  `agent_id` del padre. Nota: ese `PostToolUse` llega con `status: 'async_launched'` — marca
  el **lanzamiento**, no el fin. `parent_pending` se conserva para llegadas fuera de orden;
  la ingestión nunca se bloquea.
- **`orphan` como estado de primera clase** (punto 2: 0.4% real).
- **La vista principal es el árbol, no el timeline:** 996/1,356 tool calls (73%) ocurren
  dentro de subagentes.

### Riesgo conocido, sin resolver

`tmux_pane_id`, `tmux_session_name`, `tmux_window_name` hoy dicen `in-process` (observados en
el `tool_response` que lanzó el teammate). El campo existe porque puede no serlo: un teammate
en un pane aparte podría no ser visible por hooks de la misma forma. Se captura el campo y se
detecta el cambio; no se construye nada encima todavía.

## Anexo: cardinalidades medidas

Sobre los 4,633 eventos (verificadas con oráculo independiente; recomputables contra
`packages/core/__fixtures__`):

| campo | únicos |
|---|---|
| `tool_name` | 15 |
| `agent_id` | 72 |
| `agent_type` | 5 |
| `prompt_id` | 69 |
| `session_id` | 15 |
| `transcript_path` | 15 |
| `background_tasks[].type` | 5 |

Implicación de diseño: 72 agentes contra 69 turnos ≈ un agente por turno — el árbol es
**ancho y bajo**, no profundo.

Del registro de 31 eventos del CLI, 10 siguen sin aparecer nunca: `PermissionDenied`,
`TaskCreated`, `TaskCompleted`, `Setup`, `FileChanged`, `DirectoryAdded`, `Elicitation`,
`ElicitationResult`, `WorktreeCreate`, `WorktreeRemove`.

## Consecuencias

**Positivas**
- La correlación se escribe contra datos commiteados y reproducibles, no contra doc.
- Menos código: desaparecen la síntesis de `tool_use_id` y su flag.
- La regla del batch elimina el doble conteo antes de que exista la primera query.
- `compact_summary` literal convierte la vista de contexto de fase 5 de inferencia a lectura.

**Negativas**
- La inferencia del desenlace de gates es heurística y la UI debe presentarla como tal.
- "Agente utilitario" depende de una heurística (sin start + sin tools) que un release del
  CLI puede invalidar.
- El modelo se apoya en campos no documentados (`background_tasks`, `prompt_id`,
  `agent_transcript_path`) que pueden cambiar sin aviso. Mitigación: `inspect` sobre fixtures
  nuevos detecta el cambio (cardinalidades, registrados-nunca-vistos) antes que el código.

## Alternativas consideradas

- **Mantener ADR-003 tal cual.** Rechazada: cinco de sus suposiciones quedaron refutadas por
  los datos (síntesis de ids, SubagentStart como unificador, stop como cierre, "no hay id de
  turno", gate observable).
- **Modelar sólo subagentes hex.** Rechazada: deja fuera 4 de las 5 taxonomías que ya
  aparecen en una semana de uso real.
- **Esperar a que la documentación oficial cubra estos campos.** Rechazada: lo decisivo no
  está documentado y la doc ni siquiera enumera bien los 31 eventos del binario.
