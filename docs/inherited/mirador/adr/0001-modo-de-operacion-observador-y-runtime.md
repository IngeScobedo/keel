# ADR-001: Modo de operación — observador primero, runtime detrás de un adaptador

> **Nota (2026-08-24, evidencia de Fase 1 — ver ADR-008):** la fila «Texto
> completo del assistant» de la tabla de fidelidad mejora menos de lo esperado:
> `MessageDisplay` existe pero son chunks de streaming (`delta` + `index` +
> `final`) que hay que reensamblar por `message_id` (457 eventos, 199 message_id
> en los fixtures), **no trae `agent_id`** — sólo texto del agente principal — y
> expone un `turn_id` que no aparece en ningún otro evento. La decisión de este
> ADR no cambia.

- **Estado:** Aceptado
- **Fecha:** 2026-08-20
- **Decide:** arquitectura base
- **Relacionados:** ADR-002 (envelope), ADR-003 (correlación)

## Contexto

Hay dos maneras de obtener datos de una ejecución de Claude Code:

1. **Observador.** El usuario corre su CLI de siempre. Nosotros recibimos
   eventos vía hooks (`settings.json`), leemos los transcripts JSONL de
   `~/.claude/projects/` y opcionalmente consumimos spans OTel.
2. **Runtime.** Nosotros invocamos el Agent SDK desde nuestro proceso. Los hooks
   son callbacks in-process y tenemos el stream completo de mensajes
   (`stream-json`).

El runtime da más fidelidad (mensajes completos, control total del loop,
permisos programáticos sin depender de exit codes). El observador da adopción:
funciona sobre el flujo de trabajo que la persona ya tiene, sin pedirle que
cambie de herramienta.

La tentación es elegir runtime desde el inicio "porque es más potente". El costo
es que pasas a competir con el CLI oficial, te quedas atrás en cada release, y
pierdes el caso de uso que motivó el proyecto: ver qué está haciendo la sesión
que corres a diario.

## Decisión

**Arrancamos exclusivamente en modo observador, pero el modelo de datos y la
frontera de código se diseñan para soportar ambos modos desde el día uno.**

Concretamente:

- Se define una interfaz `SourceAdapter` en `@obs/core`. Su única
  responsabilidad es traducir la fuente nativa a `AgentEvent` (ver ADR-002) y
  empujarlo al bus.
- La v1 implementa un solo adaptador: `HookAdapter`. Después: `JsonlAdapter`
  (backfill), `OtelAdapter` (opcional), `SdkAdapter` (modo runtime).
- **Ninguna capa por encima del bus puede saber de qué adaptador vino un
  evento.** El store, las proyecciones, la API y la UI consumen `AgentEvent` y
  nada más.
- El modo runtime se implementa como un paquete separado (`@obs/runtime`) que
  depende de `@obs/core` pero del cual `@obs/collector` **no** depende. Si nunca
  lo construimos, no queda deuda.

## Sobre mantener ambos modos

Sí, es el objetivo final, y no son excluyentes en la misma instalación: un
usuario puede observar sus sesiones de CLI y además lanzar corridas dirigidas
desde nuestro runtime. Pero hay que ser honestos sobre la **paridad de
fidelidad**, porque no es completa:

| Dato                           | Observador                   | Runtime                   |
| ------------------------------ | ---------------------------- | ------------------------- |
| Tool calls (input/output)      | Sí, vía hooks                | Sí, nativo                |
| Jerarquía de subagentes        | Sí, vía `agent_id`/`parent`  | Sí, nativo                |
| Texto completo del assistant   | Sólo vía JSONL, con lag      | Sí, en streaming          |
| Razonamiento / thinking blocks | Parcial (JSONL)              | Sí                        |
| Bloqueo de permisos            | Vía exit code 2, con timeout | Programático, sin timeout |
| Contenido exacto de la ventana | Reconstruido                 | Directo                   |

Por eso el envelope lleva `source` y `fidelity` (ADR-002) y **las vistas de la
UI deben degradar con gracia**: una vista que sólo funciona con datos de runtime
no se construye hasta que exista el runtime, y cuando exista debe mostrar un
estado vacío explicable en modo observador, no romperse.

## Consecuencias

**Positivas**

- La v1 es útil sobre el flujo de trabajo real sin pedir migración a nadie.
- Cada release de Claude Code nos suma capacidades en lugar de romper la
  nuestra.
- El costo de agregar runtime después es un paquete nuevo, no un rewrite.

**Negativas**

- Vivimos con la fidelidad que los hooks nos den. Si un dato no está expuesto,
  no lo tenemos, y el workaround es leer JSONL con lag.
- El bus canónico es indirección que no se paga sola en la v1. Se paga en la
  fase runtime.
- Hay que resistir la tentación de meter un campo "sólo del hook" al envelope.
  Si un adaptador necesita algo propio, va en `raw` (ADR-002), no en el
  envelope.

## Alternativas consideradas

- **Runtime desde el inicio.** Rechazada: máxima fidelidad, mínima adopción, y
  compite de frente con producto oficial que se mueve más rápido que nosotros.
- **Sólo observador, para siempre.** Rechazada como postura permanente, aceptada
  como alcance de v1. Cerrarse al runtime nos impide la fase de "correr recetas
  dirigidas".
- **Wrapper del binario `claude` (PTY / proxy de terminal).** Rechazada: frágil,
  dependiente del rendering del TUI, y ya hay evidencia de subprocesos que
  mueren en silencio cuando se los spawnea sin PTY.
