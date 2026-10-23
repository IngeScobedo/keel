# Keel GUI

Cliente React de ADR-0003, basado en el canvas de pen.dev (ADR-0001). Los 107
tokens dark/light provienen de `docs/design/tokens.json`; se regeneran con
`bun run --cwd packages/gui tokens`. Inter y JetBrains Mono se sirven
localmente; los iconos son Lucide.

## Arranque desde la raíz

```bash
bun install
bun run gui:dev
```

Abrir [localhost:5173](http://localhost:5173) en Windows o WSL. El preview usa
ejemplos rotulados; sus acciones no ejecutan herramientas ni proveedores. Se
puede crear una tarea local, buscar, inspeccionar runs, revisar diffs y
confirmar aprobaciones de ejemplo. Preferencia de tema persistente; tareas,
comentarios, checklist y borradores permanecen sólo durante la sesión.

```bash
bun run gui:build
bun run typecheck
bun run test
bun run lint
bunx playwright install chromium
bun run gui:e2e
```

## Ventana nativa, contra el daemon

```bash
bun run gui:desktop
```

Al abrirse, la ventana busca el daemon en su socket por defecto. Si no hay uno,
lo arranca desligado (`bun packages/daemon/src/main.ts`, o `KEEL_DAEMON`), y
cerrar la ventana no lo detiene (ADR-0019 §1). El daemon abre el último proyecto
usado. Para cambiar de proyecto o abrir otra carpeta (repo o no), usa el
selector de la cabecera, que muestra siempre la rama, el adelanto o atraso y los
cambios del repo activo.

Para otro daemon: `KEEL_SOCKET=/ruta/al.sock bun run gui:desktop`, o **Project
setup → Configurar conexión**.

- **Requisitos:** los
  [prerrequisitos de Tauri](https://v2.tauri.app/start/prerequisites/), es
  decir, Rust y las librerías GTK/WebKit en Linux.
- **WSL2:** con WSLg compila y abre la ventana (2026-10-23).
- **Windows:** compila y `cargo test` habla con el daemon real. Hay que correr
  daemon y ventana en el mismo lado: un socket AF_UNIX no cruza de WSL2 a
  Windows.

`src-tauri/` es un cascarón fino (ADR-0003/0005). Abre el socket, correlaciona
peticiones, emite las notificaciones y sabe cuál es la ruta por defecto. No
contiene SQLite, SDKs ni scheduler.

## Funciones y límites

| Vista                                                 | Con el daemon conectado                                                                                                                                          | Pendiente                                                  |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| Board                                                 | Tareas y runs en vivo; crear tarea                                                                                                                               | Repo, prioridad y responsable                              |
| Tarea                                                 | Especificación y notas del daemon con su autor (Tú, Agente, Agente externo); transiciones humanas; arrancar `plan`/`execute` con Claude o Codex; cancelar un run | Cierre humano `needs_review → done`, diff, plan, evidencia |
| Run                                                   | Timeline legible (herramientas, mensajes, aprobaciones, estados) y en crudo; detener                                                                             | Árbol de subagentes, base y rama                           |
| Inbox                                                 | Aprobaciones del gate con comando, hash y vencimiento; sesiones externas (código, tarea, scopes); peticiones de run de agentes; tareas en revisión               | —                                                          |
| Control Plane, Contract Hub, Workbench, Design Studio | Sólo ejemplos                                                                                                                                                    | Endpoints del daemon                                       |

Los botones sin soporte están deshabilitados. No hay un endpoint HTTP
alternativo, la GUI no accede directamente al repositorio y no lee credenciales.
Las peticiones y las respuestas se validan con los esquemas Zod de `@keel/core`.
Sin el shell nativo (navegador), la GUI sólo muestra los ejemplos rotulados.

## Evidencia

- **Prototipo.** Las pruebas de Playwright cubren filtros, creación, palette,
  árbol y duración, TTL, revisión humana, perfiles, contratos, tema y viewport
  estrecho.
- **Ciclo real.** `e2e/live-daemon.spec.ts` recorre el ciclo contra un daemon
  real (SQLite, git y socket reales, con proveedores dobles). Un puente
  sustituye al shell de Tauri, abre el mismo socket y reenvía las mismas tramas.
  La prueba real con Claude Code y la ventana nativa está en
  [docs/reviews](../../docs/reviews/2026-10-23-emparejamiento-real.md).

[Handoff de UI](../../docs/reviews/2026-10-14-ui-handoff.md) y
[fixes del backend para Claude](../../docs/reviews/2026-10-14-backend-handoff.md).
