# El chat del run como superficie de foco: implementado, con lo que quedó distinto

- **Fecha:** 2026-10-26
- **Relacionados:** ADR-0020 (aceptado el 2026-10-26; no se edita), ADR-0001 (su
  adopción de `deny-on-timeout` queda superseded por ADR-0020 §3), canvas «16
  Run Chat» (página `Qw9Nt`), SDD 02 §9, SDD 04 Fase 1

## Qué se hizo

**Daemon y protocolo**

- `AskUserQuestion` y `ExitPlanMode` pasan por el gate como preguntas:
  - Ninguna regla, concesión, bypass ni límite las resuelve.
  - `approvals.resolve` exige respuestas para aprobar.
  - El daemon devuelve al SDK `allow` con `updatedInput.answers` y
    `annotations`.
  - Un plan aprobado con `then_mode` cambia el modo por `updatedPermissions`
    (`setMode`), la vía del SDK. Así Claude Code no lo pisa al salir de plan.
- Las aprobaciones no vencen:
  - `approval_timeout_ms` es `null` por defecto.
  - El ajuste `approvals.timeout_ms` (`settings.update`) fija un límite y, al
    vencer, se niega.
  - Las operaciones de recursos (ADR-0013) usan el mismo límite.
- Patrón editable (`approvals.resolve.pattern`):
  - `parsePattern` y `patternText` en `@keel/core`.
  - El daemon rechaza un patrón que no cubre la operación, un prefijo con
    metacaracteres y el shell entero (eso es `bypass`).
- `runs.set_mode` y `runs.set_model`:
  - Llevan los eventos `run.mode_changed` y `run.model_changed` con el actor.
  - Claude aplica el cambio con `setPermissionMode`, `setModel` y
    `applyFlagSettings({effortLevel})`.
  - Codex lo aplica desde el turno siguiente (`turn/start` acepta
    `approvalPolicy`, `model` y `effort`).
  - Si falla en el proveedor, queda `run.live_change_failed`.
- Bypass en vivo: un run `execute` con git arranca con
  `allowDangerouslySkipPermissions`, porque el SDK exige declararlo al lanzar.
  El modo sigue siendo el elegido; el flag sólo permite pasar a bypass después.
- `providers.models` sale de `supportedModels()`. Sin run vivo, abre una sesión
  sin prompt y la cierra: tarda alrededor de 1 s y no gasta tokens (medido el
  2026-10-26 contra `claude` 2.1.310; 13 modelos).
- `RunOptions.effort` llega al SDK como `effort`.
- Sugerencias de Claude:
  - `promptSuggestions: true` salvo que el humano las apague
    (`claude.prompt_suggestions`).
  - Cada `prompt_suggestion` queda como evento `sdk.prompt_suggestion`.

**GUI**

- La vista en vivo del run es el chat:
  - Cabecera con tarea, rama, aislamiento, reloj, modo y densidad.
  - Pestañas Chat, Operaciones, Costo y Eventos.
  - Panel «en este run» con lo que espera, archivos con `+n −m`, tareas,
    checklist, notas y sesión.
- Tarjetas por intención (`chat-model.ts` y `ToolCards.tsx`):
  - Edición con diff numerado, de `structuredPatch` o del diff de Codex.
  - Bash con su descripción y la última línea.
  - Read y Grep agrupados en «Exploró el código».
  - Acciones de Keel y checklist del agente con destello de entrada.
  - La tarea creada se abre al lado sin salir.
- Permisos, preguntas y planes se resuelven en su tarjeta, con teclado:
  - Permisos: `Y`, `S`, `A` y `N`.
  - Preguntas: `1`–`4` y `Enter`.
- Compositor:
  - Pastilla de modelo y esfuerzo, y pastilla de modo; bypass pide confirmación.
  - `⇧⇥` cicla el modo.
  - La sugerencia aparece como texto fantasma y `→` o `Tab` la aceptan.
- Markdown mínimo para lo que escribe el agente, sin inyectar HTML.
- El Inbox manda las preguntas al chat en vez de ofrecer «aprobar».

**Evidencia**

- `packages/core/test/permissions.test.ts`
- `packages/daemon/test/run-chat.test.ts` (8 pruebas)
- `packages/gui/test/chat-model.test.ts`, con formas de un run real de Claude
  Code 2.1.310
- `packages/gui/e2e/run-chat.spec.ts`, contra un daemon real con el guion
  `chatQuery`
- Corridas reales con `claude` 2.1.310 y haiku (2026-10-26), con el SDK directo:
  - Respuesta a la pregunta. `AskUserQuestion` preguntó «¿Qué color prefieres?»
    con Rojo y Azul. Se devolvió `answers` con «Azul» y el agente contestó
    «azul».
  - Bypass en vivo. Se pidieron dos `touch` en llamadas separadas. Sin cambio de
    modo, `canUseTool` se llamó dos veces. Con
    `setPermissionMode("bypassPermissions")` tras la primera, se llamó una sola
    vez y los dos archivos quedaron creados. La sesión se lanzó con
    `allowDangerouslySkipPermissions`.
  - `echo` no sirve para medirlo: Claude Code lo permite sin preguntar.

## Distinto del canvas o del ADR

- El ejemplo del canvas «`cd apps/api && bun run *` · cubre esta orden» no es
  válido con la regla de §2 que el ADR conserva: un prefijo nunca cubre un
  comando con metacaracteres. La GUI dice «patrón no válido». El criterio de
  aceptación (`cd *` cubre otro `cd` y no `cd x && rm -rf y`) sí se cumple.
- La tarjeta de tarea creada ofrece «Abrir al lado» y, dentro, «Mover a
  planned». En lugar de «Aceptar a backlog» y «Descartar»: no hay transición
  `triage → backlog` ni de descarte en `LIFECYCLE_EDGES`.
- La cabecera conserva «Detener». No hay `Esc` para interrumpir: el daemon no
  expone interrumpir un turno sin cancelar el run.
- El canvas no tiene pestañas. Operaciones, Costo y Eventos quedan como pestañas
  discretas bajo la cabecera, para no perder lo que ya existía.

## Pendiente

- Codex en vivo: el daemon no guarda `outputDelta`, así que la tarjeta de un
  comando de Codex muestra el reloj y no la última línea (§1). Necesita publicar
  deltas efímeros sin persistirlos.
- Modelos de Codex: `providers.models` devuelve sólo el del perfil. El
  app-server tiene `model/list`; falta usarlo.
- Resaltado de sintaxis en diffs y lecturas: no se agregó dependencia. El diff
  tiene números de línea y colores, sin resaltado por lenguaje.
- Subagentes: la tarjeta muestra tipo, descripción y resumen, sin anidar sus
  tool calls.
