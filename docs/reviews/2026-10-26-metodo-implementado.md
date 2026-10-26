# Keel conduce el método: implementado, con lo que quedó distinto

- **Fecha:** 2026-10-26
- **Relacionados:** ADR-0021 (aceptado el 2026-10-26; no se edita), ADR-0006,
  ADR-0009, ADR-0019, revisión `2026-10-26-harness-casa-matte-y-keel.md`, spike
  `spikes/sdk-capabilities/src/method-probe.ts` (FINDINGS, tercera corrida)

## Qué se hizo

- **`@keel/core` (`method.ts`).**
  - Legalidad de etapas y gates, con el fast-path.
  - Validadores deterministas de brief, spec, diseño y QA, con las reglas del
    `validate.mjs` de Casa Matte.
  - `verifyDelta` para el delta-verde.
- **Store.** Migración 0012: `task_flows`, `task_docs` (contenido en el almacén
  de artefactos, a salvo de la purga) y `project_profiles`.
- **Daemon.**
  - `tasks.work`, `stages.advance`, `stages.return`, `task_docs.*`, `verify.run`
    y `projects.profile_*`.
  - Detección del perfil sin agente (`project-profile.ts`) y verificación en el
    worktree (`verify.ts`).
  - El plugin `keel-method` (skills y agentes) y el harness del proyecto
    (`settingSources: ["project"]`).
  - El hook que devuelve al gate lo que casen las reglas `allow` del proyecto.
- **MCP.** `stage_current`, `stage_advance`, `task_doc_put`, `task_doc_get`,
  `task_docs_list`, `verify_run` y `project_profile`. Devuelven texto corto: lo
  que falta, el delta y sólo la cola de lo que falló.
- **GUI.**
  - «Trabajar» con la pista de etapas, y la tarjeta del gate con los documentos.
  - En el chat: etapas, documentos, verificación y lo que Keel le dice al
    agente.
  - El panel «Método» y la vista que sigue al siguiente run.
  - El perfil en Ajustes y la etapa en el tablero.

## Evidencia

- `packages/core/test/method.test.ts`: etapas, gates y validadores.
- `packages/daemon/test/method-flow.test.ts`, contra daemon, git y worktrees
  reales:
  - trabajo directo de punta a punta;
  - ciclo formal con un gate negado;
  - cambio de contrato que reabre el gate (b);
  - sólo lectura y delta-verde;
  - las reglas `allow` del proyecto.
- `packages/gui/e2e/method.spec.ts`: la tarea se trabaja desde la GUI y los dos
  gates se deciden en el chat.
- **Corrida real** (`claude` 2.1.310, haiku), con el daemon completo y el puente
  MCP real, sobre un repo temporal:
  - El agente escribió el brief. La primera versión no validó, Keel le dijo qué
    secciones faltaban y lo corrigió.
  - Declaró trabajo directo.
  - En el brief se negó a editar porque era de sólo lectura.
  - Implementó en el worktree, con `main` intacto.
  - `verify_run` mostró el test arreglado frente al baseline rojo.
- **Lo que la corrida encontró y quedó corregido:**
  - En modo plan, Claude Code consulta a `canUseTool` por las tools MCP de Keel,
    y el gate las negaba. Ahora pasan siempre: las autoriza el daemon
    (ADR-0009).
  - En revisión, el agente creyó que el modo plan le impedía guardar el QA. El
    encabezado y el aviso de cambio de etapa ahora dicen que las tools de Keel
    sí funcionan en modo plan.

- **Cierre con el run vivo.** El plan de cierre puede aplicarse mientras el run
  sigue abierto. En ese caso la tarea pasa a `done` al asentar el run, a nombre
  de quien aprobó el plan. La corrida real lo encontró, y la prueba de trabajo
  directo lo cubre.
- **Codex en revisión.** Keel pasa `sandboxPolicy: readOnly` en el turno
  siguiente y vuelve a `workspaceWrite` al implementar (`conversation.test.ts`,
  con el app-server falso).

## Distinto del ADR

- **Etapas y propósitos.** Las etapas no son un propósito de run nuevo:
  - brief y diseño corren como `plan`; el resto, como `execute`;
  - todos en el worktree de la tarea (`task_worktree` en el manifest), así la
    sesión se retoma;
  - se evitó reconstruir la tabla `runs`, cuyo `CHECK` sólo admite `plan`,
    `execute` y `triage_eval`.
- **Trabajo directo y el lifecycle.** `triage → planned` es una arista humana
  (ADR-0006). La da el humano que pidió trabajar la tarea, y el evento
  `task.stage_changed` lo deja con `delegated: true`.
- **Cuándo pasa a revisión humana.** Terminar un turno en implementar o revisar
  deja la tarea en `waiting_human`, no en `needs_review`. Sólo el cierre espera
  la revisión humana, y el plan de git aprobado la lleva a `done`.
- **Devolver de etapa** no regresa a brief ni a diseño una tarea que ya
  implementa: el lifecycle no vuelve a `triage`. Para cambiar el diseño, el
  agente cambia el contrato y el gate (b) se reabre.
- **«Planear» y «Ejecutar»** no se quitaron: quedan en «Avanzado», plegado, para
  el control manual.

## Pendiente

- **ADRs que el ADR-0021 dejó para después:**
  - tarea padre y subtareas, con la rama de la feature y un worktree por
    subtarea;
  - `setup_request`, para que el agente pida conexiones y la GUI abra el modal;
  - la conversación del proyecto.
- **Tiempos de MCP:** una verificación larga, como `nx affected` en un monorepo,
  puede tardar minutos. El puente no corta la llamada, pero el cliente MCP del
  proveedor podría. Hay que medirlo en Casa Matte.
- **El perfil detectado** cubre JS/TS (bun, pnpm, yarn, npm, Nx), Rust, Go,
  Python y Make. Otros stacks quedan para que el humano los complete en Ajustes.
