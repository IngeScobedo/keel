# ADR-0027: Cerrar a mano una tarea, con su motivo y su evidencia

- **Estado:** Aceptado (2026-10-26)
- **Fecha:** 2026-10-26
- **Criticidad:** Media
- **Relacionados:**
  - ADR-0006 (lifecycle): suma aristas `human_close` hacia `done`; las demás no
    cambian.
  - SDD 01 §3 y principio 5 («sólo un actor humano autenticado lleva una tarea a
    `done`»; el cierre humano es «un comando aparte que adjunta razón y
    evidencia»).
  - ADR-0012 (evidencia con procedencia), ADR-0021 (el método), ADR-0022
    (subtareas).

## Contexto

El humano (2026-10-26), sobre KEEL-1, que se trabajó con el flujo anterior al
método y se cerró fuera de Keel con la PR #126 de Casa Matte:

> No me deja moverla que porque no tiene evidencia pero sabemos que esa task se
> trabajó cuando no estaba viendo esto. ¿Qué hago?

Lo que hay:

- `done` sólo se alcanza desde `needs_review` con autoridad `human_close`, y hoy
  sólo lo usa el plan de cierre aprobado (ADR-0015, ADR-0021).
- El comando de cierre humano que pide el SDD 01 no existe:
  `work_items.transition` rechaza `done`.
- Una tarea hecha fuera de Keel (una PR, un hotfix, trabajo de otra persona)
  queda viva para siempre en el tablero.

## Decisión

1. **Un comando de cierre humano**, `work_items.close`, sólo por la puerta
   humana. Pide:
   - el motivo, en texto;
   - la evidencia: un enlace (PR, commit, ticket) o un texto que diga dónde está
     el trabajo.

   La evidencia queda como `evidence` de la tarea con su procedencia (actor,
   fecha, «cerrada a mano»), y el evento `task.closed` lleva `manual: true`.

2. **Desde dónde se cierra.** `human_close` gana aristas hacia `done` desde
   `triage`, `planned`, `waiting_human`, `failed` y `needs_review`. Nunca con un
   run vivo: primero se detiene.
3. **Lo que no se cierra así:**
   - una feature con subtareas sin terminar (ADR-0022): se cierran las hijas
     primero;
   - una tarea del método en la etapa de cierre con un plan de git pendiente:
     ese plan es su cierre.
4. **En el tablero**, soltar una tarjeta en Done abre la confirmación con el
   motivo y la evidencia. En el detalle de la tarea, «Cerrar» hace lo mismo.

## Criterios de aceptación

- Una tarea en `planned` se cierra con motivo y enlace; queda `done`, la
  evidencia guarda el enlace y el evento dice quién la cerró a mano.
- Sin motivo o sin evidencia, el comando se rechaza.
- Un agente no puede cerrar una tarea.
- Con un run vivo, o una feature con hijas pendientes, se rechaza con el motivo.

## Consecuencias

- El tablero refleja el trabajo hecho fuera de Keel sin inventar runs ni
  revisiones.
- `done` deja de significar siempre «revisado en Keel»: la evidencia y el evento
  dicen cuál fue el caso.

## Alternativas consideradas

- **Archivar en vez de cerrar.** La tarea desaparece, pero no queda como
  terminada ni con su evidencia.
- **Trabajarla con «Trabajar» hasta el cierre.** Gasta un run y tokens en
  rehacer algo que ya está hecho.
