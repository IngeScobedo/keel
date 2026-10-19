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

Abrir [localhost:5173](http://localhost:5173) en Windows o WSL. El preview usa ejemplos
rotulados; sus acciones no ejecutan herramientas ni proveedores. Se puede crear
una tarea local, buscar, inspeccionar runs, revisar diffs y confirmar
aprobaciones de ejemplo. Preferencia de tema persistente; tareas, comentarios,
checklist y borradores permanecen sólo durante la sesión.

```bash
bun run gui:build
bun run typecheck
bun run test
bun run lint
bunx playwright install chromium
bun run gui:e2e
```

## Ventana nativa

```bash
bun run gui:desktop
```

Requiere los
[prerrequisitos oficiales de Tauri](https://v2.tauri.app/start/prerequisites/):
Rust/Cargo y las librerías GTK/WebKit del host Linux. En esta sesión no están
instalados; el renderer se verificó en Chromium, **el shell Rust no se ha
compilado ni ejecutado**. No se afirma soporte Windows/WSL remoto terminado.

`src-tauri/` contiene el cascarón mínimo de ADR-0003/0005: abre socket Unix
(POSIX/WSL) o Named Pipe (Windows), correlaciona requests y emite
notificaciones. No contiene SQLite, SDKs, scheduler ni host de PTY. El daemon
actual sólo ofrece socket Unix, por lo que la ruta utilizable es ejecutar ambos
procesos dentro de WSL; el bridge a una GUI Windows sigue pendiente.

Al ejecutar la ventana nativa, ir a **Project setup → Configurar conexión** y
copiar socket y project ID del arranque del daemon. Si se omite project ID, se
intenta descubrirlo en el primer evento, mientras no exista projects.list. La
conexión reemplaza por completo los ejemplos por snapshot y eventos IPC.

## Funciones y límites

| Vista                 | Disponible en preview                                                             | Integración real                                                     |
| --------------------- | --------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Shell / Board         | Navegación, filtros, lista, palette, tema, creación local                         | Health, snapshot de tareas/runs, creación de tarea por IPC           |
| Work Item             | Actividad, notas, plan, checklist, evidencia, diff, cierre humano de ejemplo      | Estados y runs; spec/evidencia/DAG/diff necesitan lectura del daemon |
| Run                   | Árbol plegable, búsqueda de tool calls, timeline, tiempos y costo con procedencia | Timeline de eventos recibidos; lectura de nodos pendiente            |
| Inbox                 | Dry run, target, scope, hash, TTL y confirmación única                            | Las aprobaciones sin detalle completo quedan deshabilitadas          |
| Control Plane         | Perfiles, borrador local, workflow, simulador routing, gates y evals              | Endpoints todavía pendientes                                         |
| Contract Hub          | Versiones v1/v2, dependencia y diff de ejemplo                                    | Versionado y scheduler de contratos pendientes                       |
| Workbench             | Diff de ejemplo y estados no disponibles                                          | diff.read, PTY/editor/preview pendientes                             |
| Design Studio / Setup | Estados y matriz de repos del diseño                                              | SDK OpenPencil y configuración federada pendientes                   |

Los botones sin soporte están deshabilitados. No se implementan un endpoint HTTP
alternativo, acceso directo al repositorio ni lectura de credenciales. Los
requests/responses se validan con los esquemas Zod de `@keel/core`.

## Evidencia

Las pruebas Playwright cubren filtros, creation, palette, tree/duration, TTL,
revisión humana, perfiles, contratos, tema y viewport estrecho. Una prueba con
el API Tauri simulado verifica el límite IPC y la separación de datos reales
frente a ejemplos; **no sustituye la prueba de la ventana Tauri**.

[Handoff de UI](../../docs/reviews/2026-10-14-ui-handoff.md) y
[fixes del backend para Claude](../../docs/reviews/2026-10-14-backend-handoff.md).
