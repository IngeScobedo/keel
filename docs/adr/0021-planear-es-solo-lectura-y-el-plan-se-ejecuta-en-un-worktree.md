# ADR-0021: Planear es sólo lectura; el plan aprobado se ejecuta en un worktree

- **Estado:** Propuesto
- **Fecha:** 2026-10-26
- **Criticidad:** Alta
- **Relacionados:** ADR-0019 §3–§4 (conversación y modos; este ADR lo supersede
  en los modos de un run que no ejecuta), ADR-0010 (espacios de trabajo),
  ADR-0018 (aislamiento), ADR-0020 §7 (`ExitPlanMode`), ADR-0006 (lifecycle)

## Contexto

El humano trabajó KEEL-1 desde la GUI el 2026-10-26:

- Arrancó con «Planear» y siguió la conversación tres veces. Fueron 4 runs
  `plan`, uno hijo del anterior.
- Un run `plan` trabaja en la raíz del repo, sin worktree, y deja la tarea en
  `triage`.
- ADR-0019 deja que un run que no ejecuta use el modo `ask`. En ese modo una
  edición o un comando se aprueban uno por uno.
- El humano aprobó ediciones y comandos (compilar, regenerar el SDK, pruebas)
  creyendo que ya implementaba.
- Resultado: el fix quedó aplicado directo sobre su checkout, en `main`, sin
  worktree. La tarea nunca pasó a `running` y nada en la GUI dijo que estaba
  fuera de la ruta de ejecución.

Lo que ya hay, medido el 2026-10-26:

- Codex ya planea en sólo lectura: un run que no ejecuta abre su sandbox
  `read-only` (`codex.ts`, `executeAppServer`).
- Claude Code no llama a `canUseTool` para lo que considera de sólo lectura. Un
  `echo` corrió sin preguntar; un `touch` sí preguntó. Corrida real con `claude`
  2.1.310, en `docs/reviews/2026-10-26-chat-de-foco-implementado.md`.
- Continuar un run retoma la sesión del proveedor sólo si el hijo trabaja en la
  misma carpeta; si no, el daemon emite `run.resume_skipped` (`resumeOf`). Un
  plan corre en la raíz y su ejecución en un worktree: la sesión no se puede
  retomar.
- `ExitPlanMode` ya se muestra como plan, con «aprobar» y «seguir planeando»
  (ADR-0020 §7).

## Decisión

### 1. Un run que no ejecuta es de sólo lectura

Aplica a los propósitos `plan` y `triage_eval`, sea cual sea el modo pedido.

- **Claude:** Keel lo lanza en el modo `plan` del SDK.
  - Lo que Claude Code considera de sólo lectura corre sin preguntar.
  - Lo que llegue al gate de Keel se niega sin preguntar al humano. El mensaje
    dice al agente que es un run de planeación y que proponga el plan con
    `ExitPlanMode`.
  - Las únicas excepciones son las preguntas: `AskUserQuestion` y
    `ExitPlanMode`.
- **Codex:** sigue con el sandbox `read-only`. Su gate tampoco aprueba ediciones
  ni comandos en estos runs.
- **Modo:** `runs.start` y `runs.continue` aceptan sólo `plan` para estos
  propósitos. `runs.set_mode` no lo cambia.
- **Supersede:** ADR-0019 §4 en este punto, donde decía que estos runs admiten
  `ask` o `plan`.
- **En la GUI:** la cabecera del run dice «Planeación · sólo lectura» y la
  pastilla de modo queda fija.

### 2. «Ejecutar este plan»

El plan aprobado pasa a un run `execute` en un worktree, sin pasos a mano.

- **De dónde sale el plan:**
  - Si el agente llama a `ExitPlanMode`, su tarjeta ofrece «Ejecutar este plan»,
    «Seguir planeando» con una indicación, y nada más. Aprobar un plan nunca
    convierte el run de planeación en uno que edita.
  - Si el run de planeación terminó sin `ExitPlanMode`, el chat ofrece el mismo
    botón con el último mensaje del agente como plan.
  - En los dos casos el humano ve el plan y lo puede editar antes de lanzar.
- **Método:** `runs.execute_plan { run_id, plan_markdown, options? }`, sólo
  humano. En una sola operación:
  1. Si el plan venía de `ExitPlanMode`, la resuelve como negada. Mensaje: «el
     plan pasa a un run de ejecución». El run de planeación termina solo.
  2. Pasa la tarea de `triage` a `planned` con autoridad humana (arista
     existente de ADR-0006).
  3. Guarda el plan como nota de la tarea, «Plan aprobado», con el actor humano.
  4. Arranca un run `execute` hijo del de planeación (`parent_run_id`), con las
     mismas reglas que `runs.start`: elegibilidad, bloqueos, límites, worktree.
- **Instrucción del run:** el plan aprobado, con el encabezado de Keel (ADR-0017
  §1). No intenta retomar la sesión del proveedor: la carpeta cambia y el plan
  escrito es el contrato.
- **Opciones:** modelo, esfuerzo y modo, por defecto los del run de planeación.
  `ask` si venía de `plan`.
- **En la GUI:** el chat sigue mostrando la cadena como una conversación, con el
  divisor «El plan pasa a ejecución · worktree `keel/KEEL-n/...`».

### 3. Continuar sigue en el mismo propósito

`runs.continue` de un run de planeación sigue siendo de planeación y de sólo
lectura. Para cambiar el repo el camino es «Ejecutar este plan» o «Ejecutar»
desde la tarea.

## Criterios de aceptación

- **Sólo lectura:** en un run `plan` de Claude, un `Edit` y un `touch` se niegan
  sin pedir nada al humano, y `git status` del repo queda limpio. Una lectura o
  un `git log` corren.
- **Modo fijo:** `runs.start` con `purpose: plan` y `permission_mode: ask` se
  rechaza. `runs.set_mode` sobre un run `plan` se rechaza.
- **Desde `ExitPlanMode`:** «Ejecutar este plan» produce, en este orden, la
  tarea en `planned` y luego en `running`, un worktree nuevo, y un run `execute`
  hijo cuya instrucción es el plan. El run de planeación termina y la nota «Plan
  aprobado» queda en la tarea con el actor humano.
- **Sin `ExitPlanMode`:** un run de planeación que terminó así ofrece el botón
  con su último mensaje. Editarlo antes de lanzar cambia la instrucción del run.
- **Codex:** un run `plan` de Codex sigue en `read-only` y ofrece el botón al
  terminar.

## Consecuencias

- En la planeación el agente no puede correr pruebas ni compilar si Claude Code
  no los considera de sólo lectura. Verificar es trabajo del run de ejecución.
- La conversación de planeación no viaja como sesión al worktree. Viaja el plan
  aprobado, que queda además como nota auditable de la tarea.
- Lo que ya se editó en la raíz del repo con runs de planeación anteriores no se
  mueve solo. El humano lo revisa con `git status` en su checkout.

## Alternativas consideradas

- **Dejar `ask` en planeación con un aviso de «sin worktree».** Mantiene el
  error que motivó este ADR: aprobar cambios fuera del aislamiento.
- **Sólo lectura, sin botón.** Implementar obligaría a volver a la tarea y
  empezar una conversación nueva. El humano eligió el botón.
- **Retomar la sesión del plan dentro del worktree.** El proveedor busca la
  sesión por carpeta (`resumeOf`); no se puede sin copiar archivos de sesión,
  que ADR-0002 regla 2 prohíbe tocar.
