# Sesión de Claude Design (ADR-0044) implementada

- **Fecha:** 2026-10-30
- **ADR:** 0044 (Propuesto). Se implementó a pedido del humano antes de
  aceptarlo.

## Qué hay

- **`DesignSessions`** (`packages/daemon/src/design-session.ts`):
  - Abre `claude` interactivo en un pane de tmux, con `--session-id` y `-n`, en
    el worktree de la tarea. Lo lanza sin `CLAUDECODE` ni `CLAUDE_CODE_*`.
  - Pega los encargos con bracketed paste sólo cuando el prompt está listo y no
    hay un diálogo abierto.
  - Detecta en la pantalla el diálogo de confianza y los de permiso, y nunca
    los contesta.
  - Lee sólo el transcript de su `--session-id` y emite:
    - `design.session.event`, con el texto y las tools;
    - `design.published`, con el `url` del resultado de `Artifact`, no el
      `type_url`;
    - `design.session.idle`.
  - Las sesiones sobreviven a un reinicio del daemon y se recuperan de sus
    eventos.
- **Límite:**
  - La sesión cuenta como un run vivo.
  - La que pide el run vivo de la propia tarea usa su lugar. Sin esa regla, con
    el default de un run, `design_request` no funcionaba nunca. Se corrigió el
    ADR, que sigue en Propuesto.
  - Se cierra al cerrar la tarea.
- **Protocolo:**
  - Para el agente: `design.request`, la tool MCP `design_request`.
  - Para el humano: `design.start`, `design.status`, `design.screen`,
    `design.keys` (teclas en lista blanca o texto), `design.close` y
    `design.open` (sólo `https://claude.ai/`).
- **GUI:**
  - La tarjeta «Claude Design» en la vista de la tarea, en cualquier pestaña:
    - el estado: trabajando, espera tu respuesta o lista;
    - los diseños con «Abrir»;
    - la pantalla en vivo (`capture-pane -e` con sus colores, sin dependencia
      nueva) y las teclas;
    - el `tmux attach` para abrirla desde tu terminal;
    - el consejo de confiar en la carpeta de worktrees.
  - En el panel lateral, «Abrir sesión de diseño».
  - En el chat, líneas para el encargo, el diálogo y el diseño publicado.

Evidencia:

- `spikes/design-session`: la sesión real publicó un diseño en 24 s.
- `packages/daemon/test/design-session.test.ts`, con tmux real y un `claude`
  falso. Cubre:
  - el encargo del agente;
  - el diálogo de confianza contestado desde Keel;
  - el link;
  - que la sesión no herede `CLAUDECODE`;
  - el límite y el cierre.
- `packages/gui/e2e/design.spec.ts`.
- `packages/gui/test/ansi.test.ts` y `chat-model.test.ts`.

## Pendiente

- **Canvas.** La tarjeta y su terminal no tienen frame en el canvas de pen.dev
  (`ds/TerminalPane` existe y sirve de base).
- **El aviso al agente** cuando la sesión termina su turno no tiene prueba
  propia. Usa `continueFlow`, el mismo camino de los demás avisos del método.
- **Prueba punta a punta real.** Falta un agente de Keel con `design_request`
  contra el `claude` real. El spike midió la sesión, no la tool.
- **Windows nativo.** No hay sesión de diseño (sin tmux); la GUI lo dice.
