# Codex por Keel con el transporte `app_server` · 2026-10-22

Corrida real del transporte `app_server` de ADR-0008, con el puente de ADR-0009
y el gate de aprobaciones de Keel. Se hizo con el permiso del humano y su sesión
de ChatGPT, con `codex-cli` 0.162.1, `gpt-5.6-luna` con esfuerzo `low` y Linux
sobre WSL2.

## Montaje

Daemon con `--codex-subscription --codex-model gpt-5.6-luna` (`app_server` es el
transporte por defecto) y `cli.ts run … --profile codex`. El prompt pedía dos
cosas: usar `task_current` y ejecutar `curl -sI https://example.com`, y pedir
permiso si el sandbox lo bloqueaba. La aprobación se denegó a mano con
`cli.ts deny`.

## Resultado

| Qué        | Observado                                                                                                                                  |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Final      | `completed`; `cost_kind: unknown`; 64 189 tokens de entrada y 673 de salida.                                                               |
| Puente     | `mcp__keel__task_current` `succeeded`. Vínculo después de `thread/started` y `turn/started`, antes de la primera tool.                     |
| Sandbox    | El primer `curl` falló dentro del sandbox con `exit 6` (sin red ni DNS).                                                                   |
| Aprobación | Codex pidió salir del sandbox. Al gate de Keel llegó `Bash` con el comando, el `cwd` del worktree y el motivo («¿Me permites ejecutar…?»). |
| Denegación | `cli.ts deny` → `decline`. El item quedó `failed` con «denegado por Keel». Codex no lo ejecutó y lo explicó en su respuesta.               |
| Proceso    | `provider_process` con pid, `started_at` de `/proc` y ejecutable. Es `node`: el `codex` del PATH es un shim (spike, hallazgo 4).           |
| Cierre     | Al terminar, el app-server ya no existía y `run-tokens/` quedó vacío.                                                                      |

## Lo que esto no prueba

- **Que matar el shim mate al binario nativo** cuando la reconciliación termina
  un huérfano. Al cerrar stdin sí sale todo (spike, prueba 6).
- **La aprobación de `file_change` y `permissions`.** Sólo `command` está
  verificado; es lo único que declara `approval_kinds`.
- **Windows.** No hay `codex` instalado allí.
