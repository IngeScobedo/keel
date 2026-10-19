# Handoff de GUI · 2026-10-14

Instrucción del usuario: continuar la UI dentro de `../keel`, con pen.dev como
referencia, y registrar los fixes del backend para Claude. Se añadió
`packages/gui`; no se modificaron `packages/core` ni `packages/daemon`.

## Fuente visual y arquitectura

- Canvas abierto en Windows leído por MCP desde WSL. Exportadas y revisadas a
  1440×900: Board `TlOCe`, Work Item `ZpaXG`, Run `MmoeB`, Inbox `D9gQ61`,
  Control Plane `RfP2Z`. También se revisaron sus variantes y extensiones de
  contratos, gates, runtime y estados.
- 17 páginas, 111 variantes GUI y 12 TUI, 112 componentes, 107 variables.
  [Snapshot del canvas](2026-10-14-canvas-snapshot.json).
- React + Tauri de ADR-0003. Renderer Vite; dependencias enlazadas con Bun.
  Fuente Inter/JetBrains Mono local, Lucide y tokens existentes dark/light.
- Cliente fino con el protocolo de ADR-0005 y estados resueltos de ADR-0006. Sin
  acceso a SQLite, repositorios o credenciales desde el renderer.

## Entrega navegable

- Shell, rail, switcher de ejemplo/conexión, command palette y tema persistente.
- Board/list con búsqueda por palabras, ID, repo de ejemplo y filtro Needs you.
- Creación local; creación por IPC preparada sin iniciar agentes.
- Inspector con actividad, notas, checklist local, plan, evidencia y diff de
  ejemplo. El cierre humano exige revisión y confirmación, sólo en ejemplos.
- Run: árbol plegable, labels concretos, input/output, wall frente a duración
  del runtime, timeline y cost_kind explícito.
- Inbox: operación/target/scope/hash/TTL, confirmación y revalidación del TTL.
- Control Plane: perfiles, borrador de nueva versión local, workflow, routing
  simulator, gates y evals de ejemplo.
- Connections/Contract Hub con v1 ready_for_mock y v2 breaking; Workbench con
  diff; estados pendientes para PTY, preview, Design Studio y setup federado.

Los datos ilustrativos están identificados. Cambiar a conexión IPC los elimina;
una desconexión muestra error y no regresa silenciosamente a ejemplos. El
preview no contacta modelos ni ejecuta operaciones de infraestructura.

## Validación

- Renderer de producción: `bun run gui:build`.
- Tipos strict: `bun run typecheck`, incluyendo tests y configuración/e2e GUI.
- Workspace: **104 pruebas unitarias** (79 core, 18 daemon, 7 GUI).
- GUI: **11 flujos Playwright en Chromium**; uno simula el API Tauri para
  verificar conexión, replay previo al snapshot, creación y aprobación retenida.
- Lint: `bun run lint`, con el aviso informativo de schema Biome preexistente.
- Capturas inspeccionadas en dark/light y tamaños 1440×900, 1280×800 y 700×800.
- El shell Rust **no está compilado ni probado**: falta Rust/Cargo y GTK/WebKit
  en este WSL. `bunx tauri info` confirma los prerrequisitos ausentes. La prueba
  con API simulado no acredita funcionamiento nativo.

Capturas de implementación:
[Board dark](../design/implementation/board-dark.png),
[Board light](../design/implementation/board-light.png),
[Inspector](../design/implementation/task-dark.png),
[Run](../design/implementation/run-dark.png),
[Inbox](../design/implementation/inbox-dark.png),
[Control Plane](../design/implementation/profiles-dark.png).

## Siguiente trabajo de UI

1. Compilar/probar Tauri dentro de WSL con el daemon, incluidos reconexión, EOF,
   frames partidos UTF-8, backpressure y requests concurrentes; generar
   Cargo.lock con el toolchain, antes de afirmar build nativo reproducible.
2. Conectar métodos de detalle que implemente Claude: tarea/spec, DAG,
   agentes/tools, evidencia, approvals/list/detail, contratos y perfiles.
3. Añadir virtualización para miles de filas/tool calls, navegación por URL,
   i18n completa y tests de teclado/lectores de pantalla en los flujos
   restantes.
4. Implementar Workbench con PTY remoto, CodeRef/editor, diff real y preview
   aislado; validar integración OpenPencil para Design Studio.
5. Probar la matriz Windows-host ↔ WSL, SSH/reconexión y los estados de
   recuperación del canvas. Este preview no completa esos bridges.

## Para Claude

[Hallazgos del backend y reproducciones](2026-10-14-backend-handoff.md).
Prioridad: K-01 (daemon cae por método heredado), K-02 (run ignora bloqueo),
K-03 (replay truncado), K-04 (mutación/recibo no atómicos). Después resolver
lecturas pendientes para conectar UI. No presentar costo estimado como observado
ni habilitar aprobaciones si no se puede mostrar la operación.
