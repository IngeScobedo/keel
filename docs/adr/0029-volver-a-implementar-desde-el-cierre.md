# ADR-0029: Volver a implementar desde el cierre, y el cierre sólo escribe el canon

- **Estado:** Aceptado (2026-10-28)
- **Fecha:** 2026-10-26
- **Criticidad:** Media
- **Relacionados:**
  - ADR-0021 §2 (etapas): supersede la tabla de pasos legales en un punto, el
    agente puede ir de `close` a `implement`, y precisa «escribe en el repo: por
    plan» de `close`.
  - ADR-0021 §3 (sólo lectura), ADR-0015 (plan de git), ADR-0019 (reglas del
    gate).
  - ADR-0030 (el navegador del agente): probar en el navegador es parte de
    `review`.

## Contexto

En KEEL-2, ya con el QA aprobado y la tarea en `close`, el humano le pidió al
agente probar en el navegador. El agente encontró un problema y dijo:

> Keel no permite volver de close a implement. Como close no es de sólo lectura,
> hago el arreglo aquí y lo verifico igual (tests, verify_run y de nuevo en el
> navegador).

El humano (2026-10-26):

> es lo que hizo el agente después de pasar el QA; le dije que probara en el
> navegador y encontró algún tema, quiero pensar

Lo que hay:

- `stageMove` (core) deja al agente volver de `review` a `implement` (un FAIL),
  pero no de `close` a `implement`.
- `stages.return` existe, pero sólo para el humano.
- `close` no es de sólo lectura: el gate deja editar cualquier archivo del
  worktree. ADR-0021 §2 decía «escribe en el repo: por plan», pensando en el
  canon y el plan de git, no en el código.
- Lo que se arregla en `close` no pasa por `review`: el QA aprobado ya no
  describe lo que se integra.

## Decisión

1. **El agente puede volver de `close` a `implement`** con `stage_advance`, como
   un FAIL de la revisión.
   - Pide el motivo: el hallazgo, en una línea. Va en `task.stage_changed` y en
     el chat.
   - Sin gate humano: volver atrás no integra nada.
   - El plan de git pendiente, si lo hay, vence.
   - El lifecycle vuelve a `running` y la tarjeta, a In progress.
2. **Después de volver, hay que revisar otra vez.** `review → close` exige un
   `qa` guardado después de la última entrada a `implement`. El QA anterior
   queda en el historial de la tarea.
3. **`close` sólo escribe el canon del proyecto.** El gate de Keel niega, sin
   preguntar, editar fuera de:
   - `canon.adr_dirs`, `canon.sdd_dirs` y `canon.roadmap` del perfil (ADR-0021
     §5);
   - los documentos de la tarea, que van por `task_doc_put`.

   El mensaje de la negación le dice al agente cómo volver: «para cambiar
   código, vuelve a implement con stage_advance y el motivo». Los comandos de
   sólo lectura, `verify_run` y las tools del navegador (ADR-0030) siguen
   permitidos.

4. **Probar en el navegador es de `review`.** Las instrucciones de la etapa lo
   dicen. Si el humano lo pide en `close` y aparece un problema, el agente
   vuelve a `implement`.

## Criterios de aceptación

- En `close`, el agente llama `stage_advance` a `implement` con un motivo: la
  tarea queda en `implement` y `running`, el plan pendiente vence y el chat
  muestra el motivo.
- Sin motivo, se rechaza.
- En `close`, editar `src/x.ts` se niega con el mensaje de cómo volver; editar
  un ADR en `canon.adr_dirs` se permite.
- Tras volver, `review → close` con el QA viejo se rechaza; con uno nuevo, pasa.

## Consecuencias

- Lo que se integra siempre pasó por `review`.
- Un hallazgo tardío cuesta una vuelta por `implement` y `review` en vez de un
  arreglo directo.
- El perfil del proyecto debe tener bien sus rutas de canon. Si están vacías,
  `close` no puede escribir nada fuera de los documentos de la tarea.

## Alternativas consideradas

- **Dejar `close` como está.** Es más rápido, pero el QA deja de describir lo
  que se integra.
- **Que sólo el humano devuelva la tarea.** Ya existe y el agente no lo sabía
  usar. Además, obliga al humano a mediar un paso que el agente puede justificar
  solo.
- **Volver de `close` a `review`.** Sirve para revisar otra vez, pero el arreglo
  necesita escribir código, y `review` es de sólo lectura.
