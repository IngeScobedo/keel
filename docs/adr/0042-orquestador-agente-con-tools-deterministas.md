# ADR-0042: El orquestador es un agente; lo determinista son sus tools y las garantías de Keel

- **Estado:** Propuesto
- **Fecha:** 2026-10-30
- **Criticidad:** Alta
- **Relacionados:**
  - ADR-0036 (razonador de intake determinista): lo supersede. El pipeline sigue
    existiendo, pero como tools que el agente llama, no como quien decide.
  - ADR-0035 (el lote nace de un mensaje): quien parte el mensaje y propone el
    plan es el agente orquestador.
  - ADR-0024 (la conversación del proyecto): el orquestador es el agente de esa
    conversación.
  - ADR-0009 (tools de Keel por MCP), ADR-0021 (validación determinista de
    documentos), ADR-0022 (fronteras), ADR-0038 (gates), ADR-0039 (carriles).
  - ADR-0002, reglas 5 y 4 (límites bajos por defecto; costo con su
    `cost_kind`).

## Contexto

El humano (2026-10-30), al aceptar los ADRs 0035 a 0041:

> el razonador y el orquestador quiero que mejor sí sean agentes, y lo de código
> determinista sea código o tools que puedan ejecutar estos agentes […] que como
> Claude Code tal cual puedas comenzar con los agentes, pero que ellos mismos
> puedan correr código determinista y demás para no gastar tokens […] que
> tampoco se limite tanto Keel con lo determinista cuando podemos explotar más
> el harness haciendo algo híbrido.

ADR-0036 ponía el intake en un pipeline de reglas y llamaba a un agente sólo con
baja confianza. Tiene dos problemas:

- Partir un mensaje ambiguo, entender el alcance y ordenar el trabajo es
  criterio. Las reglas se quedan cortas justo ahí, y no hay nada útil hasta que
  maduran.
- Deja fuera lo que el harness ya hace bien: un agente con tools, contexto del
  repo y el método de Keel.

Lo que sigue valiendo de ADR-0036 y de la línea de ADR-0021 es que lo mecánico
no debe gastar tokens, y que las garantías no dependen del agente.

## Decisión

### 1. Tres capas

| Capa             | Quién                       | Qué hace                                                                                                          |
| ---------------- | --------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Criterio         | Agentes                     | Entender el pedido, partirlo, preguntar, ordenar, repartir carriles, conversar con el humano                      |
| Trabajo mecánico | Tools deterministas de Keel | Buscar anclas en el repo, validar el check de listo, calcular carriles, correr gates, generar changelog y reporte |
| Garantías        | El daemon, siempre          | Gate humano del plan, esquema de lo que se propone, máquina de estados, permisos, gates antes del merge           |

Un agente puede proponer cualquier plan. No puede arrancarlo sin el gate del
humano, marcar «listo» algo con huecos, mergear con gates sin pasar ni ratificar
nada.

### 2. El orquestador es el agente de la conversación

- Es un run del proveedor (Claude o Codex), como cualquier otro: se le escribe
  como a Claude Code.
- Sigue sin escribir en el repo (ADR-0024). Lo que hace, lo hace por tools de
  Keel.
- Su trabajo:
  - proponer el lote;
  - contestar y preguntar;
  - registrar decisiones, invariantes y correcciones;
  - repartir y seguir los carriles;
  - preparar el cierre del lote.
- Las subtareas las trabajan otros agentes, cada uno en su worktree con el
  método de ADR-0021.

### 3. Las tools de Keel para el orquestador

Todas por el puente MCP (ADR-0009). Las de lectura no gastan tokens del
proveedor más que su resultado, que Keel devuelve corto.

| Tool                                              | Determinista | Qué devuelve o hace                                                                             |
| ------------------------------------------------- | ------------ | ----------------------------------------------------------------------------------------------- |
| `intake_draft`                                    | sí           | Un primer corte del mensaje: segmentos, clase sugerida y anclas, con su confianza (ADR-0036 §2) |
| `repo_anchor`                                     | sí           | Rutas, componentes y entradas del glosario que coinciden con un texto                           |
| `ready_check`                                     | sí           | Objetivo, alcance y criterio de un intent; las preguntas de plantilla para lo que falta         |
| `quality_gaps`                                    | sí           | Lo que el perfil del proyecto exige y nadie pidió                                               |
| `lanes_compute`                                   | sí           | Carriles a partir de las fronteras (ADR-0039)                                                   |
| `plan_propose`                                    | —            | Crea el lote y su gate de plan; Keel valida el esquema y corre `ready_check` sobre cada intent  |
| `decision_add`, `invariant_add`, `assumption_add` | —            | Los objetos de ADR-0037, siempre en estado pendiente o provisional                              |
| `gate_run`, `batch_report`                        | sí           | Gates y reporte del lote (ADR-0038)                                                             |

- `intake_draft` es la forma de usar ADR-0036: una ayuda que el agente acepta,
  corrige o ignora.
- Lo que el agente propone pasa siempre por el esquema y por `ready_check`. Si
  un intent no cumple, la tarjeta de plan lo muestra con sus preguntas, diga lo
  que diga el agente.

### 4. Quién trabaja cada subtarea

- El orquestador propone para cada intent el perfil del agente que lo trabaja
  (proveedor, modelo y esfuerzo) según su clase y tamaño.
  - Por ejemplo: un modelo chico y esfuerzo bajo para `copy`; el modelo grande y
    esfuerzo alto para `design-proposal`.
- La tarjeta de plan lo muestra y el humano lo cambia.
- Lo acotan los límites del humano (ADR-0002, regla 5): modelos permitidos,
  presupuesto y concurrencia. El orquestador no puede subirlos.

### 5. El orquestador también gasta poco

- Su modelo y esfuerzo los elige el humano en Ajustes. Por defecto es el mismo
  que el de las tareas.
- Keel le da contexto compacto: el lote, los objetos pendientes y los resultados
  cortos de sus tools, nunca salidas crudas.

### 6. Composer en vivo

Los chips mientras escribes (ADR-0036 §4) los pone `intake_draft` en la GUI, sin
agente. Son una vista previa. Lo que cuenta es lo que propone el orquestador al
enviar.

## Spike antes de implementar

Con los mensajes literales de la sesión de Casa Matte y diez mensajes reales
más:

- el orquestador con sus tools contra el orquestador sin tools;
- medir tokens por mensaje, tiempo, intents correctos y preguntas por intent;
- también, cuánto de `intake_draft` acepta el agente sin cambios.

De ahí salen el modelo por defecto del orquestador y qué tools valen la pena.

## Criterios de aceptación

- El mensaje 1 del caso, escrito en la conversación, termina en un plan con los
  intents del research y el cierre de lote. Lo propone el orquestador; nada
  arranca sin el gate.
- Un intent que el agente marca listo sin criterio de aceptación aparece en la
  tarjeta con su pregunta, porque `ready_check` lo dice.
- El orquestador propone Haiku o Sonnet para un `copy` y Opus para un
  `design-proposal`. El humano los cambia en la tarjeta.
- Con el presupuesto agotado o un modelo no permitido, `plan_propose` lo rechaza
  y dice por qué.

## Consecuencias

- Hay algo útil desde el primer día: un agente que conversa y propone, mejorando
  a medida que crecen sus tools.
- El costo por mensaje depende del modelo del orquestador. Las tools lo bajan, y
  el spike lo mide.
- Las reglas de ADR-0036 se siguen escribiendo, pero como `intake_draft`, sin
  ser el camino crítico.

## Alternativas consideradas

- **Pipeline determinista con agente de respaldo (ADR-0036).** Es predecible,
  pero tiene poco alcance hasta que las reglas maduran, y no aprovecha el
  harness.
- **Agentes sin tools deterministas.** Gastan tokens en lo mecánico y no se
  pueden probar con tablas.
- **Que el agente también haga cumplir las reglas.** Un agente que puede saltar
  su propio gate no es un gate.
