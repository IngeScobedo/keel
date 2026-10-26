# ADR-0022: Tarea padre y subtareas: una feature es un árbol de tareas con su rama

- **Estado:** Aceptado (2026-10-26)
- **Fecha:** 2026-10-26
- **Criticidad:** Alta
- **Relacionados:**
  - ADR-0021 §7 (este ADR cumple lo que dejó pendiente).
  - ADR-0006 (lifecycle y bloqueos).
  - ADR-0010 (espacios de trabajo).
  - ADR-0015 (git con plan).
  - ADR-0002 regla 5 (concurrencia baja por defecto).
  - SDD 02 §4 «Git y lanes».
  - SDD 03 (`work_items.parent_work_item_id`, `work_item_dependencies`).
  - SDD 04 Fase 2.

## Contexto

El humano trabaja features que son 20 o 40 tareas (2026-10-26):

> si tiene un feature enorme pues normalmente se hacen tareas más pequeñas pero
> se está trabajando en esa feature […] me gustaría que cada cosa tenga su task
> o subtask de la tarea padre, y que esto sea inteligente.

Quiere que el agente diga por dónde empezar, que cada subtarea tenga sus runs y
que un compañero pueda tomar cualquiera.

Lo que ya hay:

- **El método de ADR-0021.** El diseño del ciclo formal produce un documento
  `tasks`: una línea por frontera de archivos, ligada a un requisito de la spec.
  Las fronteras son disjuntas y Keel lo valida.
- **El modelo de datos de la Fase 0** tiene `work_items.parent_work_item_id` y
  `work_item_dependencies` (con `required_lifecycle`), pero ningún código los
  usa. Los bloqueos (`work_item_blocks`) ya explican su causa.
- **La rama de la feature.** El humano eligió una rama de la feature y un
  worktree por subtarea que se integra a ella (2026-10-26).
- **Paralelismo.** El scheduler con locks por glob es de la Fase 2. Hoy la
  concurrencia por defecto es 1 (ADR-0002 regla 5).

## Decisión

### 1. Las subtareas nacen del diseño aprobado

Al aprobar el gate (b) de una tarea del ciclo formal, su documento `tasks` se
convierte en subtareas. El mecanismo es determinista: Keel lee el documento, no
el agente.

- **Una línea `- [ ] … → frontera … → R…` es una subtarea.**
  - Título: el texto de la línea.
  - Frontera: sus globs.
  - Requisitos: los `R<n>` que cita.
- **Las fases son secciones `## Fase N — …`.** Una subtarea de la fase N depende
  de las de la fase N−1 (`work_item_dependencies`). Una dependencia explícita
  («después de T3») se suma.
- **La tarjeta del gate (b) muestra el árbol que va a nacer**: fases, subtareas,
  fronteras y dependencias. Aprobar el contrato aprueba también ese árbol. Si
  `tasks` tiene una sola línea, no hay subtareas: la tarea sigue sola.
- **Cada subtarea nace en `planned`**, con su flujo ya en `implement` y la
  ceremonia del padre:
  - el contrato y la spec son los del padre (congelados);
  - su `story` la escribe el agente del padre con la skill `story` antes de
    pedir el gate, o se genera de su línea, los escenarios citados y el
    contrato;
  - no repiten brief ni diseño.
- **Dos niveles:** feature y subtareas. Una subtarea que resulte grande vuelve
  al padre como cambio de diseño, no crece hacia abajo.

Las tareas que el agente crea fuera del plan, como un hallazgo o un issue de
seguridad, siguen naciendo en `triage` con `task_create`. Quedan ligadas a su
origen, pero no son hijas.

### 2. Ramas: la de la feature y una por subtarea

- **La rama del padre.** Al aprobar el gate (b), Keel crea la rama de la feature
  desde la base del proyecto, con el prefijo del perfil:
  `feat/KEEL-12-capitulos`.
- **La rama de cada subtarea.** Cada subtarea trabaja en su worktree, en una
  rama que sale de la punta de la rama de la feature cuando arranca.
- **Integrar una subtarea es su cierre.** Su plan de git integra su rama en la
  de la feature, nunca en la rama principal.
- **Integración automática.** El humano decide en el gate (b) si las subtareas
  se integran solas cuando cumplen tres condiciones que Keel comprueba con
  código:
  - QA PASS;
  - verificación sin rojo nuevo;
  - un diff que sólo toca su frontera.

  Si no las cumplen, o si el humano no lo eligió, la integración se le pregunta
  como cualquier plan de git.

- **Conflicto al integrar.** La subtarea vuelve a `implement` con el conflicto
  descrito. Que se repita en el mismo archivo es señal de fronteras mal puestas:
  Keel lo marca en el padre.

### 3. Orden y concurrencia

- **Lista para empezar.** Una subtarea está lista cuando sus dependencias se
  cumplen.
- **Arranque automático.** Al integrarse una, Keel arranca la siguiente lista,
  si la feature está en curso y hay lugar de concurrencia. El humano no elige el
  orden, aunque puede pausar la feature o tomar una subtarea a mano.
- **Una a la vez por defecto** (ADR-0002 regla 5).
  - Varias en paralelo exigen el scheduler de la Fase 2, con locks por frontera.
  - Las fronteras ya llegan disjuntas desde el diseño, pero el lock es la
    garantía.
  - Subir la concurrencia es una acción explícita del humano.
- **Cualquiera toma una subtarea.** Otro agente, otro proveedor o un compañero
  la trabaja con «Trabajar» como cualquier tarea. Su contexto está en su story,
  no en la conversación del padre.

### 4. El padre mientras trabajan las hijas

- **Esperando a las hijas.** El padre queda `blocked` por dependencia de sus
  hijas: el bloqueo dice «12/40 subtareas». No tiene run vivo.
- **Revisión de la feature.** Cuando todas se integran, el padre vuelve a
  `planned` y Keel abre su run en `review`:
  - verificación completa sobre la rama de la feature;
  - QA de la feature contra la spec entera.
- **Cierre del padre:** canon, PR de la feature a la rama principal y gate (c)
  humano.
- **Lectura entre tareas.** El agente de una subtarea puede leer los documentos
  del padre y de sus hermanas (`task_doc_get` con `work_item_id`), pero sólo
  escribe los suyos.

### 5. Lo que se ve

- **En el tablero,** el padre lleva el avance (integradas, en curso, bloqueadas)
  y la fase actual. Sus hijas se pliegan bajo él.
- **En el detalle del padre** se ve el plan por fases, con el estado de cada
  subtarea, y se puede abrir cualquiera.
- **En el chat del padre,** una línea por subtarea que nace, se integra o
  vuelve. El detalle vive en el chat de cada una.

El diseño visual se hace primero en el canvas, en la página «17 Feature y
subtareas».

### 6. Costo

- **Lo que recibe cada run de una subtarea:** su story, el contrato, la
  conversación de su propia tarea y el encabezado de Keel. No recibe la
  conversación del padre.
- **Lo que hace Keel con código:**
  - leer `tasks` y crear las subtareas con sus dependencias;
  - comprobar las condiciones de la integración automática;
  - elegir la siguiente subtarea.

## Criterios de aceptación

- **Nacimiento.** Un diseño aprobado con `tasks` de 3 fases y 7 líneas crea 7
  subtareas en `planned`, con sus fronteras y las dependencias entre fases. El
  padre queda `blocked` con «0/7».
- **Ramas.** La primera subtarea trabaja en una rama que sale de la rama de la
  feature. Al cerrarla, sus commits quedan en la rama de la feature y no en
  `main`.
- **Integración automática.** Con integración automática elegida, una subtarea
  con QA PASS, sin rojo nuevo y con diff dentro de su frontera se integra sin
  preguntar. Si toca un archivo fuera de su frontera, se pregunta.
- **Orden.** Al integrarse la última subtarea de la fase 1, arranca sola la
  primera de la fase 2.
- **Cierre de la feature.** Integradas todas, el padre abre su revisión. Su
  cierre propone la PR de la feature.
- **Cualquiera la toma.** Una subtarea se puede trabajar con Codex mientras el
  padre usa Claude.

## Consecuencias

- Las subtareas no repiten brief ni diseño: el gasto de planear se paga una vez
  en el padre.
- Una feature grande puede quedar días en `blocked`. La tarjeta tiene que decir
  claramente que es avance, no un problema.
- La integración automática quita aprobaciones al humano. Por eso son tres
  condiciones verificadas con código y la elige el humano en el gate (b).
- `parent_work_item_id` y `work_item_dependencies` empiezan a usarse; no hay
  migración de esquema.

## Alternativas consideradas

- **Todas las subtareas en la misma rama y el mismo worktree.** Es más simple,
  pero impide paralelizar y mezcla los diffs. El humano eligió una rama por
  subtarea.
- **Que el agente cree las subtareas con una tool, una por una.** Gasta tokens y
  puede no coincidir con el documento que el humano aprobó. Leer `tasks` con
  código garantiza que nace lo aprobado.
- **El padre como etiqueta en vez de tarea.** No tendría brief, diseño, gate ni
  cierre propios, y la feature quedaría sin dueño.
