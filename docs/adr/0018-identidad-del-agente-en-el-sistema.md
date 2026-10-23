# ADR-0018: Identidad del agente fuera de las tools: dos puertas, shell aislada y atribución

- **Estado:** Aceptado (2026-10-23)
- **Fecha:** 2026-10-23
- **Criticidad:** **Máxima**
- **Relacionados:** ADR-0002 (Keel no toca credenciales), ADR-0005 §1 (endpoint
  y ACL), ADR-0008 §4 (sandbox de Codex), ADR-0009 §2, §7 y §8 (actor `agent` y
  su límite conocido), ADR-0010 (worktrees), ADR-0013 (intermediario de
  recursos), ADR-0015 (git con plan aprobado)

## Contexto

ADR-0009 §8 deja escrito el límite: un agente con shell libre corre con el
usuario del sistema del humano y puede abrir el socket del daemon. El daemon lo
ve entonces como humano. Para Keel es lo mismo que el humano escriba en una
terminal que el agente lo haga desde su `Bash`.

El humano pide dos cosas (2026-10-23):

1. Que el agente no pueda hacerse pasar por él.
2. Que lo que ejecuta el agente quede a nombre del agente, no del humano. Esto
   incluye los comandos, los archivos y los commits.

Lo medido el 2026-10-23 en WSL2 con bubblewrap 0.9.0
([evidencia](../reviews/2026-10-23-sandbox-socket-humano.md)):

- **Una raíz de solo lectura no basta.** Dentro de `bwrap --ro-bind / /` el
  agente sigue conectando al socket. Linux no aplica «solo lectura» a
  `connect()` sobre un socket.
- **Ocultar la ruta sí basta.** Con un `tmpfs` encima de `$XDG_RUNTIME_DIR` el
  socket humano deja de existir para el agente (`ENOENT`). También falla el
  rodeo por `/proc/<pid del daemon>/root/…`: devuelve `EACCES` sin espacio de
  nombres de PID y `ENOENT` con él.
- **Montar a propósito un socket distinto funciona.** El agente conecta a ese
  socket y no ve el otro.

Con el mismo usuario del sistema no hay secreto que valga. Cualquier archivo que
el cliente humano pueda leer, la shell del agente también puede leerlo. Por eso
la frontera tiene que ser del sistema operativo (qué ve el proceso o con qué
usuario corre), no del protocolo.

## Decisión

Son cuatro piezas que se suman, en este orden. Cada una vale por sí sola, y las
siguientes se apoyan en las anteriores.

1. **Atribución, desde ya y sin aislamiento.** Que las cosas no parezcan del
   humano no depende de bloquear nada:
   - Keel ya registra cada tool call de un run con su run y su actor (ADR-0009
     §7). La GUI muestra «Agente», «Agente externo» o «Tú» según el actor, nunca
     según el texto.
   - En los procesos de un run, Keel pone `GIT_AUTHOR_NAME`, `GIT_AUTHOR_EMAIL`,
     `GIT_COMMITTER_NAME` y `GIT_COMMITTER_EMAIL` con la identidad del agente
     (`Claude (Keel)` o `Codex (Keel)` y `<run_id>@agents.keel.local`). Los
     commits del agente salen a su nombre sin tocar la configuración de git del
     usuario. Además añade los trailers `Keel-Run: <run_id>` y
     `Keel-Task: <display_id>`. La integración en la rama del humano la firma el
     humano (ADR-0015).
   - Keel también exporta `KEEL_RUN_ID` y `KEEL_ACTOR` en el entorno del run.
     Sirven para que los hooks y las herramientas etiqueten lo que hacen. No son
     seguridad.

2. **Dos puertas.** El daemon escucha en dos endpoints:
   - `keel.sock`, la puerta humana. Tiene la ACL de ADR-0005 §1 (sólo el
     usuario). Toda conexión que llega por aquí es humana.
   - `keel-agent.sock`, la puerta de agentes. Sólo acepta `session.bind_agent` y
     `session.pair`. Una conexión que llega por aquí nunca es humana, aunque no
     se vincule: queda como `pending` hasta que lo haga. `keel mcp` usa esta
     puerta.

   Sin la pieza 3 esto no impide nada, porque el agente aún ve las dos. Lo que
   hace es que la autoridad dependa de la puerta por la que se entra, y deja una
   sola ruta que ocultar.

3. **La shell del agente no ve la puerta humana.** Es el valor por defecto de
   los runs `execute`. Keel lanza el proceso del proveedor dentro de un sandbox
   que oculta `keel.sock` y el directorio de estado de Keel, y monta sólo
   `keel-agent.sock`:
   - **Linux y WSL2: bubblewrap**, con estos montajes:
     - la raíz en solo lectura;
     - el worktree con escritura;
     - un `tmpfs` encima del directorio del socket humano y del estado de Keel;
     - la puerta de agentes montada a propósito;
     - `--unshare-pid`.

     La red se apaga salvo que el perfil la pida.

   - **macOS: Seatbelt**, con un perfil que niega la ruta del socket humano.
     Está sin medir.
   - **Windows:** queda pendiente medir AppContainer o un token restringido.
     Mientras tanto, `Bash` sigue detrás del gate de aprobación (ADR-0009 §8) y
     la GUI lo dice.
   - Claude Code y Codex traen sandbox propio. Se usa el del proveedor sólo
     donde un spike demuestre que oculta el socket humano. Si no lo demuestra,
     manda el sandbox de Keel. Que la raíz sea de solo lectura no cuenta como
     prueba (medición 2).
   - **Spike de salida.** Desde dentro del sandbox:
     - `keel.sock` da `ENOENT`;
     - `keel-agent.sock` conecta;
     - escribir en el worktree funciona;
     - escribir fuera falla.

     Los tests del daemon reproducen las cuatro pruebas en Linux.

4. **Un usuario del sistema para los agentes, como modo opcional.** Es lo que
   escala a equipos y a runners remotos:
   - Un usuario `keel-agent` (o uno por proyecto) en un grupo `keel-agents`. Los
     worktrees son del grupo. La puerta humana es `0600` del humano y el sistema
     rechaza al agente aunque la vea. La puerta de agentes es del grupo.
   - Los procesos, los archivos y los registros del sistema (`ps`, `auditd`, el
     registro de seguridad de Windows) muestran `keel-agent`, no al humano. Es
     la respuesta completa a «que no parezcan mías».
   - **Costo.** El proveedor necesita sesión iniciada con ese usuario. Keel no
     copia credenciales (ADR-0002): el humano hace una vez, en terminal,
     `sudo -u keel-agent claude login` o `codex login`. Es lo de «como mucho una
     terminal con login». Hacen falta permisos de administrador para crear el
     usuario y, en Windows, un lanzador con otra cuenta.
   - Con el mismo contrato, el agente puede correr en un contenedor o en otra
     máquina. En ese caso la puerta de agentes pasa a ser remota y necesita su
     propio ADR de transporte.

5. **Alarma.** Si Bun permite leer las credenciales del par del socket
   (`SO_PEERCRED`), una conexión a la puerta humana que viene del árbol de
   procesos de un run emite `security.agent_on_human_door` y se trata como
   agente. Es una alarma, no una frontera: un proceso que se desvincula de su
   padre la evade. Está sin medir.

## Criterios de aceptación

- Un commit hecho en el worktree de un run tiene como autor y committer al
  agente y el trailer `Keel-Run`, y la configuración de git del usuario no
  cambia.
- Ninguna conexión por la puerta de agentes obtiene el actor humano, ni siquiera
  sin vincular.
- En Linux y WSL2, desde la shell de un run `execute`, el socket humano y el
  estado de Keel no existen y la puerta de agentes funciona. Lo comprueba un
  test con bubblewrap real.
- La GUI muestra qué aislamiento tuvo cada run (`none`, `sandbox` u `os_user`) y
  no presenta el de una plataforma sin medir como si estuviera verificado.
- El modo de usuario del sistema no lee ni copia credenciales. Si el usuario del
  agente no tiene sesión, el run falla con `provider_login` y dice qué comando
  correr.

## Consecuencias

- La frontera de ADR-0009 §8 deja de ser «quien usa las tools» y pasa a ser «el
  sistema operativo», primero en Linux y WSL2.
- Las piezas 1 y 2 son baratas y portables. La 3 es por plataforma y es donde
  está el trabajo. La 4 es opcional y cuesta configuración, pero da la identidad
  de sistema completa.
- Con la pieza 3, los runs `execute` pierden por defecto la red y el acceso al
  resto del disco. Un perfil que necesite más lo declara y la GUI lo muestra.
- Windows queda detrás hasta medir su mecanismo. Mientras tanto, la
  documentación y la GUI dicen que allí la frontera sigue siendo el gate.

## Alternativas consideradas

- **Inspeccionar el texto del comando en `canUseTool`.** Se mantiene como capa
  (ADR-0009 §8), pero no es una frontera: basta con escribir la ruta de otra
  forma para evadirla.
- **Un secreto que sólo tenga el cliente humano.** Rechazada: con el mismo
  usuario del sistema la shell del agente lo lee igual que el cliente.
- **Confirmar cada mutación humana en el sistema operativo** (polkit, Windows
  Hello). Rechazada como valor por defecto: cuesta demasiado en cada clic.
  Podría servir más adelante para acciones de alto impacto.
- **Sólo contenedores.** Rechazada como valor por defecto: obliga a tener Docker
  o Podman, pesa en Windows, y el sandbox de la pieza 3 da lo mismo para el
  socket sin esa dependencia. Sigue disponible por la pieza 4.
- **Raíz de solo lectura sin ocultar rutas.** Rechazada por la medición 2.
