# ADR-0003: Runtime del daemon — TypeScript sobre Bun primero; Rust diferido tras el spike

- **Estado:** Propuesto, condicionado al resultado del spike
  `spikes/sdk-capabilities`
- **Fecha:** 2026-10-08
- **Criticidad:** Alta
- **Relacionados:** ADR-0001, ADR-0002, ADR-0005 (el contrato IPC es lo que hace
  reversible esta decisión); SDD 02 §1

## Contexto

El SDD 02 propone daemon Rust/Tokio + sidecar Node/TypeScript + TUI Ratatui +
GUI Tauri. Los dos SDKs de proveedor son TypeScript. Toda la lógica que decide
el producto (orquestar agentes, pool MCP, permisos, presupuesto, synthesizer de
subagentes, redacción antes de persistir) tiene que vivir donde vive el SDK: en
el sidecar. El daemon Rust quedaría como store, scheduler y host de PTY, y cada
evento del SDK cruzaría una frontera IPC extra antes de persistirse.

Keel lo desarrolla una persona. El diseño ya es grande (≈130 pantallas). Dos
lenguajes y dos toolchains son el mayor riesgo de no llegar al dogfooding.

## Decisión

1. **El daemon se escribe en TypeScript y corre sobre Bun.** SQLite nativo
   (`bun:sqlite`), sockets Unix con `Bun.listen`, procesos con `Bun.spawn`. El
   sidecar del SDD desaparece como proceso separado: el daemon _es_ el proceso
   que habla con los SDKs.
2. **El contrato IPC (ADR-0005) se fija como si el daemon fuera a
   reescribirse.** Ningún cliente sabe en qué está escrito el daemon. Una
   reescritura en Rust es un reemplazo de proceso, no un cambio de clientes.
3. **La TUI puede ser Rust/Ratatui desde el día uno** porque sólo habla el
   protocolo. Se decide cuando toque (SDD 04, Fase 4); no es parte de esta
   decisión.
4. **La GUI es Tauri v2 con React**, como el SDD. El backend Rust de Tauri es
   mínimo: abre el socket al daemon y expone comandos nativos (abrir editor, PTY
   local). No duplica lógica.
5. **Rust para el daemon se reabre con evidencia**, no con preferencia.
   Disparadores concretos: el PTY no se puede hostear de forma fiable desde Bun
   en Windows/WSL2; la latencia de ingesta bajo 50,000 eventos (SDD 04, Fase 7)
   no cumple; o el binario único (`bun build --compile`) no sirve como
   distribución.
6. **Condición de este ADR:** el spike tiene que demostrar que el Claude Agent
   SDK y el Codex SDK corren bajo Bun con paridad (ADR-0007 de Mirador ya avisó
   que el Agent SDK gestiona un CLI y procesos hijo y que ahí «no se asume
   paridad Bun/Node»). Si no hay paridad, el daemon corre sobre Node LTS y todo
   lo demás de este ADR se mantiene.

## Evidencia del spike (2026-10-08, `spikes/sdk-capabilities/FINDINGS.md`)

El Claude Agent SDK 0.3.295 corrió bajo Bun 1.4.2 con
`pathToClaudeCodeExecutable`, hooks in-process y un subagente, sin adaptación.
El Codex SDK 0.162.0 arrancó thread y turno bajo Bun; la corrida completa quedó
pendiente por cuota de la cuenta. La condición del punto 6 se da por cumplida
para Claude; Codex se confirma en la siguiente corrida.

## Consecuencias

**Positivas**

- Un lenguaje, un toolchain, el SDK en el mismo proceso que el store: el camino
  más corto al MVP.
- `@keel/core` (Zod, correlación) se usa directo en el daemon.
- La frontera IPC fija protege la opción Rust sin pagarla ahora.

**Negativas**

- PTY en TypeScript depende de un módulo nativo (`node-pty` o equivalente) y hay
  que verificarlo en WSL2 y Windows. Es el primer disparador del punto 5.
- `zeroize` y las garantías de memoria del SDD 02 §6 no existen en un runtime
  con GC. El vault guarda referencias; los secretos viven el menor tiempo
  posible en memoria y eso es todo lo que se promete.
- La TUI en Rust y el daemon en TS son dos toolchains igualmente. Aceptado: la
  TUI es cliente fino y llega después.

## Alternativas consideradas

- **Rust daemon + sidecar Node (SDD 02 tal cual).** Defendible y no rechazada
  para siempre; diferida por costo de llegar al dogfooding en solitario.
- **Node LTS en vez de Bun.** Es el fallback del punto 6. No se elige de entrada
  porque Bun da SQLite, sockets y compilación a binario sin dependencias.
- **Todo en Rust, SDKs vía subproceso `claude -p --output-format stream-json`.**
  Rechazada: pierde hooks in-process, `canUseTool` y el control programático que
  justifica el modo runtime.
