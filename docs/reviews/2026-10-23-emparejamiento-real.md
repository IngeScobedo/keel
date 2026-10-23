# Sesión externa real con Claude Code y la GUI contra el daemon · 2026-10-23

Prueba real de ADR-0009 §4 (emparejamiento) y §5 (`runs.request`), con permiso
del humano y su suscripción. Se usó Claude Code 2.1.304 con `claude-haiku-5-5`
en WSL2, y un daemon aislado con base, repo y socket propios.

## Montaje

```bash
bun packages/daemon/src/main.ts --db <tmp>/keel.sqlite \
  --socket /run/user/1000/keel-realpair.sock --root <tmp>/repo
claude -p "<prompt>" --model haiku --mcp-config mcp.json --strict-mcp-config \
  --allowedTools "mcp__keel" "Bash(sleep:*)"
```

- `mcp.json` lanza `main.ts mcp` sin token, con `KEEL_SOCKET` y
  `KEEL_CLIENT_NAME`. Así lo abriría el humano «a mano».
- La tarea `KEEL-1` la creó el humano.
- El prompt pedía cinco cosas:
  1. llamar a `task_current`;
  2. si la sesión no estaba aprobada, esperar con `sleep 15` y reintentar;
  3. escribir una nota;
  4. pedir un run `plan`;
  5. crear una tarea.

## Resultado

| Paso               | Observado                                                                                                                     |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| Arranque MCP       | `keel` `connected` en el `init` de Claude Code.                                                                               |
| Sin aprobar        | `task_current` respondió error con el código `6R37BC` y el comando para aprobar. El agente se lo dijo al humano y esperó.     |
| Aprobación         | `cli.ts pair-approve … --task KEEL-1 --scopes tasks:read,notes:write,runs:request`, sin `tasks:write` a propósito.            |
| Tras aprobar       | `task_current` devolvió `KEEL-1` con su especificación.                                                                       |
| Nota               | Autor `agent:ext:<pairing>`, no humano.                                                                                       |
| `run_request`      | Petición `pending` con `requested_by: agent:ext:…`. El agente no arrancó nada.                                                |
| `task_create`      | Rechazada: «la sesión no tiene el scope tasks:write». El agente lo explicó.                                                   |
| Cierre             | Al salir Claude Code el emparejamiento quedó `closed`.                                                                        |
| Costo de la sesión | 0.0061 USD según Claude Code, 10 turnos, 49 s.                                                                                |
| Run aprobado       | `request-approve` arrancó un run `plan` real de Claude. Terminó `completed` con 0.0085 USD `estimated`.                       |
| Gate en el run     | 4 pedidos de `Bash`/`Write`: 1 aprobado, 1 denegado (listaba `/home/amara/projects`, fuera del repo), 2 vencidos y denegados. |

## La GUI

- **Contra un daemon real.** `e2e/live-daemon.spec.ts` recorre el ciclo desde la
  GUI contra un daemon real, con proveedores dobles:
  - crear la tarea;
  - planear con Claude;
  - pasarla a `planned`;
  - ejecutar con Codex;
  - aprobar el comando en el Inbox;
  - aprobar una sesión externa con tarea y scopes;
  - rechazar su petición de run.

  También comprueba que la nota del agente aparece como «Agente externo» y la
  del humano como «Tú». El shell de Tauri lo sustituye un puente que abre el
  mismo socket.

- **Ventana nativa.** En WSL2, con WSLg, `cargo build` del shell de Tauri
  compila. `tauri dev` con `KEEL_SOCKET` abrió la ventana, y `ss -xp` mostró a
  `keel-gui` conectado al socket del daemon sin configurar nada.

## Lo que esto no prueba

- **La ventana nativa más allá de la conexión.** No se hizo clic en ella
  automáticamente; el recorrido por las pantallas lo cubre el e2e en Chromium.
- **Codex como sesión externa.** Sólo se probó Claude Code.
- **La frontera frente a una shell libre.** El límite de ADR-0009 §8 sigue
  vigente; ADR-0018 propone cómo cerrarlo.
- **Plazo de las aprobaciones.** El gate da 60 s por defecto. En la prueba
  vencieron dos aprobaciones mientras el humano leía, así que conviene un plazo
  más largo cuando hay una GUI abierta.
