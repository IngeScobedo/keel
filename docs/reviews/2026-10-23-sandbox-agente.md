# El agente en su sandbox: dos puertas y bubblewrap · 2026-10-23

Implementación de ADR-0018 §1 a §3 y su prueba real. El entorno fue WSL2 con
bubblewrap 0.9.0 y Claude Code 2.1.304 (`haiku`), con permiso del humano y su
suscripción.

## Prueba real

Un run `execute` de Claude en modo `bypass`, aislado (`isolation: sandbox`). El
prompt le pidió cuatro comandos y una tool de Keel:

| Qué pidió                             | Qué pasó dentro del sandbox                                    |
| ------------------------------------- | -------------------------------------------------------------- |
| `ls` de la carpeta de los sockets     | Sólo `keel-agent.sock`; la puerta humana no existe para él.    |
| `echo hola > nota.txt` en el worktree | Funciona.                                                      |
| `touch $HOME/keel-fuera.txt`          | `Read-only file system`, `exit=1`. El archivo no existe fuera. |
| `git commit` en el worktree           | Autor `Claude (Keel KEEL-1) <run@agents.keel.local>`.          |
| `mcp__keel__task_current`             | El puente funciona desde dentro, por la puerta de agentes.     |

El run terminó `completed`, con 0.0033 USD `estimated`.

La prueba `test/sandbox.test.ts` repite los criterios con bubblewrap real en
cada corrida de Linux:

- el socket humano da `ENOENT`;
- la puerta de agentes conecta;
- la base de Keel y el token de otro run no se ven, y el token propio sí;
- escribir en el worktree funciona y fuera da `EROFS`.

## Diferencias con el texto de ADR-0018

ADR-0018 está aceptado y no se edita. Esto es lo que la implementación hace
distinto y por qué:

- **La red no se corta.** El proceso del agente es el que habla con la API del
  proveedor, y bubblewrap no filtra por destino. Con `--unshare-net`, Claude
  Code no funciona. Cortar la red de los comandos y no la del proveedor necesita
  otra pieza (proxy o filtro por destino) y queda pendiente.
- **No hay trailers `Keel-Run` ni `Keel-Task`.** Git no los añade desde el
  entorno. Hacerlo con `core.hooksPath` pisaría los hooks del repo (husky,
  lefthook). El run va en el correo del autor y del committer
  (`<run_id>@agents.keel.local`), que identifica lo mismo.
- **Sólo se aíslan los runs `execute` de Claude.**
  - Codex corre en su propio sandbox (`workspace-write`). No se mide si oculta
    la puerta humana, y la GUI lo muestra como «sandbox del proveedor».
  - Los runs `plan` trabajan en la raíz del repo con el modo `ask`, y la GUI los
    muestra «sin aislar».
- **Lo que ve el sandbox con escritura:**
  - el worktree;
  - el `.git` común del repo, para poder commitear;
  - el directorio de estado del proveedor (`~/.claude`).

  El archivo de configuración de Claude en el `$HOME` queda de solo lectura, y
  Claude Code funciona igual (medido). Keel no nombra ni lee ese archivo
  (ADR-0002).

## Pendiente

- macOS (Seatbelt) y Windows (AppContainer o token restringido).
- El modo de usuario del sistema (§4) y la alarma por credenciales del par del
  socket (§5).
