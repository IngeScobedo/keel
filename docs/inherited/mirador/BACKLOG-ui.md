# Backlog de UI — hallazgos de la revisión externa (2026-08-24)

Fuente: revisión externa de la UI hecha con Claude en Chrome sobre datos crudos.
Texto volcado íntegro; se anota qué se atacó ya y con qué commit. Lo pendiente
conserva la redacción original del informe.

**Atacado** (no está pendiente): F1, F2, F3 y A, B, C en `9b6a5b2`; el checkbox
de utilitarios con 0 y la leyenda/titles de los puntos de estado también en
`9b6a5b2`. El modelo de fondo (tres canales, árbol de tres niveles, runs por
actividad) es ADR-0010 (`eeba4a1`).

---

## 1. Fidelidad

### F1 — workflow-subagents colgados de root ✅ atacado (`9b6a5b2`)

> Los workflow-subagent se cuelgan de root cuando el canal transcript no dispara
> y cae al canal prompt, que no estaba restringido por `agent_type`. Regla dura
> añadida en core: un workflow-subagent nunca puede tener `parent_kind: agent`;
> si comparte `prompt_id` con otros workflow-subagents, todos van al mismo
> `wf_`. Evidencia (4 `SubagentStart` con prompt `9b3098ad…`, un solo tool call
> `Workflow` en root, a5015 arrancando 274 ms tras terminar a4f7c79c — firma de
> etapa siguiente de `pipeline()`) pineada en tests contra fixtures.

### F2 — StopFailure ignorado ✅ atacado (`9b6a5b2`)

> Agentes muertos por `rate_limit` se veían ámbar "en vuelo" con badge "N ok" y
> el header inferá timeout tapando la causa real. Ahora StopFailure es estado
> terminal con razón en agente y run, y cuando existe gana a la inferencia de
> timeout.

### F3 — duraciones falsas ✅ atacado (`9b6a5b2`)

> Se pintaba `raw.duration_ms` (dispatch interno): un AskUserQuestion de 27
> minutos reales aparecía como 2 ms. Ahora la duración principal es wall time
> Pre→cierre, `duration_ms` queda etiquetado como dispatch, y la espera humana
> se distingue.

### F4 — Las mismas entidades aparecen dos veces, sin relación entre sí — PENDIENTE

Dónde: run 08-20 22:39:36. En el árbol: `a490966717… Explore` y
`a4bbf20104… Explore`. Abajo: background tasks:
`subagent · a49096671… · cerrada`, `subagent · a4bbf2010… · cerrada`. Mismos
IDs, dos representaciones, cero enlace.

Igual en 08-24 15:49:21: 4 agentes worker con agent_type `arq-binding` /
`ing-back-binding` / `ing-admin-binding` / `rev-binding` colgados de root, y 4
chips `teammate · … · orphan`. Son los mismos 4 teammates. Esto además explica
los teammates eternamente orphan: viven en otra sesión, nunca van a cerrar aquí
— vale la pena decirlo en la UI en vez de dejarlos como si fuera un cierre
perdido.

### F5 — El tool call que lanzó al hijo no está conectado con el hijo — PENDIENTE

`Agent · ok · 24ms` en root y el nodo Explore de abajo no se enlazan, aunque el
backend ya lo sabe (`parent_source: launch`). Y el `tool_input` de ese Agent
trae `prompt`, `description` ("List files in packages/core") y `subagent_type` —
nada se usa como etiqueta del nodo. Igual con workflows: 3 tool calls `Workflow`
en root del run 08-21 21:17:53 y 3 nodos `wf_…`, sin forma de saber cuál produjo
cuál.

_(Nota post-informe: desde `9b6a5b2` la etiqueta del tool call sí usa
`subagent_type+description`; sigue pendiente el enlace navegable tool call ↔
nodo.)_

### F6 — gated se pega a más tool calls de las que hubo PermissionRequest ✅ atacado (post-informe)

Run 08-24 15:49:21: 1 evento PermissionRequest (AskUserQuestion, 16:11:37.213)
pero 2 tool calls marcados `gated_heuristic` (16:11:37 y 18:20:11). El pareo
ADR-008 parece ser por (agent, tool_name) sin ventana temporal. Global: 30
PermissionRequest → 31 gated.

_(Nota post-informe: al investigarlo con la partición de ADR-010, el caso citado
resultó tener DOS PermissionRequest legítimos (16:11 y 18:20) en el mismo run —
el "1 PR → 2 gated" era un artefacto de la partición vieja. Aun así el modo de
fallo existía (gates sin caducidad): implementada ventana temporal configurable
(default 15 min) en ambos sentidos del pareo y caducidad de gates, con tests. 31
PR ↔ 31 gated, 1:1.)_

### F7 — "abierto" no significa abierto ✅ atacado (post-informe)

Run 08-24 17:23:12 (8db77d9c): último evento a las 17:27, sigue diciendo
"abierto" 5 horas después. Los runs que sí tienen sucesor se cierran como
timeout/replaced. O sea "abierto" = "no llegó un run posterior de esta sesión",
no "vivo". En una herramienta que se presenta como live, esa es justo la señal
que uno necesita poder creer.

Hay un dato mejor sin usar: `SessionStart.source` vale startup / resume /
compact / fork (los cuatro están en el dataset).

_(Nota post-informe: `RunView.live` (abierto Y con eventos dentro de la ventana
de inactividad respecto al reloj inyectado) — la UI dice "en vivo" / "inactivo
desde X" en header y sidebar; `RunView.start_source` expuesto como chip "inicio:
resume/fork/…".)_

---

## 2. Qué falta que un usuario del CLI espera

### A — descripción del tool call ✅ atacado (`9b6a5b2`)

### B — resultado del tool call (incluido error completo) ✅ atacado (`9b6a5b2`)

### C — qué se le pidió al subagente y qué devolvió ✅ atacado (`9b6a5b2`)

### D — Modelo y effort ✅ atacado (post-informe)

`SessionStart.model` está en los datos: hay runs con `claude-opus-5[1m]` y otros
con `claude-fable-5`. Y `effort.level: xhigh` viene en casi todos los eventos.
No se ve en ningún lado.

_(Nota post-informe: `RunView.model` y `RunView.effort_level` (último
observado), chips en el header del run.)_

### E — Proyecto / cwd ✅ atacado en lo esencial (post-informe)

El sidebar agrupa por UUID de sesión y titula por timestamp. Hay dos proyectos
mezclados (casa-matte-monorepo y cc-ui) sin distinguirse. Hay `transcript_path`,
`cwd` y 47 eventos `CwdChanged`.

_(Nota post-informe: `RunView.project_slug` derivado del transcript (1:1 con
sesión) y sidebar agrupado proyecto → sesión → runs. Sigue pendiente de E:
exponer `cwd` por evento y los saltos `CwdChanged`.)_

### F — Turnos — PENDIENTE

No hay noción de prompt/turno. Un run de 2514 eventos con 4 `UserPromptSubmit`
se ve como una lista plana. En el CLI la unidad mental es el turno — y el primer
prompt es además el mejor título posible para el run.

### G — Paralelo vs secuencial — PENDIENTE

`PostToolBatch` es exactamente el límite de batch: qué llamadas salieron en el
mismo mensaje del assistant. En el run de smoke test se ve perfecto: dos Agent
PreToolUse a 42.921 y 43.359 + un PostToolBatch a 43.628 — eran paralelos (el
prompt lo pedía explícito), y la UI los muestra secuenciales. Se ingiere y no se
aprovecha.

### H — Fases y labels de workflow — PENDIENTE

`wf_3361f579-415` muestra 8 subagentes indistinguibles (17 ok, 20 ok, 38 ok…).
Un workflow real tiene fases y labels por agente; sin eso no se puede leer la
forma del fan-out.

### I — Timestamps en los nodos de agente — PENDIENTE

El nodo root tiene rango; los nodos de agente no tienen ni inicio ni duración.
Con 17 subagentes no hay manera de ver solapamiento.

### J — Compactación — PENDIENTE

El run 08-24 17:23:12 dice `compacts: 1` y nada más. `PreCompact.trigger` dice
manual vs auto (ese fue manual) y hay un `SessionStart` con `source: compact`.
Tampoco hay navegación al `previous_run_id`.

### K — Slash commands e instrucciones — PENDIENTE

`UserPromptExpansion` (`command_name: design`, `command_source: bundled`) e
`InstructionsLoaded` (35 eventos con `memory_type` / `load_reason` /
`file_path`). Muy específico de CC, hoy solo visible como fila cruda.

### L — Búsqueda — PENDIENTE

No hay ni un `<input>` en toda la app. Con 810 tool calls no se puede buscar
"qué agente corrió bun test" ni filtrar por fallos.

---

## 3. Qué sobra o confunde — PENDIENTE (completo)

- El timeline como log crudo. Un Bash = 3 filas (Pre / Post / Batch). 2514
  eventos ≈ 2400 filas para ~810 acciones. Colapsar Pre+Post en una fila y usar
  PostToolBatch como agrupador (no como fila) quita ~60% sin perder información.
- Runs administrativos. ~12 runs de 1–6 eventos y 0 calls ocupan lo mismo en el
  sidebar que uno de 2514. Ya vienen marcados `administrative: true`.
- ~~Checkbox "mostrar 0 agentes utilitarios"~~ ✅ atacado (`9b6a5b2`).
- IDs truncados como identidad primaria (`a4f7c79c99…`, `wf_c1019156-6cd`). No
  son accionables; el label/descripción sí.
- Columna vacía entre el punto de estado y el nombre del tool.
- ~~Ámbar vs verde sin leyenda / dots sin title~~ ✅ atacado (`9b6a5b2`).

---

## 4. Usabilidad — PENDIENTE (completo)

- Sin URL por run. Recargar pierde el run seleccionado (pasó a mitad de la
  revisión) y no se puede compartir un link a un run o un agente.
- Timeline arranca en el evento 1 con "cargar mas (200 cargados)" y sin total.
  Para un run vivo lo interesante es el final: son 13 clicks para llegar. Falta
  "ir al final" / follow. (Confirmado que no trunca silenciosamente — la API
  acepta cursor `after=` y el botón funciona. No es bug.)
- Sidebar y árbol no cuadran: el run dice "10 ag" y el árbol muestra 5, por el
  filtro de utilitarios, sin explicarlo.

---

## Lo que NO se toca (acierto declarado por la revisión)

Los tooltips de procedencia del padre — "padre por agent_transcript_path
(certeza, ADR-010 canal 1)" vs "por (session, prompt_id) + orden (heurística,
canal 3)" — y el badge gated con "PermissionRequest emparejado por heurística
(ADR-008)". Ahí es donde se nota que la herramienta sabe de qué está hablando, y
fue lo que permitió diagnosticar F1 en dos minutos. Más de eso, no menos.
