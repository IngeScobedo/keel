# ADR-0024: La conversación del proyecto: consultas sin tarea, de donde nacen tareas

- **Estado:** Propuesto
- **Fecha:** 2026-10-26
- **Criticidad:** Media
- **Relacionados:**
  - ADR-0021 §7 (este ADR cumple lo que dejó pendiente).
  - ADR-0009 (tools del agente).
  - ADR-0016 (investigaciones).
  - ADR-0017 (contexto y búsqueda).
  - ADR-0019 §2–§3 (proyectos y conversación con el run).
  - ADR-0020 (chat del run).

## Contexto

El humano (2026-10-26):

> a veces querré sólo hacer alguna consulta de código o algún research y puede
> que de ese research se encuentren cosas que me gustaría que sí se considere
> como un task a crear y trabajar o algún issue de seguridad, etc., el agente
> pueda crear una tarea nueva de cero que luego pueda continuar el mismo agente
> o yo iniciar el proceso de la tarea en automático.

Eligió una conversación de sólo lectura por proyecto, sin tarea, desde la que el
agente propone tareas (2026-10-26).

Lo que ya hay:

- **Un run siempre pertenece a una tarea** (`runs.work_item_id NOT NULL`), y el
  chat, la cadena de runs, los permisos y el costo se apoyan en eso.
- **`work_items.kind`** tiene un `CHECK` con seis tipos. Añadir uno exige
  reconstruir la tabla.
- **El agente ya crea tareas en `triage`** con `task_create`, y `context_search`
  busca en tareas, notas, evidencia e investigaciones (ADR-0017).
- **Los runs que no ejecutan** son de sólo lectura (ADR-0021 §3).

## Decisión

### 1. Una conversación por proyecto, sobre una tarea oculta

- **La tarea oculta.** Cada proyecto tiene una tarea que no aparece en el
  tablero ni en las listas: tipo `research`, `dedupe_key = "keel:conversation"`
  y `display_id` `CHAT`. Keel la crea la primera vez que se usa.
- **Sus runs** son `plan`: sólo lectura, en la raíz del proyecto, con el harness
  del proyecto y el plugin del método. No toca el repo ni abre worktree.
- **Una sola cadena.** La conversación es la cadena de runs de esa tarea, y el
  chat es el mismo de ADR-0020: tarjetas, densidades, modelo y modo a la vista.
- **«Nueva conversación»** empieza una cadena sin padre: la sesión anterior no
  se arrastra y el contexto no crece sin límite.

No hay cambio de esquema: es una fila de `work_items` con su marca.

### 2. De la conversación nacen tareas

- **`task_create` gana campos:**
  - `priority`, para que un issue de seguridad nazca `urgent`;
  - `context_markdown`, que pasa a ser la especificación de la tarea. Ahí el
    agente deja lo que encontró: archivos, evidencia y por qué importa.
- **Origen.** Cada tarea que nace de la conversación queda ligada a ella, con
  una nota «Nació de la conversación del proyecto» y la referencia al run.
- **En el chat,** la tarea creada aparece como tarjeta de Keel (ADR-0020 §1) con
  dos acciones:
  - **«Trabajar»:** empieza su método (ADR-0021) con la especificación que dejó
    el agente. Ése es el traspaso de contexto: la sesión de la conversación no
    viaja a la tarea, viaja lo que el agente escribió.
  - **«Abrir»:** la tarea al lado del chat, para revisarla o editarla antes.
- **Lo que vale guardar sin ser tarea** (una respuesta útil, un hallazgo) queda
  como nota de la conversación con `note_add`. `context_search` la encuentra
  después, en esta conversación o en cualquier tarea del proyecto.
- **Una pregunta que necesita evidencia** y estado (hipótesis, hallazgos,
  conclusiones) se convierte en una tarea `research` (ADR-0016).

### 3. Dónde está

- La barra lateral tiene «Conversación» por proyecto, arriba del tablero.
- La paleta de comandos (⌘K) acepta «preguntar al proyecto…» y abre la
  conversación con la pregunta.
- Con varios proyectos abiertos, cada uno tiene la suya. Una vista que reúna
  todos los proyectos queda para otro ADR.

El diseño visual se hace primero en el canvas, en la página «18 Conversación del
proyecto», junto con el formulario de `setup_request` de ADR-0023.

### 4. Costo

- **El modelo** se elige en la pastilla del compositor; por defecto, el del
  perfil.
- **El contexto** sale de `context_search` y de los recursos de Keel, no de leer
  el repo entero en cada turno.
- **Las respuestas largas** se guardan como nota: la siguiente pregunta no las
  repite.

## Criterios de aceptación

- **La tarea oculta.** Abrir «Conversación» la primera vez crea la tarea oculta
  y arranca un run `plan` en la raíz. La tarea no aparece en el tablero, en
  `work_items.list` ni en el Inbox.
- **Sólo lectura.** Un `Edit` en la conversación se niega sin preguntar.
- **Una tarea nueva.** El agente que encuentra un problema crea una tarea
  `urgent` con su contexto. La tarjeta aparece en el chat y «Trabajar» abre su
  brief con esa especificación.
- **Notas que se reutilizan.** Una nota guardada en la conversación aparece al
  buscar con `context_search` desde otra tarea.
- **Nueva conversación.** «Nueva conversación» arranca un run sin
  `parent_run_id` ni sesión anterior.

## Consecuencias

- La tarea oculta consume un `display_id` propio (`CHAT`) por proyecto. Las
  listas y el tablero la filtran por su `dedupe_key`.
- El costo de la conversación queda en esa tarea: se ve como cualquier otro.
- Las consultas sueltas dejan rastro (runs y notas) sin llenar el tablero.

## Alternativas consideradas

- **Toda consulta crea una tarea `research`.** Queda todo rastreado, pero el
  tablero se llena de preguntas. El humano eligió la conversación.
- **Runs sin tarea.** Habría que hacer nullable `runs.work_item_id` y revisar
  límites, costo, chat y permisos, que dependen de la tarea. La tarea oculta da
  lo mismo sin tocar el esquema.
- **Un tipo `conversation` en `work_items.kind`.** Es más explícito, pero exige
  reconstruir `work_items`. La marca en `dedupe_key` basta.
