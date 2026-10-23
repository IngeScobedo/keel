# Claude Code por Keel con el puente `keel mcp` · 2026-10-22

Corrida real del adaptador de Claude con el puente MCP de ADR-0009. Se hizo con
el permiso del humano y su sesión de suscripción, con Claude Code 2.1.304, el
Agent SDK 0.3.295, el modelo `haiku` y Linux sobre WSL2.

## Montaje

Igual que la corrida de Codex (`2026-10-22-codex-keel-mcp-real.md`): repo de
prueba con un commit, daemon con base y estado en un temporal, socket en una
ruta corta y `cli.ts run` con un run `execute`, esta vez sin `--profile` (es
decir, Claude).

## Resultado

| Qué     | Observado                                                                                                     |
| ------- | ------------------------------------------------------------------------------------------------------------- |
| Final   | `completed`; `cost_kind: estimated`, 0.0046 USD.                                                              |
| Orden   | `session.agent_bound` (#8) antes de `hook.UserPromptSubmit` (#9) y de `sdk.system` `init` (#10).              |
| `init`  | `mcp_servers: [{ name: "keel", status: "connected", source: "dynamic" }]`.                                    |
| Tools   | `mcp__keel__task_current` y `mcp__keel__note_add`, ambas `succeeded`, sin pasar por el gate (auto-aprobadas). |
| Autoría | La nota quedó con autor `agent:<run>`.                                                                        |
| Token   | El directorio `run-tokens/` quedó vacío.                                                                      |

Con `alwaysLoad: true`, el SDK espera a que el servidor conecte, y el puente se
vincula antes de responder `initialize`. Por eso el token se consume antes del
primer turno: el supuesto de ADR-0009 §3 se cumple con Claude.

## Lo que esto no prueba

- El tope de 5 s de conexión del SDK: si el daemon tarda más en vincular, el
  arranque sigue sin esperar.
- Windows.
