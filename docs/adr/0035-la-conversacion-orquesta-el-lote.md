# ADR-0035: La conversación orquesta: de un mensaje nace un lote

- **Estado:** Aceptado (2026-10-30)
- **Fecha:** 2026-10-30
- **Criticidad:** Alta
- **Relacionados:**
  - ADR-0024 (la conversación del proyecto): la extiende. De la conversación ya
    nacían tareas; ahora nace un lote con su plan.
  - ADR-0022 (tarea padre y subtareas): el lote **es** una feature. No hay
    entidad nueva.
  - ADR-0021 (el método): cada subtarea lo recorre con la ceremonia de su clase.
  - ADR-0036 (razonador de intake), ADR-0038 (gates), ADR-0041 (foco).
  - SDD `05-chat-to-orchestrate.md`; revisión
    `2026-10-30-chat-to-orchestrate.md`.

## Contexto

El humano (2026-10-29) hizo un research sobre una sesión real de Casa Matte: en
un mensaje pidió 8 cosas, corrigió una regla, ratificó decisiones y pidió gates
al final. Todo eso vivió en el scroll del agente y se perdió al cerrar la
terminal.

Lo que ya hay en Keel:

- La conversación del proyecto (ADR-0024) es una tarea oculta con runs de sólo
  lectura en la raíz. Las tareas nacen ahí cuando el agente llama `task_create`.
- Una feature (ADR-0022) es una tarea padre con su rama, subtareas con frontera
  y fase, integración a la rama de la feature y una revisión del padre al final.
- Las subtareas nacen del documento `tasks` cuando el humano aprueba el gate
  (b).

## Decisión

### 1. El lote es una feature que nace de un mensaje

- Cuando un mensaje a la conversación trae trabajo ejecutable (ADR-0036), Keel
  crea una **tarea padre** con rama de feature (ADR-0022). Su `origin` es el
  mensaje.
- El lote se identifica con la clave de esa tarea (`KEEL-24`). No hay ids `B-`.
- **Varias conversaciones por proyecto.** La de ADR-0024 deja de ser única. Cada
  una tiene título y lista sus lotes. La primera sigue existiendo y es la de
  siempre.

### 2. El plan es un gate, y se puede corregir antes de aprobarlo

- El razonador produce los intents como el documento `tasks` del lote, con su
  clave (`T1`…), su fase y su frontera.
- **La tarjeta de plan** muestra cada intent con:
  - su clase;
  - su carril y su orden;
  - su check de listo.
- **Sobre la tarjeta se puede, sin modal:**
  - renombrar;
  - unir y partir;
  - diferir (vuelve al backlog del proyecto con su procedencia).
- «Arrancar los listos» aprueba el gate. Nacen las subtareas de los intents
  listos con el mecanismo de ADR-0022. Los que tienen preguntas quedan en
  `triage` con ellas.

### 3. La ceremonia sale de la clase

| Clase del intent              | Ceremonia (ADR-0021) |
| ----------------------------- | -------------------- |
| `copy`, `ui-change`, `bugfix` | directa              |
| `feature`, `refactor`         | la decide el brief   |
| `design-proposal`, `research` | formal               |
| `docs`, `chore`               | directa              |
| `release`                     | al cierre del lote   |

El humano la puede cambiar en la tarjeta de plan.

### 4. Sin estados nuevos

El lote usa el lifecycle y las etapas que ya existen (ADR-0006, ADR-0021). La
tabla de mapeo está en la revisión del 2026-10-30, §2.

## Criterios de aceptación

- Un mensaje con tres pedidos ejecutables crea una tarea padre con rama de
  feature y un gate de plan con tres intents.
- Unir dos intents y partir uno cambia el plan antes de aprobar. Aprobar crea
  las subtareas, con su frontera y su fase.
- Un intent con preguntas no arranca: queda en `triage` con ellas.
- Una segunda conversación del proyecto tiene sus propios lotes.

## Consecuencias

- La conversación deja de ser sólo de consulta: puede proponer trabajo. El
  trabajo sigue arrancando sólo con el gate del humano.
- El tablero muestra el lote como la feature que es, con su avance.
- `conversation.*` del protocolo gana el plan y las conversaciones múltiples.

## Alternativas consideradas

- **Un "lote" como entidad aparte de la feature.** Duplicaría la rama, el
  avance, la integración y la revisión final que ADR-0022 ya resuelve.
- **Que el agente de la conversación cree las tareas** (como hoy con
  `task_create`). No hay plan visible ni corregible antes de que existan, y
  gasta tokens en lo mecánico.
