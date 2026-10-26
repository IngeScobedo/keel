# Feature y subtareas, la conversación del proyecto y el vault: implementados, con lo que quedó distinto

- **Fecha:** 2026-10-26
- **Relacionados:** ADR-0022, ADR-0024 y ADR-0025 (aceptados el 2026-10-26; no
  se editan), ADR-0026 (Propuesto), spike
  `docs/reviews/2026-10-26-spike-vault-broker.md`

## Qué se hizo

### ADR-0024 · La conversación del proyecto

- **Daemon.** Una tarea oculta por proyecto (`dedupe_key = keel:conversation`,
  `CHAT`) que no entra al tablero, a las listas ni a la numeración `KEEL-n`.
  - `conversation.open` la crea la primera vez.
  - `conversation.ask` le escribe al run vivo, continúa la sesión o, con
    `fresh`, empieza sin padre.
  - Los runs son `plan` en la raíz, con su propio encabezado.
- **Tareas que nacen ahí.** `task_create` gana `priority` y `context_markdown`.
  Lo que crea un agente queda ligado a su origen (migración 0013) con una nota
  «Nació de…».
- **GUI.** «Conversación» en la barra lateral y «Preguntar al proyecto» en ⌘K.
  La tarjeta de la tarea creada tiene «Trabajar» y la prioridad, y el panel
  lateral muestra lo que nació y las notas.

### ADR-0022 · Feature y subtareas

- **Core.** `parseTasks`, `validateTasks`, `storyFor` y `withinFrontier`: leer
  el plan, validarlo, escribir la story y casar rutas, todo sin agente.
- **Al aprobar el diseño formal con dos líneas o más:**
  - nacen las hijas en `planned`, en implementar, con el contrato del padre;
  - la fase siguiente espera a la anterior;
  - el padre queda `blocked` con su «n/m» (migración 0014).
- **Ramas e integración.**
  - La rama `feat/KEEL-n-slug` sale de la rama actual del proyecto.
  - Cada hija trabaja en un worktree desde su punta y se integra con
    fast-forward o con `merge-tree`, sin checkout.
  - Un conflicto la devuelve a implementar con los archivos.
- **Integración automática.** El plan de cierre se aprueba solo con las tres
  condiciones comprobadas.
- **GUI.**
  - El gate (b) muestra el árbol y la casilla.
  - El tablero pliega las hijas bajo la feature.
  - El detalle del padre muestra el plan por fases.
  - El chat del padre tiene una línea por hija.

### ADR-0025 · Vault y broker

- **Vault.** AES-256-GCM con una DEK por secreto y la KEK en el llavero
  (`secret-tool` o `security`), con frase y scrypt de respaldo. La interfaz es
  `use(id, fn)`, sin `get`.
- **Conexiones** con método `agent`, `file`, `key`, `password` o `ask`
  (migración 0015).
  - Llave ed25519 generada en el vault y cargada al `ssh-agent` de Keel por
    stdin.
  - Contraseñas y frases por `keel askpass` con un token por cada `ssh`.
  - Las preguntas al humano son un modal en la GUI, con «recordar».
- **Importar y huellas.** Importar de `~/.ssh/config` propone el entorno por
  prefijo y siembra las huellas desde el `known_hosts` del humano; una huella
  nueva la acepta el humano.
- **Broker.**
  - `ssh` asíncrono con el método de la conexión.
  - Redacción de los valores entregados y de patrones conocidos.
  - Alcances «esta vez», «esta tarea» (una hora) y «este proyecto».
- **Sandbox.** Tapa `$XDG_RUNTIME_DIR`, `~/.ssh` y el `ssh-agent` del humano, y
  quita sus variables.
- **`setup_request`.** Una tool MCP y la skill `infra` del plugin del método. La
  GUI abre el alta llena y el agente recibe qué quedó listo.

### ADR-0026 · En prod se pregunta y se puede quitar

El alta ya no pide comandos permitidos. En prod, ejecutar pregunta, y quitar la
pregunta exige escribir el nombre de la conexión: queda `grant.risk_accepted` y
la conexión muestra «prod sin preguntar». El agente no puede pedirlo.

## Evidencia

- **Pruebas:**
  - `packages/core/test/method.test.ts` (el plan de la feature);
  - `packages/daemon/test/project-conversation.test.ts`;
  - `packages/daemon/test/feature-flow.test.ts`, de punta a punta con
    integración automática y sin ella;
  - `packages/daemon/test/features.test.ts`, con git real: fast-forward, merge
    sin checkout y conflicto;
  - `packages/daemon/test/vault.test.ts`: el centinela no aparece en el SQLite,
    con frase, rotar y borrar;
  - `packages/daemon/test/vault-connections.test.ts`: `password`, `ask`, `key`,
    vault bloqueado, `setup_request`, alcances y ADR-0026, con el `askpass`
    real;
  - `packages/daemon/test/sandbox.test.ts`, con bubblewrap real.
- **e2e:** `conversation.spec.ts`, `feature.spec.ts` y `vault.spec.ts`. Los 20
  e2e pasan.

## Distinto de los ADRs

- **ADR-0025 §5, la terminal del humano.** Es `keel ssh <conexión>`, en la
  terminal del humano, como `sshx`. Marca el entorno (fondo rojo y aviso en
  prod, también en el pane de tmux) y prepara `ssh` con el vault. «Abrir
  terminal» en la GUI muestra ese comando. La terminal dentro de Keel espera al
  host de PTY, que no existe todavía (`pty.attach` sólo está en el protocolo).
- **ADR-0025 §5, operaciones.** No hay `sftp_read`, `sftp_write` ni sesiones
  `ssh_open`/`ssh_exec`/`ssh_close`. Hay `ssh_run` y `db_query` (con
  `write: true` para escribir) sobre las operaciones de ADR-0013.
- **ADR-0025 §2, el llavero en la máquina del humano.** No hay `secret-tool`: el
  vault se crea y se abre con una frase hasta instalar `libsecret-tools`.
  Windows no tiene llavero medido.
- **ADR-0025 §7, el alcance.** «Esta tarea» dura una hora y es un grant con la
  tarea en su alcance; «este proyecto» es un grant de la conexión. En prod,
  «este proyecto» se niega desde la tarjeta: se decide en la conexión
  (ADR-0026).
- **ADR-0022 §2, la base.** La rama de la feature sale de la rama actual del
  repo del proyecto. No se puede elegir otra.
- **ADR-0022 §4, la revisión del padre.** Corre en un worktree nuevo sobre la
  rama de la feature. La sesión del proveedor no se retoma y queda
  `run.resume_skipped`.
- **ADR-0022 §1, la story.** La genera Keel siempre desde la línea, los
  escenarios citados y el contrato. El ADR permitía también que la escribiera el
  agente.
- **ADR-0022 §2, conflicto repetido.** Se marca con `frontier_warning` en la
  línea del chat del padre. No hay otra vista.
- **ADR-0026** se implementó en Propuesto porque el humano lo pidió así en la
  conversación. Falta que lo acepte.

## Pendiente

- Instalar `libsecret-tools` en la máquina del humano para que el vault use el
  llavero.
- Medir D-Bus con socket abstracto: tapar la ruta no lo cubre.
- Un respaldo del vault exportable con frase (ADR-0025 §2).
- Pausar una feature desde la GUI y subir la concurrencia de sus hijas. Esto
  último necesita el scheduler de la Fase 2.
