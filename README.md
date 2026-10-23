# Keel

Harness de ingeniería centrado en la tarea: daemon local, clientes TUI y GUI,
agentes sobre los SDKs oficiales de Claude y Codex, worktrees aislados, gates
humanos, Contract Hub y Research Hub. Hereda de [Mirador](https://github.com/)
(repo `cc-ui`) el modelo de correlación medido y las lecciones de observar
sesiones reales; no hereda su stack.

**Estado (2026-10-14):** core, store SQLite y daemon IPC con adaptador Claude;
primera GUI React basada en pen.dev, con preview navegable y transporte Tauri
preparado. El build nativo y varias funciones de orquestación siguen pendientes.
Ver [`docs/adr/`](docs/adr/README.md) para las decisiones y
[`docs/sdd/`](docs/sdd/) para la especificación.

## Mapa del repo

```text
docs/adr/                 decisiones de arquitectura de Keel. Autoridad vinculante.
docs/sdd/                 especificación: PRD y UI, arquitectura, datos, roadmap y TUI.
docs/design/              tokens.json exportado del canvas de pen.dev + inventario de pantallas.
docs/inherited/mirador/   ADRs y backlog de Mirador, copiados íntegros como referencia. No se editan.
packages/core             @keel/core: envelope, correlación, contrato IPC (ADR-0005), visual_state (ADR-0006). Cero I/O.
packages/daemon           @keel/daemon: store SQLite WAL con migraciones (ADR-0004). Fase 0.
packages/git              @keel/git: worktrees por run con estado en git, rescate y reconcile. Corre en Node (ADR-0007).
packages/gui              @keel/gui: React/Vite, tokens del canvas, shell Tauri e integración IPC.
docs/reviews/             revisión del backend para Claude y evidencia de implementación GUI.
scripts/                  validate-ddl (62 checks), extract-ddl (SDD 03 -> migración 0001), png-grayscale.
spikes/sdk-capabilities   qué dan de verdad los SDKs: auth, costo, identidad de subagentes.
tools/                    lanzador del MCP de Pencil (pen.dev) para leer el canvas desde Claude Code.
```

## Comandos

```bash
bun install
bun run test          # bun test en packages/*
bun run typecheck     # tsc -b + tests
bun run lint          # biome
bun run docs:lint     # markdownlint; docs:format con prettier
bun run docs:validate-ddl  # DDL del SDD 03 sobre bun:sqlite con FTS5 y vec0
bun run ddl:check     # la migración 0001 del daemon coincide con el SDD 03
bun run gui:dev       # preview UI en http://localhost:5173 (desde Windows también)
bun run gui:build     # renderer de producción
bun run gui:e2e       # flujos Playwright; bunx playwright install chromium primero
bun run gui:desktop   # Tauri dentro de WSL; necesita Rust y GTK/WebKit
bun run spike:sdk     # probe del Claude Agent SDK (usa el `claude` instalado, modelo haiku)
bun run spike:codex   # probe del Codex SDK
```

## Correr el daemon y la CLI (Fase 0)

```bash
bun packages/daemon/src/main.ts --root /ruta/al/repo     # socket en $XDG_RUNTIME_DIR/keel/keel.sock
bun packages/daemon/src/cli.ts health
bun packages/daemon/src/cli.ts run "Lista con Glob los .ts de packages/core/src"
bun packages/daemon/src/cli.ts tail                        # eventos en vivo con visual_state
bun packages/daemon/src/cli.ts approve <id> <hash>         # o deny
```

El perfil por defecto usa `subscription_session` con el `claude` instalado,
modelo `haiku`, herramientas `Read`, `Glob` y `Grep` auto-aprobadas; cualquier
otra pasa por `canUseTool` y espera una decisión humana hasta 60 s, luego se
deniega (SDD 02 §9).

## GUI y trabajo pendiente

El preview arranca con ejemplos explícitos del diseño; crear tareas o aprobar
esos ejemplos no ejecuta agentes. En el shell Tauri, Project Setup permite
conectar el socket y project ID que reporta el daemon. El cliente valida los
frames con `@keel/core` y no abre SQLite.

[Guía y alcance de la GUI](packages/gui/README.md) ·
[Revisión del backend para Claude](docs/reviews/2026-10-14-backend-handoff.md) ·
[Evidencia de UI y siguientes pasos](docs/reviews/2026-10-14-ui-handoff.md).

## Proveedores y cuentas

Keel no tiene login propio, no lee ni guarda credenciales de Claude ni de Codex
y no hace proxy de requests. En modo `subscription_session` invoca el binario de
Claude Code que el usuario ya instaló y deja que ese binario use la sesión que
ya tenga; en modo API key usa la clave del entorno. Detalle y razones en
[ADR-0002](docs/adr/0002-proveedores-autenticacion-y-costo.md).

Keel no está afiliado a Anthropic ni a OpenAI. El uso de cada proveedor queda
sujeto a los términos de la cuenta de cada usuario.

Antes de guardar o mostrar un evento, Keel reemplaza los valores que parecen
secretos: cabeceras de autorización, bearer tokens, claves privadas, contraseñas
en URLs y formatos de token conocidos (`@keel/core`, `redaction.ts`). Es
**best-effort**, no una garantía. Las reglas están versionadas y probadas, pero
un secreto con una forma que no reconocen puede pasar.
