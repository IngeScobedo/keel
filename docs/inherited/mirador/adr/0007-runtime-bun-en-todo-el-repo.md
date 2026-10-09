# ADR-007: Runtime — Bun en todo el repo; Node sólo como target de compatibilidad

- **Estado:** Aceptado
- **Fecha:** 2026-08-20
- **Supersede:** ADR-005, parcialmente — la fila «Runtime» de la tabla de stack, la elección
  «npm workspaces» y la alternativa «Bun / Deno como runtime». El resto de ADR-005 sigue vigente.
- **Relacionados:** ADR-001 (fase runtime), ADR-005 (stack), ADR-006 (presupuesto del bridge)

## Contexto

ADR-005 eligió Node LTS y rechazó Bun «por compatibilidad con el ecosistema MCP, que es la
dependencia menos negociable del proyecto». Esa justificación es incorrecta: el SDK oficial
(`@modelcontextprotocol/sdk`) es TypeScript/ESM estándar y carga y funciona bajo Bun sin
adaptación. Verificado en este repo el 2026-08-20: `server/index.js`, `client/index.js` y los
transports stdio de servidor y cliente cargan bajo Bun 1.3.11 igual que bajo Node 22.22. El
motivo que sostenía la decisión no existe.

Lo que sí existe es una restricción que ADR-005 no pesó: el `hook-bridge` (ADR-006). Se
spawnea un proceso nuevo **por cada evento de hook**, en el camino crítico del agente, con un
presupuesto total de 50 ms. Ahí el coste de arranque del runtime no es un detalle: es la
mayor parte del presupuesto.

Además, el scaffold ya corría sobre Bun workspaces (ver CLAUDE.md), así que había una
contradicción entre el ADR y el repo que había que resolver en una de las dos direcciones.

## Decisión

1. **Bun es el runtime y el gestor de paquetes de todo el repo.** `bun install`, Bun
   workspaces, `bun test`, `bun run`. Sustituye a «npm workspaces» y a «Node LTS» de ADR-005.
   Todo lo demás de ADR-005 — sin Nx, estructura de paquetes, Zod, Fastify, Postgres + `jsonb`,
   SSE, React, tests sobre fixtures reales — sigue vigente.

2. **Excepción explícita: el futuro paquete `runtime` (fase 7, ADR-001).** El Agent SDK
   gestiona un CLI bundleado y procesos hijo. Ahí **no se asume paridad Bun/Node**: se prueba
   antes de comprometerse. Si no hay paridad, ese paquete corre en Node, y eso no reabre esta
   decisión para el resto del repo.

3. **`core` y `mcp-proxy` siguen siendo runtime-agnósticos por contrato** (regla 4 de
   CLAUDE.md: sin `Bun.*`, sin `bun:*`; `"types": []` y `"types": ["node"]` respectivamente).
   Bun es cómo los corremos nosotros, no un requisito para quien los consume: `mcp-proxy` se
   publica en npm y alguien lo va a ejecutar con `npx` sobre Node. **Ambos se prueban en CI bajo
   Bun y bajo Node LTS.** Sin el job de Node, «runtime-agnóstico» es una promesa, no un hecho.

4. **`hook-bridge` es Bun sin reservas** y se compila a binario único con
   `bun build --compile`. La instalación en la máquina observada es un `cp` del binario: no
   exige Node ni Bun instalados, ni un `PATH` concreto cuando el hook se ejecuta.

5. **Detalle operativo — servers MCP stdio en Claude Code.** Para que el CLI resuelva rutas
   relativas de un server stdio escrito en TS, se registra como `bun run ./ruta/al/server.ts`,
   con el path empezando en `./`. Los hooks, en cambio, se registran con la **ruta absoluta**
   del binario compilado (lo hace `packages/hook-bridge/src/register.ts`).

## Evidencia: latencia de arranque

Medido el 2026-08-20 en la máquina de desarrollo (WSL2, Linux 6.6, Bun 1.3.11, Node 22.22),
20–30 corridas **intercaladas** por variante para repartir el ruido; p50 en ms. Los valores
absolutos son de esta máquina — WSL2 spawnea procesos lento — y hay que re-medir en la máquina
objetivo; lo que importa es la relación entre filas.

| Variante | p50 (ms) |
|---|---|
| `bun -e ""` — atajo sin inicializar la VM; **no** cuenta como arranque | 5 |
| `bun empty.js` — suelo real de Bun ejecutando JS | 37 |
| `node -e ""` — suelo de Node | 56 |
| Bridge mínimo (stdin → JSON → append) en Bun, CommonJS | 52 |
| Bridge mínimo equivalente en Node | 54 |
| `@mirador/hook-bridge` Fase 1, `bun build --compile` | 86 |
| `@mirador/hook-bridge` Fase 1, `bun src/index.ts` | 88 |

Lecturas:

- El suelo de Node (56 ms) consume por sí solo más que el presupuesto entero de 50 ms. El de
  Bun (37 ms) deja margen, aunque poco.
- La ventaja de Bun se evapora en cuanto el programa hace `require("node:fs")`: la capa de
  compatibilidad Node de Bun se inicializa perezosamente (~15 ms aquí). Por eso el bridge
  mínimo empata (52 vs 54). El margen real de Bun está en usar sus APIs nativas y mantener los
  módulos `node:*` fuera del hot path; eso es trabajo de la fase que implemente ADR-006
  completo, no del spike.
- El spike de Fase 1 (86 ms) **no cumple el presupuesto en ningún runtime**: importa `node:fs`,
  `node:os` y `node:path` como ESM (sólo pasar el bundle a CJS baja a 73 ms). Es aceptable:
  el spike existe para capturar fixtures. ADR-006 dice que el presupuesto «se mide y se
  testea»; ese test sigue pendiente y se escribe cuando exista el bridge real.
- Compilar a binario no cuesta latencia frente a `bun file.js` (86 vs 88): el `cp` es gratis.

## Consecuencias

**Positivas**
- Un solo toolchain para desarrollar: `bun install`, `bun test`, `bun run`, sin tsx/nodemon
  ni segundo gestor de paquetes.
- El bridge se distribuye como binario único; instalar es copiar un fichero.
- El suelo de arranque del bridge baja ~35 % respecto a Node en la misma máquina.
- `bun test` ejecuta ficheros escritos con `node:test` de forma nativa (verificado aquí), así
  que un mismo fichero de test de `core`/`mcp-proxy` puede correr bajo `bun test` y bajo
  `node --test` sin duplicarlo.

**Negativas**
- CI con matriz Bun + Node LTS para `core` y `mcp-proxy`. Es coste real y no se puede
  dejar caer: es lo único que convierte el contrato runtime-agnóstico en hecho.
- Si la fase 7 acaba en Node, el repo tendrá dos runtimes. Aceptado: es exactamente el caso
  que el punto 2 deja abierto a propósito.
- Bun cambia rápido. Un bump puede romper `bun build --compile` o el comportamiento de un
  módulo `node:*`. La versión se fija en `engines` y se sube a propósito, no por arrastre.
- Los números de arriba demuestran que «Bun es más rápido» no basta para cumplir ADR-006:
  hará falta trabajo de optimización del bridge, y posiblemente un test de latencia en CI que
  falle cuando se supere el presupuesto.

## Nota de implementación

Mecanismo verificado para «se testean bajo Bun y Node»: los tests de contrato de `core` y
`mcp-proxy` se escriben con `node:test` + `node:assert/strict`; `bun test` los ejecuta tal
cual, y el job de Node los corre con `node --test` contra `dist/` (lo que se publica). Se
concreta cuando `core` tenga lógica (Fase 2); hoy ambos paquetes sólo tienen un smoke test.

## Alternativas consideradas

- **Mantener Node LTS (ADR-005).** Rechazada: su justificación era falsa y su suelo de
  arranque excede el presupuesto del bridge por sí solo.
- **Node para todo salvo el bridge en Bun.** Es lo que haría alguien conservador. Rechazada:
  duplica toolchain para proteger una compatibilidad que el SDK de MCP ya tiene bajo Bun, y el
  contrato runtime-agnóstico de `core`/`mcp-proxy` se garantiza con CI, no con el runtime de
  desarrollo.
- **Deno.** Rechazada: no aporta nada sobre Bun para este repo y el scaffold ya corre en Bun.
- **Bridge en un lenguaje compilado (Go/Rust/Zig).** Arranque de ~1–2 ms; sería lo más
  rápido para el hot path. Pospuesta, no rechazada: si el bridge de ADR-006 no cumple los 50 ms
  con Bun, es el siguiente paso, y su contrato (stdin → spool → exit 0) es lo bastante pequeño
  como para reescribirlo sin tocar nada más.
