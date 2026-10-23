# Codex por Keel con el puente `keel mcp` · 2026-10-22

Corrida real del adaptador de Codex (ADR-0008, transporte `sdk`) con el puente
MCP de ADR-0009. Se hizo con el permiso del humano y su sesión de ChatGPT, con
`codex-cli` 0.162.1, `@openai/codex-sdk` 0.162.0, Linux sobre WSL2 y el modelo
`gpt-5.6-luna`.

## Montaje

- Repo de prueba con un `README.md` y un commit, todo en un temporal.
- Daemon con `--codex-subscription --codex-model gpt-5.6-luna`, base y estado en
  el temporal y socket en `/tmp/kr/keel/keel.sock` (una ruta corta: AF_UNIX
  limita la longitud).
- `cli.ts run "…" --profile codex`, con un run `execute`.

## Primera corrida: hallazgo

Codex lanzó el puente y este se vinculó (`session.agent_bound`), pero la tool
falló con «MCP tool call requires approval, but approval policy is never». Con
`approvalPolicy: "never"`, Codex bloquea toda tool MCP que no esté aprobada en
su configuración. El doble del SDK de los tests no podía mostrarlo.

Se buscó la clave en la versión instalada sin tocar `~/.codex/config.toml`:
`codex app-server --strict-config` rechaza una clave inventada
(`unknown configuration field`) y acepta
`mcp_servers.<nombre>.default_tools_approval_mode = "approve"`. El adaptador la
pone en los servidores que inyecta Keel: la autoridad la comprueba el daemon en
cada operación (ADR-0009 §5).

## Segunda corrida

| Qué     | Observado                                                                                                     |
| ------- | ------------------------------------------------------------------------------------------------------------- |
| Final   | `completed`.                                                                                                  |
| Vínculo | `codex.thread.started` (#8), `codex.turn.started` (#10), `session.agent_bound` (#11), primera tool MCP (#13). |
| Tools   | `mcp__keel__task_current` y `mcp__keel__note_add`, ambas `succeeded`.                                         |
| Autoría | La nota quedó con autor `agent:<run>`.                                                                        |
| Token   | El directorio `run-tokens/` quedó vacío: el token se consumió y se revocó al terminar.                        |
| Sandbox | El puente llega al socket del daemon: Codex corre sus servidores MCP fuera del sandbox de comandos.           |
| Costo   | `cost_kind: unknown`; 58 318 tokens de entrada y 239 de salida.                                               |

El agente leyó como título de la tarea el prompt recortado: `cli.ts run` usa el
prompt como título. No es un defecto del puente.

## Lo que esto no prueba

- **Orden de arranque.** Con Codex, el vínculo llegó después de `turn.started`
  pero antes de la primera tool. Que un agente con shell no alcance a leer el
  archivo del token antes del vínculo depende de ese orden.
- **Claude con `alwaysLoad`.** Falta una corrida real.
- **Windows.** No hay `codex` instalado allí.

## Cómo repetirla

Con `codex` instalado y sesión iniciada: crear un repo con un commit, arrancar
el daemon como arriba y lanzar `cli.ts run` con `--profile codex` y una tarea
que use `task_current` y `note_add`.
