# ADR-0003: Runtime del daemon — TypeScript sobre Bun; Rust sólo por disparador medido

- **Estado:** Propuesto. La dirección está decidida por el humano (2026-10-09);
  el estado lo cambia él. Condiciones resueltas y pendientes en «Evidencia».
- **Fecha:** 2026-10-08 (propuesto), 2026-10-09 (revisado con el spike)
- **Criticidad:** Alta
- **Relacionados:** ADR-0001, ADR-0002 (modo de autenticación), ADR-0004,
  ADR-0005 (el contrato IPC es lo que hace reversible esta decisión); SDD 02 §1,
  §3, §9; `spikes/sdk-capabilities/FINDINGS.md`

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

1. **El daemon se escribe en TypeScript y corre sobre Bun**; Node LTS es el
   fallback si falla la paridad. SQLite nativo (`bun:sqlite`), sockets Unix con
   `Bun.listen`, procesos con `Bun.spawn`. No hay sidecar separado: el daemon
   _es_ el proceso que habla con los SDKs.
2. **El contrato IPC (ADR-0005) se fija como si el daemon fuera a
   reescribirse.** Ningún cliente sabe en qué está escrito el daemon. Una
   reescritura en Rust es un reemplazo de proceso, no un cambio de clientes.
3. **La TUI se decide en la Fase 4** (SDD 04). Puede ser Rust/Ratatui porque
   sólo habla el protocolo; no es parte de esta decisión.
4. **La GUI es Tauri v2 con React.** El cascarón Rust de Tauri es mínimo: abre
   el socket al daemon y expone comandos nativos del host (abrir editor, abrir
   carpeta). **No hostea PTY ni tiene lógica.** El PTY vive sólo en el daemon,
   en el target (nativo, WSL2 o remoto).
5. **Host de terminales:** tmux en control mode (`tmux -C`) en POSIX y WSL2, con
   un servidor propio (`-L keel`) y una sesión por run. El módulo nativo de PTY
   queda reservado para Windows nativo.
6. **Rust para el daemon se reabre con un disparador medido**, no con
   preferencia. Los disparadores, medidos en la máquina de referencia con el
   corpus de 50,000 eventos de la Fase 7:
   - p95 de ingesta por evento (recepción → fila en `events`) por encima de **20
     ms** con el `Worker` de ingesta activo;
   - lag máximo del event loop del hilo principal por encima de **100 ms**
     durante la ingesta;
   - o el host de PTY (punto 5) no funciona de forma fiable en alguna plataforma
     objetivo.
7. **Distribución:** un binario (`bun build --compile`) más las librerías
   nativas al lado (`sqlite-vec`, PTY de Windows, embedder si aplica),
   empaquetado por plataforma. Open source y gratuito, publicado en GitHub.
8. **Paridad Bun/Node como condición:** cumplida para el Claude Agent SDK
   (abajo). La paridad del Codex SDK **sale de este ADR** y pasa al ADR de su
   adaptador.
9. **Procesos hijos:** el daemon registra `pid`, `cwd` y `session_id` de cada
   proceso de proveedor **antes** de que exista, y al arrancar reconcilia por
   pid registrado (adoptar o terminar). Keel nunca juzga ni termina procesos por
   nombre.

### Modo de autenticación (ver ADR-0002 §1)

Keel usa la sesión que el usuario ya tiene en Claude Code y **no lee, copia ni
gestiona credenciales ni archivos de auth**. La documentación oficial del Agent
SDK dice que, salvo aprobación previa, Anthropic no permite que productos de
terceros ofrezcan login o rate limits de claude.ai, incluidos los agentes
construidos sobre el SDK (`code.claude.com/docs/en/agent-sdk/overview`); aplica
aunque Keel no toque la auth y aunque se dirija el `claude` del usuario por
subproceso. El adaptador declara el modo como capacidad por perfil
(`subscription_session`, `api_key`, `bedrock`, `vertex`); el daemon no asume
ninguno; sin fallback silencioso. La confirmación o aprobación la pide el
humano. La mención no oficial de un crédito mensual para el SDK en suscripciones
queda pendiente de verificar en fuente oficial y no se cita como hecho.

## Evidencia (`spikes/sdk-capabilities/FINDINGS.md`)

Versiones: Bun 1.4.2, Claude Code 2.1.295, `@anthropic-ai/claude-agent-sdk`
0.3.295, `@openai/codex-sdk` 0.162.0, tmux 3.4, SQLite 3.53.2 en `bun:sqlite`,
`sqlite-vec` 0.1.9. Todo corrió con la sesión de suscripción del usuario en
Claude Code y el login de ChatGPT del CLI `codex`, sin que Keel tocara
credenciales.

| Condición                                              | Estado                         | Medido                                                                                                                                                                                |
| ------------------------------------------------------ | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude Agent SDK bajo Bun: query, hooks, subagente     | Resuelta                       | 2026-10-08 y 2026-10-09, sin adaptación.                                                                                                                                              |
| Codex SDK bajo Bun                                     | Resuelta aquí, sigue en su ADR | `turn.completed` en 13.4 s; `usage` sólo en tokens. Su paridad y capacidades se deciden en el ADR del adaptador.                                                                      |
| Cancelación con `AbortController` a mitad de tool call | Resuelta con hallazgo          | Termina limpio en 2 s y sin procesos; **sin mensaje `result` ni hooks de cierre**: el daemon sintetiza `cancelled`.                                                                   |
| `SIGKILL` al daemon con run vivo                       | Resuelta con hallazgo          | `claude`, su `bash` y el `sleep` sobreviven reparentados; reconciliables por `cwd`, **no** por `session_id` en args. De ahí el punto 9.                                               |
| Hook / `canUseTool` que responden tarde                | Resuelta con hallazgo          | Hook con `timeout: 3` → el SDK cancela y la herramienta no corre (deny efectivo). `canUseTool` tardío (8 s) **se honra**: el `deny-on-timeout` del SDD 02 §9 lo implementa el daemon. |
| Tres sesiones concurrentes                             | Resuelta                       | 3 sesiones, 0 cruces de `session_id` en hooks ni mensajes, 3/3 respuestas correctas.                                                                                                  |
| Lag del loop con escritura grande en `bun:sqlite`      | Resuelta con hallazgo          | 50,000 filas / 102 MB síncronas: 718 ms de escritura, **711 ms de hueco** en el loop. La misma escritura en un `Worker`: 2 ms de hueco en el hilo principal.                          |
| tmux control mode como host de PTY                     | Resuelta                       | Crear, `%output`, input, resize a 120x40, cliente cerrado sin matar la sesión, reconexión con scrollback.                                                                             |
| DDL sobre el SQLite de Bun                             | Resuelta                       | `bun run docs:validate-ddl`: 62 comprobaciones en verde, vec0 incluido.                                                                                                               |
| Daemon real: IPC + adaptador + CLI de punta a punta    | Resuelta                       | 2026-10-09, `FINDINGS.md` §8: run completado, 24 eventos, costo estimado, proceso registrado para reconciliar.                                                                        |
| `sqlite-vec` en macOS con `setCustomSQLite()`          | Pendiente                      | No hay macOS disponible.                                                                                                                                                              |
| Módulo nativo de PTY en Windows                        | Pendiente                      | No probado; sólo se prueba si hace falta (punto 5).                                                                                                                                   |
| Disparadores del punto 6 con 50,000 eventos            | Pendiente                      | Corpus de la Fase 7; hoy no existe.                                                                                                                                                   |

## Consecuencias

**Positivas**

- Un lenguaje, un toolchain, el SDK en el mismo proceso que el store: el camino
  más corto al MVP.
- `@keel/core` (Zod, correlación) se usa directo en el daemon.
- La frontera IPC fija protege la opción Rust sin pagarla ahora.
- tmux da reconexión y scrollback gratis, que es justo lo que el caso remoto del
  SDD 02 §3 necesita.

**Negativas**

- **Costo del proceso único.** Un bloqueo del event loop retrasa los hooks y
  `canUseTool` y puede convertir una espera en una denegación (medido: 711 ms
  por 100 MB escritos); una excepción no capturada tumba store, scheduler y runs
  a la vez. Mitigaciones **obligatorias desde la Fase 1**: transacciones cortas
  en el hilo principal; ingesta pesada y embeddings en un `Worker`; lag del
  event loop expuesto en Daemon Health; supervisor que reinicie el daemon;
  reconciliación de procesos y leases al arrancar como requisito del MVP.
- `zeroize` y las garantías de memoria del SDD 02 §6 no existen en un runtime
  con GC. El vault guarda referencias; los secretos viven el menor tiempo
  posible en memoria y eso es todo lo que se promete.
- Windows nativo depende de un módulo nativo de PTY que no se ha probado.
- Si la TUI acaba en Rust, son dos toolchains igualmente. Aceptado: la TUI es
  cliente fino y llega después.

## Alternativas consideradas

- **Rust daemon + sidecar Node (SDD 02 tal cual).** Defendible y no rechazada
  para siempre; diferida por costo de llegar al dogfooding en solitario. Se
  reabre con el punto 6.
- **Node LTS en vez de Bun.** Es el fallback del punto 1. No se elige de entrada
  porque Bun da SQLite, sockets y compilación a binario sin dependencias.
- **Todo en Rust, SDKs vía subproceso `claude -p --output-format stream-json`.**
  Rechazada: pierde hooks in-process, `canUseTool` y el control programático que
  justifica el modo runtime.
- **Módulo nativo de PTY en todas las plataformas.** Rechazada por ahora: tmux
  cubre POSIX y WSL2 con reconexión y scrollback incluidos.
