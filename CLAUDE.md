# keel

Harness de ingeniería centrado en la tarea (`WorkItem`): daemon local en TypeScript/Bun, clientes
TUI y GUI, agentes sobre el Claude Agent SDK y el Codex SDK, worktrees aislados, gates humanos.
Hoy el repo tiene documentación, `@keel/core` (heredado de Mirador) y un spike. Español en docs,
commits y comentarios; identificadores en inglés.

## docs/adr/ es autoridad vinculante

Los ADRs de `docs/adr/` mandan sobre el SDD, este archivo, los comentarios y los commits. Antes de
elegir runtime, transporte, esquema, dependencia nueva o frontera entre paquetes: lee los ADRs y
cita el que aplica. Si no hay ADR, para y dilo; escribirlo es trabajo del humano. Los ADRs nacen
como **Propuesto** y sólo el humano los pasa a Aceptado. **Un ADR aceptado no se edita: se
supersede.**

`docs/inherited/mirador/adr/` son los ADRs de Mirador tal cual: referencia, **nunca se editan**.
ADR-0001 de Keel dice cuáles rigen aquí.

`docs/sdd/` es la especificación funcional. Donde choque con un ADR gana el ADR y se corrige el SDD.
El canvas de pen.dev es la fuente de verdad visual (`docs/design/`); se lee con el MCP `pencil`.

## Reglas que son código, no intención (ADR-0002)

1. Keel **no implementa login** ni OAuth de ningún proveedor.
2. Keel **no lee, copia ni cachea** `~/.claude.json`, `~/.codex/auth.json` ni ningún archivo de
   credenciales. Un grep en CI falla si aparecen esas rutas.
3. Keel **no bundlea ni modifica** el binario de Claude Code: detecta el instalado o pide instalarlo.
4. Nada de USD en la UI sin su `cost_kind` (`observed | estimated | unknown`).
5. Concurrencia y presupuesto con defaults bajos; subirlos es acción explícita del usuario.

## Reglas de dependencia

```
core  ←  daemon  ←  (tui, gui, cli)   # los clientes sólo hablan el protocolo de ADR-0005
```

- `packages/core` no depende de nadie y no hace I/O: `"types": []`, sin `bun:*`, sin `node:fs`.
  Biome lo convierte en error de lint. Tests en `test/`, nunca en `src/`.
- Los clientes **nunca** abren el archivo SQLite (ADR-0005).
- Zod para todo dato que cruce un proceso (IPC, SDK → store). Tipos con `z.infer`, no a mano.

## Tooling

- Bun ≥ 1.4 como runtime y gestor de paquetes (ADR-0003). TypeScript strict +
  `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`,
  `erasableSyntaxOnly`. ESM, `module: NodeNext`, extensión `.js` en imports relativos.
- Biome para lint y formato. `bun run lint`, `bun run typecheck`, `bun run test`.
- Spike: `bun run spike:sdk` / `bun run spike:codex`. Sus capturas (`spikes/*/captures/`) están
  gitignored y se redactan antes de promoverlas a fixtures.

## Forma de trabajo

- Alcance mínimo literal. Medir, no asumir: toda cifra en un ADR viene de un fixture o de un
  spike que se puede volver a correr.
- Nada se da por implementado por estar documentado. El roadmap del SDD 04 marca fases con
  evidencia reproducible como criterio de salida.
