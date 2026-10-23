# Corrida real de la Fase 1 · 2026-10-23

Primer punto del DoD de la Fase 1 (SDD 04): «un agente autorizado consulta
archivos reales de un worktree y emite eventos correlacionados». Se hizo con el
permiso del humano, con su `claude` instalado y su sesión de suscripción, con el
daemon y la CLI tal como están en `main`.

## Montaje

- Repo de prueba con `README.md` y `src/calc.ts` (`sumar`, `restar`), un commit.
- `bun packages/daemon/src/main.ts --db … --socket … --root <repo>` con
  `XDG_STATE_HOME` en un temporal. Límites por defecto: 1 run, 2 USD por run y
  10 USD por día, todo estimado.
- `cli.ts run` con la tarea «Lee README.md y src/calc.ts … No modifiques nada.»:
  crea la tarea, la pasa a `planned` y lanza un run `execute`.
- Perfil por defecto: `subscription_session`, modelo `haiku`
  (`claude-haiku-5-5`), herramientas auto-aprobadas `Read`, `Glob` y `Grep`, y
  Claude Code 2.1.304 detectado en `~/.local/bin/claude`.

## Resultado

| Qué           | Observado                                                                                                                                                          |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Final         | `completed`; la tarea pasó a `needs_review`; `run.failure` no se emitió.                                                                                           |
| Aislamiento   | Las dos lecturas (`Read`) fueron dentro del worktree `…/worktrees/<proyecto>/repo/KEEL-1/<run>/root/`, rama `keel/KEEL-1/<run>/root`. La raíz del repo no se tocó. |
| Cambios       | `worktree.changes`: `head_sha` igual a la base y sin archivos; fue sólo lectura.                                                                                   |
| Respuesta     | «`src/calc.ts` exporta dos funciones: `sumar(a, b)`, que devuelve `a + b`, y `restar(a, b)`, que devuelve `a - b`.»                                                |
| Correlación   | Agente raíz `succeeded` con su `session_id`; las 2 tool calls cuelgan de él con `wall_ms` (34 y 27) y `duration_ms` (6 y 3) del runtime.                           |
| Proceso       | Lanzado por Keel (`spawnClaudeCodeProcess`): pid, `started_at` de `/proc` y ejecutable real versionado (`~/.local/share/claude/versions/2.1.304`).                 |
| Autenticación | `init.apiKeySource: "none"`: el binario usó la sesión del usuario y Keel no tocó credenciales (ADR-0002).                                                          |
| Costo         | `cost_kind: estimated`, 0.0057 USD; 43 297 tokens de entrada y 551 de salida; presupuesto pasado al SDK 2 USD.                                                     |
| Cuota         | `rate_limit_event`: 16 % de la ventana de 5 h y 3 % de la de 7 días.                                                                                               |
| Duración      | 5.8 s del arranque al final.                                                                                                                                       |
| Eventos       | 40 en total. Ninguno contiene `sk-ant` ni `Bearer` (no hubo nada que redactar).                                                                                    |

## Defecto encontrado y corregido

La etiqueta de cada tool call se recortaba por el principio a 120 caracteres.
Con un worktree en una ruta larga quedaba `/tmp/…/state/keel/work` y se perdía
el archivo. `toolCallLabel` (`@keel/core`) muestra ahora las rutas relativas al
`cwd` del run y, si aún son largas, conserva el final. Una segunda corrida
(0.0027 USD estimados) dio la etiqueta `src/calc.ts`.

## Cómo repetirla

Con `claude` instalado y sesión iniciada: crear un repo con un commit, arrancar
el daemon como arriba y lanzar `cli.ts run` con una tarea de sólo lectura. Las
capturas de la base no se versionan: están en un temporal y contienen rutas
locales.
