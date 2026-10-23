# ADR-0019: Uso interactivo desde la GUI: daemon de usuario, proyectos, conversación y permisos

- **Estado:** Propuesto
- **Fecha:** 2026-10-23
- **Criticidad:** Alta
- **Relacionados:** ADR-0002 regla 5 (límites bajos, subirlos es explícito),
  ADR-0003 (runtime), ADR-0005 §1 (endpoint), ADR-0006 (estados de run),
  ADR-0008 (Codex), ADR-0009 (actor y gate), ADR-0010 (worktrees), ADR-0018
  (aislamiento), SDD 01 §05, §08, §09 y §10, SDD 02 «WSL2»

## Contexto

El humano probó la GUI el 2026-10-23 y encontró esto:

- Hay que arrancar el daemon a mano con `--root`, y cada daemon sirve una sola
  carpeta.
- No hay forma de abrir otro proyecto desde la GUI.
- El run no se puede contestar: no hay cómo mandarle un mensaje al agente,
  mientras trabaja ni cuando termina.
- No recuerda lo aprobado y no deja elegir modo ni permisos. La alternativa
  sería `--dangerously-skip-permissions`.
- Un perfil fijo (haiku, 12 turnos) cortó un plan con `turn_limit`.

Lo que ya hay:

- El modelo de datos admite varios proyectos (`projects`, `project_repos`). El
  daemon sólo crea uno, el de `--root`.
- El protocolo declara `runs.resume` con `directive` y la decisión
  `approve_session`, sin implementar.
- El SDD 01 especifica `Approve Session (15m)` (§10) y reglas de permiso `auto`,
  `ask`, `dry_run_then_ask` y `deny` con alcance y caducidad (§08).

Lo que admiten los proveedores, comprobado en los tipos de
`@anthropic-ai/claude-agent-sdk` 0.3.295 y en el esquema de `codex app-server`
0.162.1:

| Necesidad                    | Claude                                          | Codex (`app_server`)                                  |
| ---------------------------- | ----------------------------------------------- | ----------------------------------------------------- |
| Mensaje durante el run       | `prompt` como `AsyncIterable` y `streamInput()` | `turn/steer`                                          |
| Seguir después del final     | `resume: <session_id>`                          | `thread/resume`; exige hilos no efímeros (hoy lo son) |
| Cambiar permisos en caliente | `setPermissionMode()`                           | `turn/settings/update` (sin medir)                    |

## Decisión

1. **Daemon de usuario que arranca la GUI.**
   - Al abrirse, la GUI busca el endpoint por defecto (ADR-0005 §1). Si nadie
     escucha, lanza el daemon desligado de la ventana y espera a
     `daemon.health`.
   - Cerrar la ventana no detiene el daemon, ni los runs, ni las aprobaciones.
   - Hay un daemon por usuario. Un segundo arranque encuentra el socket vivo y
     se retira.
   - Qué comando lanzar: el `KEEL_DAEMON` configurado o, en desarrollo,
     `bun <repo>/packages/daemon/src/main.ts`. Empaquetarlo como binario se
     decide con la distribución (ADR README, decisiones abiertas).
   - En WSL2 con WSLg, GUI y daemon corren en la distro.
   - En la GUI nativa de Windows con el repo en WSL2 se usa el bridge del SDD 02
     (`wsl.exe -d <distro> --exec`). Queda sin implementar hasta medirlo.

2. **Varios proyectos en un daemon.** `--root` pasa a ser opcional y significa
   «abre este al arrancar». Métodos nuevos, todos con autoridad humana:
   - `projects.list`: los proyectos abiertos y los recientes.
   - `projects.open { path }`: valida la carpeta, detecta git y crea o reutiliza
     el proyecto.
   - `projects.status { project_id }`: rama actual, `HEAD`, cambios sin
     confirmar y adelanto o atraso respecto a su upstream, vía `@keel/git`.

   El driver de espacio, el perfil y los límites pasan a ser por proyecto. La
   GUI tiene un selector de proyecto con un botón «Abrir carpeta…». Usa el
   diálogo nativo de Tauri, `tauri-plugin-dialog`, que es una dependencia nueva
   del shell. La GUI siempre muestra repo, rama y estado del proyecto activo.

3. **Conversación con el run.**
   - `runs.message { run_id, text }`: un mensaje humano a un run vivo. Va por
     `streamInput` en Claude y por `turn/steer` en Codex. Queda como evento
     `run.user_message` con actor humano.
   - `runs.continue { run_id, text }`: continúa un run que ya terminó. Crea un
     run hijo (`parent_run_id`) en el mismo worktree si sigue existiendo; si no,
     en uno nuevo desde la rama del padre. Retoma la sesión del proveedor. En
     Codex esto exige crear los hilos sin `ephemeral`; se mide antes.
   - El run sigue siendo la unidad de costo, límites y estado (ADR-0006). Una
     conversación es una cadena de runs.
   - La GUI muestra la cadena como un solo chat, con el campo de mensaje siempre
     abajo.

4. **Permisos visibles y recordables.**
   - **Modo por run**, elegido al arrancar o al continuar y cambiable en
     caliente donde el proveedor lo admita:

     | Modo           | Qué hace                                                         |
     | -------------- | ---------------------------------------------------------------- |
     | `ask`          | Por defecto. Fuera de las reglas, todo pasa por el gate.         |
     | `accept_edits` | Las ediciones dentro del worktree no preguntan; los comandos sí. |
     | `plan`         | Sólo lectura.                                                    |
     | `bypass`       | Sin gate, el equivalente de `--dangerously-skip-permissions`.    |

     `bypass` nunca es el valor por defecto y sólo existe para runs `execute`
     dentro de un worktree. No existe para sesiones externas. La GUI lo marca en
     rojo durante todo el run, y el manifest y un evento lo registran. Con
     ADR-0018 es donde más sentido tiene: shell aislada y sin gate.

   - **`approve_session`**: aprueba la misma herramienta con el mismo prefijo de
     comando durante el resto del run, como mucho 15 minutos (SDD 01 §10).
   - **Reglas del proyecto** (SDD 01 §08):
     - Persistentes, del estilo `Bash(git status:*) → auto`, con alcance y
       caducidad. Se crean desde la aprobación misma («permitir siempre en este
       proyecto»).
     - Una vista de permisos lista las reglas activas y las decisiones de cada
       run. Así no hay que recordar a qué se le dio permiso.
     - Una regla nunca permite salir del worktree ni tocar la puerta humana
       (ADR-0018).
   - **Modelo y límite de turnos por run.** Se eligen al arrancar. Los valores
     por defecto siguen bajos; subirlos es la acción explícita que pide ADR-0002
     regla 5, y la GUI muestra el valor usado.

## Criterios de aceptación

- **Arranque.** Con el daemon apagado, abrir la GUI lo arranca. Cerrar la GUI no
  lo detiene. Un run en curso sigue al reabrir la ventana.
- **Proyectos.** Abrir dos carpetas da dos proyectos con sus tareas y runs
  separados. La cabecera muestra la rama real del proyecto activo.
- **Conversación.**
  - Un mensaje enviado durante un run de Claude llega al agente y aparece en el
    chat con autor humano.
  - Continuar un run terminado retoma la sesión: el agente recuerda el turno
    anterior, y lo comprueba una prueba con la corrida grabada.
- **Permisos.**
  - Una regla `auto` evita la pregunta en el siguiente run del proyecto.
  - Revocarla la reactiva.
  - `bypass` no se puede pedir para un run `plan`, para la raíz del repo ni
    desde una sesión externa.

## Consecuencias

- El daemon deja de ser «un proceso por carpeta». Hay que revisar las consultas
  que hoy suponen `this.project`.
- Aparecen tablas o migraciones para reglas de permiso y para `parent_run_id`.
  Salen del SDD 03 como las demás.
- Con `bypass` el gate deja de ver lo que hace el agente. Hasta tener ADR-0018,
  la única frontera en ese modo es el worktree, y eso se dice en la GUI.

## Alternativas consideradas

- **Un daemon por proyecto.** Rechazada. Multiplica sockets y procesos, complica
  a la GUI y no comparte límites diarios ni la cuota del proveedor.
- **Que la GUI contenga el daemon.** Rechazada. Cerrar la ventana mataría los
  runs, y ADR-0005 separa a los clientes del daemon.
- **Conversación como un solo run largo.** Rechazada. Mezcla costos y estados, y
  un run terminado no se podría auditar como unidad.
- **`bypass` global por proyecto.** Rechazada. Es demasiado fácil de olvidar
  encendido; se elige en cada run y se ve.
