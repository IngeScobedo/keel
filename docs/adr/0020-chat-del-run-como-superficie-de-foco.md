# ADR-0020: El chat del run como superficie de foco: tarjetas por intención, aprobaciones por patrón y control en vivo

- **Estado:** Aceptado (2026-10-26)
- **Fecha:** 2026-10-26
- **Criticidad:** Alta
- **Relacionados:** ADR-0001 (adopta `deny-on-timeout` de ADR-0004 de Mirador;
  este ADR lo supersede en ese punto), ADR-0002 regla 5, ADR-0008 (Codex),
  ADR-0011 (eventos semánticos), ADR-0017 (contexto por MCP), ADR-0019 §3–§4
  (conversación, modos y aprobaciones), SDD 01 §10, SDD 02 §9

## Contexto

El humano usó la GUI con un agente real el 2026-10-26. Lo que encontró:

- Las ediciones a archivos no muestran qué cambió ni el diff.
- Tiene que aprobar cada comando tal cual. Quiere aprobar «`cd`», no
  «`cd /ruta/exacta`», y pasar a `bypass` sin salir del run.
- No sabe qué modelo está usando; los selectores de modelo y esfuerzo son campos
  sueltos.
- Si no contesta una aprobación en 60 s, el agente recibe una negación y el run
  se cae.
- Las tools de Keel (`task_create`, `note_add`, la checklist) pasan sin que se
  note. Para ver qué hicieron tiene que salir del chat.
- Cuando el agente le preguntó con `AskUserQuestion`, la GUI lo trató como un
  permiso más («AskUserQuestion: aprobado»): no vio las opciones y el agente
  siguió sin su respuesta.
- Quiere la sugerencia de mensaje de Claude Code: texto fantasma en el input que
  se acepta con →.

Aportó además un documento de principios: **abstracción semántica por defecto,
inspección forense en un clic**. Una llamada a herramienta es una unidad de
intención con un resultado verificable, no una línea de log.

Lo que ya hay, medido el 2026-10-26:

- Cada `Edit` llega con `tool_input` (`old_string`, `new_string`) y
  `tool_response` (`originalFile`, `structuredPatch`). Basta para un diff
  unificado sin pedir nada nuevo al proveedor.
- Las tools de Keel llegan como `mcp__keel__*` y, además, como sus eventos de
  dominio (`work_item.created`, `note.added`).
- El Claude Agent SDK (0.3.295) ofrece en la `Query` `setPermissionMode()`,
  `setModel()`, `supportedModels()` (con `supportsEffort` y
  `supportedEffortLevels`), `interrupt()` y la opción `promptSuggestions` (un
  `prompt_suggestion` por turno, después del `result`).
- Durante una herramienta, el SDK de Claude sólo emite `tool_progress` con el
  tiempo transcurrido: **no hay stdout en vivo**. El App Server de Codex sí lo
  da (`item/commandExecution/outputDelta`).
- La espera de aprobación vence a los 60 s (`approval_timeout_ms`) y se resuelve
  como negación: el `deny-on-timeout` que ADR-0001 adopta de Mirador.

## Decisión

### 1. Tarjetas por intención

Cada tool call se dibuja según lo que es, con un resumen de una línea cerrado y
el detalle a un clic:

| Tipo                            | Cerrada                                           | Abierta                                      |
| ------------------------------- | ------------------------------------------------- | -------------------------------------------- |
| `Read`                          | archivo, rango de líneas, tamaño                  | contenido con números de línea               |
| `Edit`, `Write`, `NotebookEdit` | archivo y `+n −m`                                 | diff unificado con 3 líneas de contexto      |
| `Bash`                          | intención (la `description` del agente) y comando | comando, salida, código de salida y duración |
| `Grep`, `Glob`                  | qué buscaba y cuántas coincidencias               | resultados                                   |
| `mcp__keel__*`                  | la acción de dominio («creó KEEL-12»)             | la entidad, sin salir del chat               |
| otras MCP                       | servidor, tool y resumen                          | entrada y salida                             |
| subagentes (`Task`, `Agent`)    | tipo y descripción                                | sus tool calls anidadas                      |

Cuatro estados visibles: **pide permiso** (borde ámbar, acciones con teclado),
**corriendo** (tiempo transcurrido en vivo; con Codex, la última línea de
salida), **hecha** (se cierra sola) y **falló** (queda abierta con las últimas
líneas del error). Una acción de dominio de Keel entra con una animación breve y
enlaza a la entidad: abrirla no saca del chat.

La densidad la elige quien mira, y se guarda en su navegador:

- **Historia:** sólo el texto del agente y una línea por grupo de acciones.
- **Equilibrada:** la opción por defecto. Tarjetas cerradas con su resumen.
- **Cruda:** todas las tarjetas abiertas, con la entrada y la salida completas.

### 2. Aprobaciones en el chat, con alcance editable

La aprobación se resuelve en la tarjeta, sin ir al Inbox:

- **Esta vez.**
- **Este patrón en la sesión.**
- **Este patrón siempre en el proyecto.**

Keel propone el patrón (`patternFor`, ADR-0019 §4) y el humano lo puede corregir
antes de aprobar: de `cd /home/x/repo` a `cd *`. `approvals.resolve` acepta un
`pattern` opcional. El daemon lo rechaza si no cubre la operación pedida, y
sigue aplicando las reglas de `matchesPattern`: un prefijo nunca cubre un
comando con metacaracteres de shell. Teclado: `Y` aprueba esta vez y `N` niega.
Las otras opciones van con el ratón o con su atajo visible.

### 3. Una aprobación no vence

Supersede la adopción de `deny-on-timeout` en ADR-0001 (fila de ADR-0004 de
Mirador). Decisión del humano del 2026-10-26: «esperar sin límite».

- Sin respuesta, el run queda en `waiting_human` hasta que el humano decida o lo
  cancele. No consume tokens mientras espera.
- El principio que sí se conserva: **el tiempo nunca aprueba**. Si el humano
  fija un límite en Ajustes (`approvals.timeout_ms`, `null` por defecto), al
  vencer se niega.
- Un run esperando ocupa su lugar de concurrencia (ADR-0002 regla 5). La
  cabecera y el Inbox lo muestran como «esperando por ti».

### 4. Control en vivo: modo y modelo

- `runs.set_mode {run_id, permission_mode}` cambia el modo de un run vivo:
  - Claude lo aplica con `setPermissionMode()` en el turno en curso.
  - Codex, desde el turno siguiente.
- Pasar a `bypass` pide confirmación y se ve en rojo, como al arrancar.
- `runs.set_model {run_id, model, effort?}` usa `setModel()`.
- Cada cambio deja un evento `run.mode_changed` o `run.model_changed` con su
  actor.

### 5. Modelo y esfuerzo a la vista

- El compositor muestra el modelo y el esfuerzo vigentes: el modelo sale del
  `system/init` del run y el esfuerzo, del evento de la herramienta.
- Los selectores son una sola pastilla compacta, `Opus 5.5 · alto`, que abre la
  lista.
- La lista sale de `supportedModels()`: sólo los modelos y niveles que el SDK
  dice que existen para esa cuenta.
- `providers.models` la expone; el daemon la guarda en memoria por arranque.
- `RunOptions` gana `effort`.

### 6. Sugerencias de mensaje

- Decisión del humano del 2026-10-26: las genera Claude. El adaptador pasa
  `promptSuggestions: true` y guarda cada `prompt_suggestion` como evento del
  run.
- El input la muestra como texto fantasma; → o `Tab` la acepta, y escribir otra
  cosa la descarta.
- Cuestan tokens de la suscripción. Hay un ajuste de usuario para apagarlas
  (`claude.prompt_suggestions`, encendido por decisión del humano).
- Codex no tiene equivalente y no se inventa.

### 7. Las preguntas del agente se contestan en el chat

`AskUserQuestion` no es un permiso: es una pregunta. El SDK la pasa por
`canUseTool` y espera la respuesta en el mismo `allow`, como
`updatedInput.answers` (texto de la pregunta → etiqueta elegida; varias
separadas por coma si es `multiSelect`) y, si hay notas, `annotations`.

- La tarjeta muestra cada pregunta con su encabezado, sus opciones (con
  `preview` si la trae) y «Otra respuesta» con texto libre.
- `approvals.resolve` acepta `answers` y `annotations`. El daemon responde al
  SDK con `allow` y `updatedInput` = la entrada original más las respuestas.
  Aprobar sin respuestas no existe para esta herramienta.
- Nunca se resuelve sola: ni reglas `auto`, ni «siempre», ni `bypass`, ni
  vencimiento. Rechazarla le dice al agente que el humano no quiso contestar.
- `ExitPlanMode` sigue el mismo camino: el plan se muestra como documento, con
  «aprobar», «aprobar y cambiar a aceptar ediciones» y «seguir planeando» con
  una indicación.

### 8. El canvas primero

El diseño de esta superficie se hace en el canvas de pen.dev antes que en
código, en una página nueva («16 Run Chat»), por decisión del humano del
2026-10-26. Las capturas de la app real se comparan contra esa página.

## Criterios de aceptación

- Un `Edit` real muestra `+n −m` cerrado y el diff con contexto abierto.
- Aprobar `cd *` en la sesión deja pasar el siguiente `cd` a otra ruta sin
  preguntar, y no deja pasar `cd x && rm -rf y`.
- Una aprobación sin respuesta durante 10 minutos sigue esperando, y al
  aprobarla el run continúa.
- Cambiar a `bypass` a mitad de un run de Claude hace que la siguiente tool no
  pida permiso, y el evento queda con el actor humano.
- `task_create` desde el agente aparece en el chat como «creó KEEL-n» y se abre
  sin cambiar de pantalla.
- Una pregunta real de `AskUserQuestion` se ve con sus opciones; elegir una hace
  que el agente continúe con esa respuesta (visible en su siguiente mensaje).
- Tras un turno de Claude, el input ofrece una sugerencia que → acepta.
- Las tres densidades cambian lo visible sin recargar el run.

## Consecuencias

- La GUI necesita resaltado de sintaxis y diff. Se usan con lazy-load, como Vega
  (ADR-0014): dependencias nuevas del cliente, no del daemon.
- Sin vencimiento, un run puede quedarse días esperando con el lugar de
  concurrencia tomado. Por eso la espera tiene que verse.
- Cambiar el modo en vivo amplía lo que un humano puede soltar a mitad de run.
  El evento con actor lo hace auditable.
- Las sugerencias suman una llamada al modelo por turno.

## Alternativas consideradas

- **Límite largo configurable (30 min) por defecto.** El humano prefirió esperar
  sin límite. El límite queda como ajuste opcional.
- **Sugerencias locales sin modelo.** No gastan tokens, pero son genéricas. El
  humano eligió las de Claude.
- **Diseñar directo en código.** Itera más rápido, pero deja el canvas atrás. El
  humano eligió el canvas primero.
- **Stdout en vivo para Claude leyendo el transcript o envolviendo el comando.**
  Leer el transcript choca con ADR-0002 regla 2, y envolver el comando cambia lo
  que el agente ejecuta. No se hace; se muestra el tiempo transcurrido.
