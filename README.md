# Keel

Harness de ingeniería centrado en la tarea: daemon local, clientes TUI y GUI,
agentes sobre los SDKs oficiales de Claude y Codex, worktrees aislados, gates
humanos, Contract Hub y Research Hub. Hereda de [Mirador](https://github.com/)
(repo `cc-ui`) el modelo de correlación medido y las lecciones de observar
sesiones reales; no hereda su stack.

**Estado (2026-10-08):** documentación y spike. No hay daemon todavía. Ver
[`docs/adr/`](docs/adr/README.md) para las decisiones y [`docs/sdd/`](docs/sdd/)
para la especificación.

## Mapa del repo

```text
docs/adr/                 decisiones de arquitectura de Keel. Autoridad vinculante.
docs/sdd/                 especificación: PRD y UI, arquitectura, datos, roadmap y TUI.
docs/design/              tokens.json exportado del canvas de pen.dev + inventario de pantallas.
docs/inherited/mirador/   ADRs y backlog de Mirador, copiados íntegros como referencia. No se editan.
packages/core             @keel/core: envelope, esquemas Zod, correlación. Cero I/O. Fixtures reales.
spikes/sdk-capabilities   qué dan de verdad los SDKs: auth, costo, identidad de subagentes.
tools/                    lanzador del MCP de Pencil (pen.dev) para leer el canvas desde Claude Code.
```

## Comandos

```bash
bun install
bun run test          # bun test en packages/*
bun run typecheck     # tsc -b + tests
bun run lint          # biome
bun run spike:sdk     # probe del Claude Agent SDK (usa el `claude` instalado, modelo haiku)
bun run spike:codex   # probe del Codex SDK
```

## Proveedores y cuentas

Keel no tiene login propio, no lee ni guarda credenciales de Claude ni de Codex
y no hace proxy de requests. En modo `subscription_session` invoca el binario de
Claude Code que el usuario ya instaló y deja que ese binario use la sesión que
ya tenga; en modo API key usa la clave del entorno. Detalle y razones en
[ADR-0002](docs/adr/0002-proveedores-autenticacion-y-costo.md).

Keel no está afiliado a Anthropic ni a OpenAI. El uso de cada proveedor queda
sujeto a los términos de la cuenta de cada usuario.
