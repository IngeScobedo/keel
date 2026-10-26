# ADR-0025: Vault y broker: Keel guarda las conexiones y el agente sólo pide operaciones

- **Estado:** Aceptado (2026-10-26)
- **Fecha:** 2026-10-26
- **Criticidad:** Máxima
- **Relacionados:**
  - ADR-0013 (intermediario de recursos). Este ADR lo supersede en §1 («Keel no
    guarda valores de secretos») y en su alternativa descartada «que Keel sea su
    propio vault». El resto de ADR-0013 sigue en pie.
  - ADR-0002 §2, regla 1. Este ADR la precisa en §9, sin tocar lo que dice de
    las credenciales de los proveedores.
  - ADR-0023 (rechazado el 2026-10-26). De él se queda la petición del agente y
    el formulario lleno (§6).
  - ADR-0003 (Bun, sin `zeroize`).
  - ADR-0005 (protocolo).
  - ADR-0009 (tools MCP y actor agente).
  - ADR-0011 y ADR-0012 (eventos y evidencia).
  - ADR-0018 (sandbox de los runs).

## Contexto

El humano (2026-10-26):

> quiero algo integrado dentro de keel que hasta te permita importar de tu OS
> pero que lo manejemos nosotros, teniendo las dos capas separadas de el vault y
> como consume el agente

Y sobre las conexiones:

> me gustaría que keel pueda crear la conexión en el sentido de que yo guarde
> como en termius mis conexiones y luego pueda entrar ya sea que tenga la pwd
> guardada o no y me la pida después

Cómo trabaja hoy:

- **Sus hosts** están en `~/.ssh/config`: alias con prefijo de entorno
  (`prod-casamatte`), `ControlMaster` y una llave con frase.
- **Su script `sshx`** abre un selector (`sshs`), marca el entorno de cada
  servidor (la pestaña de tmux en rojo para `prod-*`, ámbar para `staging-*`,
  verde para `dev-*`) y conecta por `ssh` o `mosh`.

Investigó Agent Auth de Better Auth: identidad del agente, grants por capacidad,
aprobación y auditoría, con el vault aparte. Concluyó que se puede hacer sin
depender de él, con un broker propio detrás de una interfaz.

Lo que ya hay:

- **ADR-0013.** Secretos por referencia (`env:`, `keychain:`, `op://`,
  `vault:`), grants por conexión, operación y entorno, redacción exacta y
  evidencia de cada operación. El broker usa el `ssh` del usuario con sus llaves
  y su agente.
- **El sandbox de ADR-0018.** Tapa `~/.keel` y la carpeta del socket humano.
  Medido el 2026-10-26 en WSL2:
  - el agente sigue viendo el bus de D-Bus (`/run/user/1000/bus`), por el que
    `secret-tool lookup` lee el llavero;
  - también ve `~/.ssh` y el socket del `ssh-agent` del humano.

  Hoy una referencia `keychain:` de ADR-0013 la puede leer la shell del agente.

- **El llavero existe en la máquina del humano:** `gnome-keyring` responde por
  D-Bus en WSL2.

## Decisión

### 1. Dos capas con una interfaz entre ellas

- **Vault.** Guarda y descifra. Sólo lo llaman el broker y el terminal del
  humano. Nunca expone un valor por el protocolo (ADR-0005) ni por MCP. Su
  interfaz no tiene `get`: tiene `use(id, fn)`, que entrega el valor a una
  función del daemon y lo suelta al volver.
- **Broker.** Decide y ejecuta en nombre del agente:
  - identidad: el run, su tarea, su proyecto y su perfil (ADR-0009, ADR-0018);
  - política: los grants de ADR-0013, que niegan si no hay un grant vigente;
  - aprobación: §7;
  - ejecución, con límites y redacción: §8;
  - auditoría: §8.
- **Dónde corren.** Los dos son módulos del daemon, en Bun. Las interfaces
  `Vault` y `Broker` permiten moverlos a un proceso aparte sin cambiar el
  protocolo ni a los agentes.
- **Agent Auth de Better Auth no entra.** Si un día llegan agentes externos (de
  otra máquina, de CI o del teléfono), se monta como fachada encima del broker.

### 2. El vault

- **Tabla `vault_items`:**
  - `id`, `project_id` (nulo si es global), `kind` (`password`, `ssh_key`,
    `passphrase`, `token`, `connection_string`), `label`;
  - `ciphertext`, `nonce` y `wrapped_dek`;
  - `created_at`, `rotated_at` y `last_used_at`.
- **Cifrado.** Cada secreto tiene su propia llave (DEK), con AES-256-GCM de
  WebCrypto, que ya trae Bun: no hay dependencia nueva.
- **La llave maestra (KEK).** Vive en el llavero del sistema como `keel/vault`.
  Keel la crea la primera vez y la usa sin preguntar:
  - libsecret en Linux y WSL2;
  - Keychain en macOS;
  - Credential Manager en Windows (pendiente de medir).
- **Sin llavero disponible,** el vault pide una frase al arrancar el daemon y
  deriva la KEK con scrypt. La UI lo dice.
- **Memoria.** Bun no tiene `zeroize` (ADR-0003). Lo único que se promete es que
  el valor descifrado vive el menor tiempo posible, dentro de `use`.
- **Las referencias de ADR-0013 siguen.** Un secreto puede estar en el vault de
  Keel o ser una referencia externa (`env:`, `keychain:`, `op://`, `vault:`). La
  interfaz es la misma.
- **Respaldo.** El respaldo de la base (`keel backup`) lleva los secretos
  cifrados, pero no la KEK: no se pueden leer en otra máquina. Exportar con una
  frase queda para otro ADR.

### 3. Las conexiones, como en Termius

Una conexión es un perfil de host que guarda Keel:

- nombre, tipo, host, puerto, usuario, entorno, salto (`ProxyJump`) y etiquetas;
- un método de autenticación, que el humano cambia cuando quiera.

| Método     | Qué guarda Keel                                                    | Cuándo                                                      |
| ---------- | ------------------------------------------------------------------ | ----------------------------------------------------------- |
| `agent`    | Nada: usa el `ssh-agent` del humano                                | Ya tienes tus llaves cargadas en tu agente                  |
| `key`      | La llave privada, en el vault: generada por Keel o importada       | Quieres que Keel la maneje, también con tu agente bloqueado |
| `password` | La contraseña, en el vault                                         | Servidores con contraseña                                   |
| `ask`      | Nada: se pide al conectar y se olvida al cerrar Keel, o en el acto | No quieres guardarla                                        |
| `file`     | La ruta de tu llave (`IdentityFile`) y, si quieres, su frase       | Tu llave ya está en `~/.ssh` y no quieres moverla           |

- **Con `file`, Keel no lee la llave.** La lee `ssh`. Si tiene frase, `ssh` se
  la pide a Keel (§4) y el humano decide si la frase queda en el vault.
- **Generar una llave.** Keel crea una ed25519 en el vault y muestra la pública
  con la línea sugerida para `authorized_keys`, con `command=` y `from=`. Es la
  opción recomendada para que use el agente: la garantía queda en el servidor
  (ADR-0013 §5).
- **Las bases de datos y SFTP** usan el mismo modelo. SFTP reutiliza la conexión
  SSH. Una base usa `password`, `ask` o una referencia.

**Importar desde el sistema** (pantalla «Conexiones», acción «Importar»):

- **`~/.ssh/config`.** Una fila por `Host`, con `HostName`, `User`, `Port`,
  `ProxyJump` e `IdentityFile`; las llaves entran como `file`. No es un archivo
  de credenciales.
  - El entorno se propone por prefijo, como hace `sshx`: `prod-`/`prd-`,
    `staging-`/`stg-` y `dev-`.
  - El humano confirma la lista antes de guardar.
- **Copiar una llave existente al vault.** Es una acción explícita sobre un
  archivo que el humano elige (§9). Después, Keel ofrece borrar el original o
  dejarlo.

### 4. Cómo usa Keel una credencial sin que salga

- **El `ssh` real (OpenSSH),** no una implementación propia. Así siguen
  funcionando `known_hosts`, `ProxyJump` y `ControlMaster`.
- **Llaves del vault.** Van a un `ssh-agent` propio de Keel: el daemon lo lanza
  y su socket vive en el estado de Keel, que el sandbox tapa. Se cargan con
  `ssh-add -` desde la entrada estándar, con caducidad. Nunca tocan el disco.
- **Contraseñas y frases.** Las entrega `keel askpass` (`SSH_ASKPASS` con
  `SSH_ASKPASS_REQUIRE=force`). Lleva un token de un solo uso en el entorno de
  ese `ssh`, nunca en el del agente.
  - Con `ask`, el daemon pide el valor en la GUI: un modal con «Recordar hasta
    cerrar Keel» y «Guardar en el vault».
- **Las huellas de los hosts.** Van al `known_hosts` de Keel, sembrado al
  importar desde el del humano. Una huella nueva se le muestra al humano. Una
  huella que cambió hace fallar la operación: el broker nunca acepta una huella
  por su cuenta.
- **Las bases de datos** reciben la contraseña dentro del daemon, en el driver.
  No va a variables de entorno ni a la línea de comandos.

### 5. Dos consumidores de la misma conexión

- **El humano** abre una terminal en Keel sobre la conexión, en un pane de tmux
  del daemon (ADR-0003 §5).
  - El pane lleva la marca del entorno, como `sshx`: en `prod`, fondo rojo y el
    aviso al conectar.
  - `mosh` queda para después.
  - El humano no pasa por grants. Queda en la auditoría como actor humano.
- **El agente** sólo pide operaciones por MCP:
  - `resources_list` y `ssh_run`;
  - `sftp_read` y `sftp_write`;
  - `db_query` y `db_execute`;
  - `iac_plan` e `iac_apply`.

  Nunca hay una tool que devuelva una credencial. En esta versión el agente no
  abre sesiones interactivas. Las sesiones con identificador (`ssh_open` →
  `ssh_exec` → `ssh_close`) quedan para otro ADR.

### 6. Lo que falta lo pide el agente (de ADR-0023)

- **`setup_request`.** El agente propone una conexión, un grant, un plugin o un
  cambio de perfil con lo que encontró en el repo. Nunca propone secretos: el
  esquema rechaza campos con forma de secreto.
- **El formulario de Keel** se abre ya lleno. El humano elige el método de §3 y
  guarda. El agente recibe una línea: «conexión prod-ssh lista: `ssh_run`
  (ask)».
- **La skill `infra`** del plugin del método le dice al agente cuándo pedir y
  qué mirar antes: scripts de despliegue, `infrastructure/`, Terraform y
  migraciones.

### 7. Política y aprobación

- **Los grants de ADR-0013 no cambian.** Una conexión nueva empieza en `ask`. En
  `prod`, escribir, `ssh_run` e `iac_apply` nunca son `auto`.
- **La aprobación se ata a un digest** de la operación exacta: conexión, tipo y
  argumentos. Si el agente cambia el comando, hace falta otra aprobación.
- **Alcance de una aprobación:** esta vez, esta tarea (con caducidad) o este
  proyecto. En `prod`, sólo «esta vez».
- **Biometría** (Touch ID, Windows Hello) para `prod` queda para cuando se mida
  en esas plataformas. En Linux no existe.

### 8. Ejecución, redacción y auditoría

- **Límites por operación:** tiempo, bytes de salida y filas.
- **Redacción antes de guardar o devolver:**
  - los valores del vault que se usaron en la operación (ADR-0013 §3);
  - patrones conocidos: `-----BEGIN`, `AKIA…`, `postgres://usuario:clave@`.
- **Auditoría.** Cada operación es un evento (ADR-0011) y una evidencia
  (ADR-0012), con actor, run, tarea, decisión, quién aprobó, duración y el
  digest de la salida. El vault emite `vault.item_created`, `vault.item_used`,
  `vault.item_rotated` y `vault.item_deleted`, nunca con el valor.

### 9. Precisión de ADR-0002, regla 1

La regla sigue entera para las credenciales de los proveedores de IA. Keel nunca
lee, copia ni cachea `~/.claude.json`, `~/.codex/auth.json` ni la sesión de
ChatGPT, y el grep de CI sigue bloqueando esas rutas.

Para las credenciales de infraestructura (llaves SSH, contraseñas de bases):

- Keel lee un archivo sólo cuando el humano lo elige en el formulario de
  importar.
- Nunca recorre `~/.ssh` ni otra carpeta buscando credenciales.
- Sólo lo copia al vault cifrado.

### 10. La frontera con el agente

«El agente no ve secretos» sólo es cierto si su shell no alcanza ni el vault ni
la KEK ni las llaves del humano. El sandbox de ADR-0018 tapa también:

- el bus de D-Bus de la sesión (`$XDG_RUNTIME_DIR/bus`), para que no pueda
  pedirle la KEK ni una referencia `keychain:` al llavero;
- `~/.ssh` y el socket del `ssh-agent` del humano, y quita `SSH_AUTH_SOCK` del
  entorno;
- el estado de Keel, con el vault, el `ssh-agent` de Keel y su `known_hosts` (ya
  estaba tapado).

**Sin sandbox,** el vault sólo protege en reposo. Esto incluye los runs `plan`,
Windows y el aislamiento `none`.

- La GUI lo dice en la conexión y en el run.
- `Bash` sigue detrás del gate de aprobación (ADR-0009 §8).

## Spike antes de implementar

Desde dentro del sandbox de un run `execute`, en WSL2:

- `secret-tool lookup` falla;
- `~/.ssh` no existe;
- el `ssh-agent` del humano y el de Keel no se alcanzan;
- la puerta de agentes sigue funcionando.

Fuera del sandbox:

- `ssh` con una llave cargada desde el vault en el agente de Keel conecta sin
  escribir la llave a disco;
- `keel askpass` entrega una contraseña y una frase;
- la KEK sobrevive a reiniciar el daemon y a reiniciar WSL.

Lo medido va a `spikes/` y a una revisión en `docs/reviews/`.

## Criterios de aceptación

- **Secreto centinela.** Un secreto del vault usado por `ssh_run` y `db_query`
  no aparece en claro en el archivo SQLite, en los eventos, en los logs, en los
  resultados MCP ni en los artefactos.
- **Sin la KEK** (llavero vacío o frase incorrecta), el vault no abre y la UI
  dice por qué.
- **La frontera.** Las pruebas del spike corren como tests del daemon con
  bubblewrap real.
- **Importar.** Un `~/.ssh/config` con 3 hosts crea 3 conexiones; `prod-x` queda
  en `prod` y su llave como `file`, sin que Keel lea la llave.
- **`ask`.** Una conexión sin secreto guardado pide la contraseña en la GUI,
  tanto al abrir la terminal como cuando la usa el agente. Con «no recordar», la
  siguiente vez la vuelve a pedir.
- **Llave generada.** Keel muestra la pública con su línea de `authorized_keys`,
  y `ssh_run` funciona sin que la privada exista en disco.
- **Digest.** Aprobar un comando y luego pedir otro distinto abre una aprobación
  nueva.
- **Redacción.** Un `cat .env` remoto que contiene un valor del vault vuelve
  redactado.
- **Huella cambiada.** La operación falla y no se acepta la huella nueva.

## Consecuencias

- Keel pasa a guardar secretos. A cambio, el humano los administra en un solo
  lugar, para él y para sus agentes, sin depender de un gestor externo.
- `connections` gana `auth_method`, `vault_item_id`, `host_key` y `tags`. Hay
  migración: `vault_items`, y `secret_ref` pasa a ser una de dos fuentes.
- Keel lanza dos procesos auxiliares: su `ssh-agent` y `keel askpass`. Los
  registra como cualquier proceso hijo (ADR-0003 §9).
- Tapar D-Bus puede romper herramientas del proyecto que lo usen dentro de un
  run. Si un perfil lo necesita, lo pide explícitamente y la GUI lo marca.
- La pantalla «Conexiones» del canvas (página 08) se rediseña con los métodos de
  §3, la importación y la terminal del humano. El diseño de `setup_request` de
  la página 18 se ajusta al formulario nuevo.

## Alternativas consideradas

- **Agent Auth de Better Auth como capa de autorización.** Da un estándar
  (descubrimiento, registro de agentes de terceros, flujos de dispositivo), pero
  está en desarrollo y exige un servidor de auth. Los agentes de Keel los lanza
  Keel, así que la identidad ya se conoce. Queda como fachada futura.
- **Vault y broker en un proceso Rust.** Daría `zeroize` y una frontera de
  proceso con el daemon. ADR-0003 pide un disparador medido para usar Rust, y la
  frontera que importa es la del agente, que da el sandbox. Las interfaces dejan
  la puerta abierta.
- **Seguir sólo con referencias (ADR-0013 §1).** No permite el «guardar o que me
  la pida» que el humano quiere, y obliga a usar un gestor externo.
- **Un cliente SSH en JavaScript (`ssh2`).** Permitiría pasar la llave en
  memoria, pero duplica OpenSSH y pierde `ControlMaster`, `ProxyJump` y la
  configuración del humano.
- **XChaCha20-Poly1305 con libsodium.** Es mejor ante nonces repetidos, pero es
  una dependencia nativa. AES-256-GCM con un nonce aleatorio por secreto y una
  DEK por secreto basta para este volumen.
- **Dar la credencial al agente.** Sigue descartada (ADR-0013).
