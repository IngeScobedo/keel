# ADR-0008: Adaptador de Codex

- **Estado:** Propuesto
- **Fecha:** 2026-10-23
- **Criticidad:** Alta
- **Relacionados:** ADR-0002 (autenticación y costo), ADR-0003 §8 (la paridad de
  Codex se decide aquí), ADR-0006, ADR-0007 §7 (`ProviderAdapter`), SDD 02 §8,
  SDD 04 Fase 1

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

Los términos de OpenAI para usar el login de ChatGPT desde un producto de
terceros siguen sin verificar (ADR README, «Decisiones abiertas»).

## Decisión

1. **Modo de autenticación: sólo `api_key` hasta verificar los términos.** El
   adaptador declara `auth_modes: ["api_key"]`. El modo `subscription_session`
   (login del CLI `codex`) existe en el diseño, pero el preflight lo rechaza con
   una salida explícita hasta que el humano anote aquí la verificación. No hay
   fallback entre modos (ADR-0002).
2. **Seguridad sin gate por herramienta.** Como no hay `canUseTool`, el
   adaptador no promete el gate de SDD 02 §9. En su lugar:
   - Runs `plan` y `triage_eval`: `sandboxMode: "read-only"`.
   - Runs `execute`: `sandboxMode: "workspace-write"` confinado al worktree del
     run, `networkAccessEnabled: false` por defecto y `approvalPolicy: "never"`.
     Lo que necesitaría aprobación falla en vez de colgarse.
   - `ProviderCapabilities.tool_approval = false`. La UI lo dice y el scheduler
     no asigna a Codex tareas cuyo perfil exija aprobación por herramienta.
3. **Proceso.** Keel no lanza `codex` directamente. Tras `thread.started`,
   identifica el hijo con `ProcessTable` (hijos del daemon cuyo ejecutable es el
   `codex` detectado y que arrancaron después del run) y registra pid, arranque
   y ejecutable (processes.ts). Con dos runs de Codex a la vez la atribución es
   ambigua; mientras no se resuelva, el límite de concurrencia aplica por
   proveedor y Codex corre de a uno.
4. **Errores.** `turn.failed` y `error` llegan como texto. El adaptador los
   traduce a `RunSignals` (run-outcome de `@keel/core`) con reglas por mensaje,
   versionadas y probadas con fixtures redactados. Lo que no reconoce queda como
   `unknown`, nunca como éxito.
5. **Costo y presupuesto.** `cost_kind = unknown` (ADR-0002 §3); se guardan los
   tokens. El presupuesto en USD de limits.ts no se puede aplicar a Codex: el
   límite por run pasa a ser de tokens de salida, y el diario cuenta sólo lo
   estimable. La UI muestra «tokens», nunca dólares inventados.
6. **Identidad de agentes.** Sin subagentes nativos: cada run de Codex es un
   nodo raíz; los workers los programa Keel (SDD 02 §8, ADR-0002 §4).
   `command_execution`, `file_change` y `mcp_tool_call` se proyectan como tool
   calls con su `id`.
7. **Interfaz.** Con Codex implementado, `ProviderAdapter` se corrige con los
   dos casos reales y se mueve a `@keel/agent-runtime` (ADR-0007 §3).

## Consecuencias

- `ProviderCapabilities` gana `cost_kind` por proveedor, que ya existe, y una
  capacidad de presupuesto (`budget_unit: "usd" | "tokens"`).
- `ProcessTable` necesita listar hijos por ppid, además de `get(pid)`.
- Hace falta un fixture redactado de una corrida real de Codex para el oráculo,
  grabado con el spike.
- El humano tiene pendiente verificar los términos de OpenAI para el login de
  ChatGPT y anotarlo aquí.

## Alternativas consideradas

- **Prometer el mismo gate por herramienta que con Claude.** No es posible sin
  `canUseTool`. Fingirlo sería peor que decirlo.
- **Lanzar `codex exec` sin el SDK.** Daría el pid y el stream, pero duplica lo
  que el SDK mantiene y se rompe con cada versión del CLI. Se reabre si la
  atribución del proceso resulta poco fiable.
- **Permitir ya el login de ChatGPT.** Funciona mecánicamente (spike), pero sin
  verificar los términos se contradice ADR-0002.
