# Hallazgos del spike

Máquina: WSL2 (Linux 6.6), Bun 1.4.2, Node 24.21, Claude Code 2.1.295 instalado
en `~/.local/bin/claude`, `@anthropic-ai/claude-agent-sdk` 0.3.295,
`@openai/codex-sdk` 0.162.0, `codex` CLI 0.162.0, tmux 3.4, SQLite 3.53.2
(`bun:sqlite`), `sqlite-vec` 0.1.9. Sin `ANTHROPIC_API_KEY` ni `OPENAI_API_KEY`
en el entorno.

**Autenticación con la que corrió todo:** la sesión de suscripción que el
usuario ya tenía en Claude Code (`init.apiKeySource: "none"`) y el login de
ChatGPT que `codex` ya tenía («Logged in using ChatGPT»). Keel no leyó ningún
archivo de credenciales: los probes sólo apuntan el SDK al binario instalado.
Ver ADR-0002 y ADR-0003 §1.1 sobre lo que la documentación oficial permite.

## Primera corrida (2026-10-08) — capacidades

### Claude Agent SDK

| Pregunta                             | Resultado medido                                                                                                                                                                                                                                                                                   |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ¿Corre bajo Bun?                     | Sí. `query()` con `pathToClaudeCodeExecutable` al `claude` del usuario, hooks in-process y un subagente, sin adaptación.                                                                                                                                                                           |
| ¿Con qué se autenticó?               | `init.apiKeySource: "none"` y la query tuvo éxito. El binario usó la sesión de `/login` del usuario.                                                                                                                                                                                               |
| ¿Cómo se ve la suscripción?          | Llega un `rate_limit_event` con `rateLimitType`, `utilization` por ventana (`five_hour`, `seven_day`), `resetsAt` y `overageStatus`. Es el dato para la UI de «cuota».                                                                                                                             |
| ¿Qué reporta el costo?               | `total_cost_usd: 0.00604` y `modelUsage[...].costUSD` con `costBasis: "list"` y `provider: "firstParty"`, **aunque no hay facturación por API**. Estimación a precio de lista → `cost_kind = estimated`.                                                                                           |
| ¿Tokens?                             | `usage` completo: input, output, cache_creation, cache_read, thinking_tokens, iteraciones por mensaje.                                                                                                                                                                                             |
| ¿Identidad de subagente en mensajes? | Los mensajes del subagente traen `agent_id` (`acd80ec38e2940285`) y `parent_tool_use_id` = id del bloque `tool_use` `Agent` del mensaje padre. `parent_derivable: true`. **Es el caso observado que justifica `parent_source = 'sdk'`** (captura del 2026-10-09T01:42Z, `claude-messages.ndjson`). |
| ¿Identidad en hooks?                 | `SubagentStart` y `SubagentStop` traen `agent_id`, `agent_type` y `prompt_id`. Los hooks de tool dentro del subagente traen `agent_id`; los del hilo principal no.                                                                                                                                 |
| Detalle a vigilar                    | El `toolUseID` del callback de `SubagentStart`/`SubagentStop` es un UUID, **no** el `toolu_…` del bloque `Agent`. Unir hook ↔ mensaje por `agent_id`.                                                                                                                                              |
| Duraciones                           | `duration_ms: 1811` contra `duration_api_ms: 14044` y `wall_ms: 11252`. `duration_ms` del runtime no es tiempo de pared.                                                                                                                                                                           |

### Codex SDK (corrida completa el 2026-10-09, `bun run spike:codex`)

| Pregunta               | Resultado medido                                                                                                                                       |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| ¿Corre bajo Bun?       | Sí: `new Codex({ env })`, `startThread`, `runStreamed`; `turn.completed` en 13.4 s.                                                                    |
| ¿Con qué se autenticó? | Login de ChatGPT del CLI. La primera corrida falló por límite de uso de la cuenta, no por auth.                                                        |
| ¿Costo?                | `usage` sólo en tokens: `input_tokens 30862`, `cached_input_tokens 27520`, `output_tokens 140`, `reasoning_output_tokens 66`. **Sin USD** → `unknown`. |
| ¿Eventos e ids?        | `thread.started`, `turn.started`, `item.started`, `item.completed`, `turn.completed`; items `agent_message` y `command_execution`, cada uno con `id`.  |
| ¿Subagentes?           | Nada en la superficie: ni jerarquía ni `parent`. Keel programa workers independientes (SDD 02 §8).                                                     |

## Segunda corrida (2026-10-09) — caminos de fallo, PTY y SQLite

Comandos:
`bun src/failure-probes.ts <cancel|sigkill|late-permission|concurrent|lag>`,
`bun src/tmux-probe.ts`, `bun run docs:validate-ddl`. Reportes en
`captures/report-failures.json`, `captures/report-tmux.json`.

### 1. Cancelación con `AbortController` a mitad de un tool call

Prompt que ejecuta `sleep 20`; `abort()` 1.5 s después de `PreToolUse`.

| Medida                               | Valor                                                                  |
| ------------------------------------ | ---------------------------------------------------------------------- |
| `PreToolUse` → `abort()` → excepción | 5961 ms → 7465 ms → 9471 ms (2 s entre abort y fin del generador)      |
| Cómo termina                         | `query()` **lanza** `Error: Claude Code process aborted by user`       |
| Mensaje `result`                     | **No llega.** Último mensaje: `system`.                                |
| Hooks tras el abort                  | Ni `PostToolUse`, ni `PostToolUseFailure`, ni `Stop`, ni `SessionEnd`. |
| Procesos `claude` del run tras 2 s   | Ninguno.                                                               |

Conclusión: termina limpio, pero **sin estado terminal**: Keel tiene que
sintetizar `cancelled` para el run y `cancelled` para el tool call en vuelo, y
tratar la excepción como fin normal.

### 2. `SIGKILL` al proceso «daemon» con un run vivo

Proceso hijo de Bun corriendo `query()` con `sleep 45`; `SIGKILL` 1.5 s después
de `PreToolUse`.

| Medida                             | Valor                                                                                                                  |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Subárbol del hijo antes de matarlo | `claude --output-format stream-json …`, `bash -c …`, `sleep 45`                                                        |
| Supervivientes 3 s después         | **Los tres.** `claude` reparentado a pid 699 (subreaper de WSL), bash y sleep colgando de él.                          |
| ¿Se pueden reconciliar?            | Por `cwd` (`/proc/<pid>/cwd` = cwd del run): sí. Por `session_id` en args: **no**, no aparece en la línea de comandos. |
| Limpieza                           | `SIGKILL` a los tres → 0 supervivientes.                                                                               |

Conclusión: un daemon que muere deja procesos `claude` huérfanos **vivos y
consumiendo turnos**. La reconciliación al arrancar es requisito del MVP
(ADR-0003): el daemon persiste `pid` + `cwd` + `session_id` por run antes del
spawn, y al arrancar mata o adopta lo que encuentre.

**Error en la primera versión de este probe**, anotado para que no se repita: la
primera corrida buscaba procesos por el nombre `claude` en todo el sistema y
**mató tres procesos de otra sesión de Claude Code del usuario** (un hook y un
`nx run-many` en `casa-matte-monorepo`). El probe se corrigió para mirar sólo el
subárbol del proceso hijo, y la regla queda en ADR-0003: Keel nunca juzga ni
mata procesos por nombre, sólo por pid registrado.

### 3. Hook y `canUseTool` que responden tarde

| Caso                                                              | Resultado                                                                                                                                                                                                                                                   |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Hook `PreToolUse` con `timeout: 3` que responde `allow` a los 8 s | A los 3 s el SDK cancela el hook (`signal.aborted: true`), **no ejecuta la herramienta** y el modelo recibe `PreToolUse hook did not respond before its timeout (host client may be unreachable)`. Reintentó una vez con el mismo resultado. Deny efectivo. |
| `canUseTool` que responde `allow` a los 8 s                       | **Se honra**: la herramienta corrió y el run terminó `success`. No hay timeout del SDK a 8 s.                                                                                                                                                               |

Conclusión: el SDK aplica timeout a los hooks, no a `canUseTool`. El
`deny-on-timeout` del SDD 02 §9 es **responsabilidad del daemon**: un
temporizador propio que responde `deny` y deja la solicitud en el inbox durable.

### 4. Tres sesiones concurrentes

Tres `query()` en paralelo (`echo alpha|bravo|charlie`), hooks `PreToolUse`,
`PostToolUse` y `Stop` etiquetados por `session_id`.

| Medida                                      | Valor                   |
| ------------------------------------------- | ----------------------- |
| Sesiones distintas                          | 3                       |
| Hooks por sesión / sesiones vistas en ellos | 3 / exactamente la suya |
| Mensajes con `session_id` ajeno             | 0                       |
| Respuesta correcta por run                  | 3 de 3                  |

Conclusión: aislamiento correcto en el proceso único; la clave de correlación es
`session_id` y viene en todo.

### 5. Lag del event loop con escritura grande en `bun:sqlite`

Dentro de un hook `PreToolUse`, inserción síncrona de 50,000 filas de 2 KB en
una transacción (102.7 MB en disco), `synchronous=FULL`, WAL.

| Medida                                         | Valor      |
| ---------------------------------------------- | ---------- |
| Escritura en el hilo principal                 | 718 ms     |
| Mayor hueco del event loop durante el run      | **711 ms** |
| Misma escritura en un `Worker`                 | 731 ms     |
| Mayor hueco del hilo principal con el `Worker` | 2 ms       |

Conclusión: una escritura grande síncrona bloquea el loop exactamente lo que
dura, y con ello cualquier hook o `canUseTool` pendiente. Ingesta pesada en un
`Worker` y transacciones cortas en el hilo principal son obligatorias (ADR-0003,
consecuencias negativas).

### 6. tmux en control mode como host de terminales (`bun src/tmux-probe.ts`)

Servidor aislado (`-L keel-probe`), sesión por run, cliente `tmux -C attach`.

| Capacidad                         | Resultado                                                                                                             |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Crear sesión por run con tamaño   | OK (80x24)                                                                                                            |
| Salida estructurada               | `%output %0 …` con escapes octales; también `%begin/%end`, `%session-changed`, `%layout-change`                       |
| Enviar input                      | `send-keys` → el eco llega por `%output`                                                                              |
| Redimensionar                     | `refresh-client -C 120x40` + `resize-window` → `tput` reporta 120x40                                                  |
| Desconectar el cliente de control | La sesión sigue viva                                                                                                  |
| Reconectar                        | Segundo cliente recibe salida nueva; `capture-pane -S -200` recupera el scrollback (41 líneas, incluye el primer eco) |

Conclusión: tmux cubre el host de PTY en POSIX/WSL2 sin módulo nativo. El módulo
nativo queda sólo para Windows nativo (no probado).

### 7. DDL sobre el SQLite de Bun (`bun run docs:validate-ddl`)

`scripts/validate-ddl.ts` lee los bloques `sql` del SDD 03 y corre **62
comprobaciones** sobre `bun:sqlite` (SQLite 3.53.2): WAL, `synchronous=FULL`,
FKs, frontera de proyecto, repo principal único, dedupe activo, `idx_live_run`
con `waiting_human`, `interrupted` terminal, `purpose`, estados de nodo, eventos
y actividades append-only, `command_receipts`, versiones y estados de contrato
con evidencia, gates (antes y después de ready, `implemented`, `deprecated`),
reconciliación única, FTS5 en insert/update, claims de research, cross findings,
lanes/worktrees con FKs compuestas, bloqueos, CHECKs de grants y approvals,
**vec0 0.1.9** (KNN particionado por proyecto, dimensión rechazada), outbox que
persiste al reabrir, `foreign_key_check` e `integrity_check`. Resultado: 62 en
verde, 0 fallidas.

`sqlite-vec` en macOS con `Database.setCustomSQLite()`: **pendiente**, no hay
macOS disponible.

### 8. Punta a punta real con el daemon (2026-10-09, `packages/daemon`)

`bun packages/daemon/src/main.ts` +
`cli.ts run "Lista con Glob los .ts de packages/core/src…"` con la sesión de
suscripción del usuario, modelo haiku: 24 eventos persistidos (hooks, mensajes
del SDK, proyecciones), run `completed` con `cost_kind = estimated` y 1,900
µUSD, un tool call `Glob` con `wall_ms 166` contra `duration_ms 43`, proceso
`claude` registrado con pid, cwd y session_id en el manifest del run, y la CLI
recibiendo el stream por `events.subscribe` y saliendo al ver `completed`. El
SDK avisa que `allowedTools` con nombres pelados auto-aprueba antes de
`canUseTool` (`CLAUDE_SDK_CAN_USE_TOOL_SHADOWED`): para gatear todo, el perfil
debe vaciar `allowedTools` y decidir en `PreToolUse`.

## Qué cambia en los ADRs

- ADR-0002: `cost_kind = estimated` con Claude en sesión de suscripción (precio
  de lista) y `unknown` con Codex (sólo tokens); cuota desde `rate_limit_event`.
- ADR-0003: paridad Bun confirmada para ambos SDKs; cancelación sin estado
  terminal; huérfanos tras `SIGKILL` reconciliables por pid+cwd; timeout de
  hooks sí, de `canUseTool` no; concurrencia aislada; bloqueo del loop igual a
  la escritura; tmux como host de PTY.
- ADR-0006: `parent_source = 'sdk'` tiene caso observado (arriba).
