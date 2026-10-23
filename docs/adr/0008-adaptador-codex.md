# ADR-0008: Adaptador de Codex

- **Estado:** Aceptado (por el humano, 2026-10-22). El transporte App Server
  entra según lo que mida su spike; si cambia la decisión, se supersede.
- **Fecha:** 2026-10-23
- **Criticidad:** Alta
- **Relacionados:** ADR-0002 (autenticación y costo), ADR-0003 §8 (la paridad de
  Codex se decide aquí), ADR-0006, ADR-0007 §7 (`ProviderAdapter`), ADR-0009
  (tools por MCP), SDD 02 §8 y §9, SDD 04 Fase 1

## Contexto

El segundo proveedor es lo que valida la interfaz `ProviderAdapter` (ADR-0007
§7) antes de moverla a `@keel/agent-runtime`. Lo medido con `@openai/codex-sdk`
0.162.0 (spike del 2026-10-09 y tipos del paquete):

| Aspecto       | Codex SDK                                                                                                                                              | Claude Agent SDK, para comparar                                 |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------- |
| Runtime       | Corre bajo Bun: `startThread` y `runStreamed`.                                                                                                         | Igual.                                                          |
| Eventos       | `thread.started`, `turn.*`, `item.started/updated/completed`; items `agent_message`, `command_execution`, `file_change`, `mcp_tool_call`, `error`.     | Mensajes más hooks.                                             |
| Subagentes    | No hay jerarquía ni `parent`.                                                                                                                          | `agent_id` y `parent_tool_use_id`.                              |
| Aprobación    | No hay callback por herramienta: `approvalPolicy` (`never`, `on-request`, `on-failure`, `untrusted`) y `sandboxMode` (`read-only`, `workspace-write`). | `canUseTool` por herramienta, gate de Keel con deny-on-timeout. |
| Proceso       | Sólo `codexPathOverride`; el SDK lanza `codex exec` por su cuenta.                                                                                     | `spawnClaudeCodeProcess`: Keel lanza y conoce el pid.           |
| Errores       | `turn.failed` y `error` con un mensaje de texto, sin código.                                                                                           | Códigos (`authentication_failed`, `rate_limit`…).               |
| Costo         | Sólo tokens (`input`, `cached_input`, `output`, `reasoning_output`).                                                                                   | `total_cost_usd` estimado.                                      |
| Cancelación   | `signal` por turno.                                                                                                                                    | `AbortController`.                                              |
| Autenticación | Login de ChatGPT del CLI `codex` o `apiKey`/`OPENAI_API_KEY`.                                                                                          | Sesión del `claude` del usuario o `ANTHROPIC_API_KEY`.          |

La investigación del humano (2026-10-22) señaló que el SDK no es toda la
superficie de integración de Codex. Se comprobó con `codex-cli` 0.162.1, sin
correr ningún turno:

- **`codex app-server` existe y su ayuda lo marca experimental.** Habla JSON-RPC
  por `stdio://` (por defecto), `unix://` o `ws://`, y
  `codex app-server generate-json-schema` emite el esquema de la versión
  instalada.
- **Solicitudes del servidor al cliente**, entre otras:
  - `item/commandExecution/requestApproval`, `item/fileChange/requestApproval` y
    `item/permissions/requestApproval`.
  - `mcpServer/elicitation/request` e `item/tool/call` (tools que declara el
    cliente).
  - Decisiones sobre un cambio de archivo: `accept`, `acceptForSession`,
    `decline` (el turno sigue) y `cancel` (interrumpe el turno). Las de un
    comando añaden enmiendas de execpolicy y de red que persisten en Codex.
- **Errores con código** (`CodexErrorInfo`): `unauthorized`,
  `usageLimitExceeded`, `rateLimitExceeded`, `serverOverloaded`,
  `contextWindowExceeded`, `sandboxError` y
  `httpConnectionFailed { httpStatusCode }`, entre otros, con `willRetry`.
- **Cuota y tokens:** `account/rateLimits/read`, la notificación
  `account/rateLimits/updated` y `thread/tokenUsage/updated`.
- **`codex login status`:** sale con 0 y «Logged in using ChatGPT» con sesión, y
  con 1 y «Not logged in» con un `CODEX_HOME` vacío. Existe
  `codex login --device-auth`.
- **El SDK no expone el proceso.** `CodexExec.run` hace `spawn` de `codex exec`
  y no devuelve el `ChildProcess`. Con `apiKey` la pasa al hijo como
  `CODEX_API_KEY`.

Los términos de OpenAI para usar el login de ChatGPT desde un producto de
terceros siguen sin verificar para distribución comercial (ADR README,
«Decisiones abiertas»). La documentación de OpenAI sí contempla usar Codex CLI
con el login de ChatGPT, y sus términos prohíben compartir cuentas o revender el
acceso.

## Decisión

1. **Un adaptador y dos transportes.** `CodexProviderAdapter` traduce a lo que
   Keel entiende (`RunContext`, `RunSignals`, tool calls). Debajo hay una
   interfaz `CodexTransport` con dos implementaciones:
   - **`sdk`** (`@openai/codex-sdk`): se implementa primero y sirve para runs
     desatendidos.
   - **`app_server`** (`codex app-server` lanzado por Keel por stdio): es el
     candidato para aprobaciones, sesiones largas y control del proceso. Se
     decide con el spike de abajo. Como es experimental, Keel fija la versión
     mínima probada y versiona como fixture el esquema generado de esa versión;
     si el `codex` instalado lo cambia, el preflight lo dice.
   - El scheduler, el store y la UI no saben qué transporte corre: leen las
     capacidades (§9).
2. **Autenticación.**
   - Hay dos modos técnicamente soportados: `api_key` y `subscription_session`.
   - `subscription_session` es la sesión del usuario en su propio `codex`, en el
     mismo entorno donde corre el run. WSL y Windows tienen sesiones distintas,
     y `CODEX_HOME` cuenta. Keel no copia `auth.json` entre entornos (ADR-0002).
   - El preflight corre `codex --version` y `codex login status` con el binario,
     el entorno y el `CODEX_HOME` del run. Si la salida no es 0, el run no
     arranca y la UI dice: «ejecuta `codex login` en tu terminal, o
     `codex login --device-auth` si no hay navegador».
   - Keel no conduce el login: no usa `account/login/start` del App Server ni
     teclea en una terminal. Como mucho abre una terminal con el comando, y el
     usuario la maneja (ADR-0002 §1). Confirmado por el humano.
   - Un preflight correcto no garantiza la inferencia. Un `unauthorized` a mitad
     del run se clasifica como fallo de autenticación (`provider_login`), y no
     hay fallback a `api_key` ni al revés.
   - Habilitación: `subscription_session` va detrás de una opción explícita del
     usuario, para uso local con su propia cuenta (confirmado por el humano).
     Distribuir o comercializar Keel con este modo exige que el humano anote
     aquí la verificación de términos. Nunca una cuenta para varios usuarios, ni
     un Keel central que ejecute con la sesión de otro.
3. **Aprobaciones por capacidad.** `ProviderCapabilities.tool_approval` pasa a
   `approval.kinds` (`command`, `file_change`, `permissions`, `mcp_tool`),
   declarado por transporte.
   - **`sdk`:** `kinds: []`. Los runs `plan` y `triage_eval` usan
     `sandboxMode: "read-only"`. Los runs `execute` usan `workspace-write` en el
     worktree, `networkAccessEnabled: false` y `approvalPolicy: "never"`: lo que
     necesitaría aprobación falla en vez de colgarse. El scheduler no le asigna
     perfiles que exijan aprobación.
   - **`app_server`:** sus solicitudes de aprobación entran al `ApprovalGate` de
     Keel, con el mismo inbox y el mismo deny-on-timeout que Claude. Keel sólo
     responde `accept`, `decline` o `cancel`. No usa `acceptForSession` ni las
     enmiendas de execpolicy o de red, porque dejarían permisos fuera de lo que
     Keel registra.
   - Un transporte declara un `kind` sólo cuando una prueba de integración
     demuestra que Codex respeta la denegación.
4. **El worktree no es una frontera de seguridad.** Organiza los cambios. La
   frontera es el sandbox de Codex (`workspace-write` con la red apagada), y se
   mide por plataforma (Linux, WSL y Windows) antes de declararla: escritura
   fuera del worktree, procesos hijos y red. Mientras no haya medida, la UI
   muestra el sandbox como «declarado, sin verificar».
5. **Proceso.** Se descarta atribuir el pid por ppid y hora de arranque: es
   frágil con dos runs a la vez y con la reutilización de pids.
   - **`sdk`:** `process_control: "indirect"`. Keel no conoce el pid. Cancela
     con el `signal` del turno, y tras un reinicio del daemon marca el run
     `interrupted`, nunca `completed`. Cada run es un hijo con su propio stdout,
     así que dos runs no mezclan eventos. La concurrencia la limita `limits.ts`
     como a cualquier run.
   - **`app_server`:** `process_control: "owned"`. Keel lanza
     `codex app-server`, uno por run salvo que el spike muestre otra cosa.
     Registra pid, arranque y ejecutable con `processes.ts` y lo reconcilia como
     a Claude. No usa el app-server compartido del usuario
     (`codex app-server daemon`).
6. **Eventos y errores.** Cada transporte traduce sus eventos a `RunContext` y
   su final a `RunSignals` (`run-outcome` de `@keel/core`).
   - **`sdk`:** reglas por mensaje, versionadas y probadas con fixtures
     redactados.
   - **`app_server`:** una tabla desde `CodexErrorInfo`.
   - Lo que no se reconoce queda como `unknown`, nunca como éxito. Los eventos
     originales se guardan redactados (`RunContext.ingest`).
7. **Tokens, dinero y cuota van por separado.**
   - **Tokens:** observados; se guardan siempre.
   - **Dinero:** `cost_kind = unknown` con `subscription_session`. Con `api_key`
     también, hasta tener una tabla de precios con fuente y versión; entonces
     pasa a `estimated`.
   - **Cuota:** si el transporte la da (`account/rateLimits/*`), se muestra como
     porcentaje de cada ventana, igual que el `rate_limit_event` de Claude.
     Nunca como «tokens restantes del plan».
   - **Contención propia de Keel:** tiempo máximo (`max_wall_ms`), tokens de
     salida por run y concurrencia. El presupuesto en USD de `limits.ts` no
     aplica a Codex. Esta contención no es un límite exacto del gasto.
8. **Identidad de agentes.** Sin subagentes nativos, cada run de Codex es un
   nodo raíz y los workers los programa Keel (SDD 02 §8, ADR-0002 §4).
   `command_execution`, `file_change` y `mcp_tool_call` se proyectan como tool
   calls con su `id`. Si un transporte expone relaciones entre agentes
   verificables, se representan; si no, no se inventan.
9. **Interfaz.** Las capacidades se resuelven en el preflight según el
   transporte y la versión instalada: `auth_modes`, `approval.kinds`,
   `process_control` y `budget_unit`. `ProviderAdapter` se corrige con Claude y
   Codex reales antes de moverlo a `@keel/agent-runtime` (ADR-0007 §3), sin
   abstraer capacidades que un proveedor no tiene.

## Spike del App Server

Decide si `app_server` entra y con qué capacidades. Cada prueba que corre un
turno consume la cuenta del humano; dio permiso para correrlo con su cuenta de
ChatGPT. Lo que no requiere aprobaciones se repite con el transporte `sdk`.

| Prueba                | Criterio                                                                         |
| --------------------- | -------------------------------------------------------------------------------- |
| Turno con suscripción | Un turno completo por stdio con la sesión del usuario, sin API key.              |
| Sin sesión            | Con `CODEX_HOME` vacío el preflight lo detecta y el run no arranca.              |
| Aprobación            | Keel deniega un comando y Codex no lo ejecuta; el timeout produce `decline`.     |
| Concurrencia          | Dos runs a la vez no mezclan procesos ni eventos.                                |
| Cancelación           | `turn/interrupt` termina el run como `cancelled`.                                |
| Reinicio del daemon   | El run queda `interrupted` y no quedan procesos huérfanos.                       |
| Aislamiento           | Escribir fuera del worktree o abrir la red falla en Linux, WSL y Windows.        |
| Sesión caducada       | `unauthorized` se clasifica como `provider_login`, sin fallback de credenciales. |
| Fixture               | Eventos reales redactados y el esquema de la versión probada quedan en el repo.  |

## Consecuencias

- `ProviderCapabilities` gana `auth_modes`, `approval.kinds`, `process_control`
  y `budget_unit` (`"usd" | "tokens"`), resueltos por transporte.
- Los mensajes del App Server cruzan un proceso: Keel los valida con Zod para el
  subconjunto que usa. El esquema generado sirve para detectar cambios de
  versión, no para tipar a mano.
- `ProcessTable` ya no necesita listar hijos por ppid.
- Hace falta un fixture redactado de una corrida real de Codex por transporte,
  grabado con el spike.
- `item/tool/call` (tools que declara el cliente) es otra vía para dar a Codex
  las tools de Keel. No cambia ADR-0009: se evalúa en el spike.
- El humano tiene pendiente verificar los términos de OpenAI para distribuir
  Keel con `subscription_session` y anotarlo aquí.

## Alternativas consideradas

- **Prometer con el SDK el mismo gate por herramienta que con Claude.** No es
  posible sin `canUseTool`. Fingirlo sería peor que decirlo.
- **Lanzar `codex exec` sin el SDK.** Daría el pid y el stream, pero duplica lo
  que el SDK mantiene. El App Server da el proceso propio con un protocolo
  versionado, así que esta opción queda descartada.
- **Sólo App Server desde el principio.** Es experimental; el SDK ya cubre los
  runs desatendidos mientras el spike decide.
- **Atribuir el pid del SDK por ppid y hora de arranque.** Fue la decisión de la
  primera versión de este ADR; se descarta por §5.
- **Sólo `api_key` hasta verificar los términos.** Fue la primera versión de §1.
  Mezclaba el soporte técnico con la verificación contractual. Ahora el uso
  local con la propia cuenta va detrás de una opción explícita, y la
  distribución espera a los términos.
- **Que Keel conduzca el login** con `account/login/start`. Contradice ADR-0002
  §1.
