# ADR-0031: Ansible de primer nivel sobre las conexiones SSH del vault

- **Estado:** Aceptado (2026-10-28)
- **Fecha:** 2026-10-28
- **Criticidad:** Alta
- **Relacionados:**
  - ADR-0013 (intermediario de recursos): suma el tipo de conexión `ansible`,
    con `iac.plan` e `iac.apply` como Terraform.
  - ADR-0025 (vault y broker): usa sus conexiones SSH, el `ssh-agent` y el
    `known_hosts` de Keel, askpass (§4), las tools `iac_plan` e `iac_apply` (§5)
    y la política de `prod` (§7).
  - ADR-0026 (en prod se pregunta), ADR-0028 (la base al día), ADR-0011 y
    ADR-0012 (eventos y evidencia).
  - ADR-0002 regla 2, por analogía: como con Claude Code, Keel no trae Ansible;
    lo detecta y dice cómo instalarlo.

## Contexto

El humano (2026-10-28):

> ocupo ya soportar Ansible, y que con la conexión SSH que ya tengo en Keel,
> importada de mi SSH, pueda desplegar correctamente

Lo que hay:

- **Casa Matte despliega con Ansible** (ADR-G16, `infrastructure/ansible/`):
  - `site.yml` con roles `bootstrap → repo → database → app → nginx`;
  - `--tags deploy` para sólo redesplegar código;
  - los secretos de la app van en `group_vars/vault.yml`, cifrado con
    `ansible-vault`, y la contraseña se pide con `--ask-vault-pass`;
  - `vault.yml` e `inventory/production.yml` están en `.gitignore`: viven sólo
    en el checkout del humano.
- **En Keel**, el humano ya importó de su `~/.ssh` las conexiones
  `prod-casamatte` (root, `prod`) y `prod-rifas`, con su llave `id_ed25519`, que
  tiene frase.
- **Keel ya tiene IaC** para Terraform (`iac.plan` e `iac.apply` en el broker),
  pero no para Ansible.
- **El spike `spikes/ansible`** (2026-10-28, ansible-core 2.21.2, sin servidor)
  midió:
  - Un callback propio da a Keel cada tarea y host en vivo, en NDJSON, sin tocar
    el `ansible.cfg` del proyecto.
  - `--vault-password-file` acepta un ejecutable: la contraseña entra sin
    archivo y sin pasar por el entorno del agente.
  - En `--check`, `command` y `shell` se saltan. Un despliegue que construye con
    comandos no se previsualiza entero.
  - `--diff` imprime los secretos de una plantilla que no tenga `no_log`.
  - Sin la contraseña del vault, el playbook de Casa Matte no pasa ni
    `--syntax-check`.

## Decisión

### 1. Un destino de despliegue: la conexión `ansible`

Una conexión de tipo `ansible` describe un playbook y contra qué conexiones SSH
corre:

- **`dir`**: la carpeta del proyecto con el playbook (`infrastructure/ansible`).
- **`playbook`**: el archivo (`site.yml`).
- **`hosts`**: cada host del playbook con su conexión SSH del vault, por ejemplo
  `casamatte-vps → prod-casamatte`.
- **`tags`** y **`limit`** por defecto (`deploy`), y variables extra que no sean
  secretas.
- **La contraseña de `ansible-vault`**, como secreto del vault de Keel o «pedir
  cada vez».
- **El entorno** es el más alto de sus conexiones SSH: si alguna es `prod`, el
  destino es `prod`.

Sus operaciones son las de Terraform: `iac.plan` (el check) e `iac.apply` (el
despliegue). El agente las pide con `iac_plan` e `iac_apply` (ADR-0025 §5).

La skill `infra` (ADR-0025 §6) detecta `ansible.cfg` y `site.yml` y propone el
destino con `setup_request`, ya lleno; el humano lo confirma.

### 2. Keel arma el inventario desde las conexiones SSH

- Keel genera un inventario temporal con `ansible_host`, `ansible_user` y
  `ansible_port` de cada conexión SSH. Se pasa con `-i` en lugar del inventario
  del proyecto. Los `group_vars` y `host_vars` junto al playbook se siguen
  cargando.
- **La llave nunca va en el inventario.** SSH entra por el `ssh-agent` de Keel
  (`SSH_AUTH_SOCK`), con la llave de la conexión cargada. Si tiene frase, se le
  pide al humano en la GUI, como en ADR-0025 §4.
- **La huella del servidor** se valida contra el `known_hosts` de Keel:
  `StrictHostKeyChecking=yes` y `ANSIBLE_HOST_KEY_CHECKING=True`, aunque el
  `ansible.cfg` del proyecto la apague.

### 3. Desde dónde corre

- **Desde el checkout del proyecto**, no desde un worktree, porque los archivos
  que hacen falta (`vault.yml` y el inventario) están en `.gitignore`.
- **Sólo con la base al día y limpia** (ADR-0028): la rama actual igual a su
  upstream y sin cambios en `dir`. Si no, la GUI ofrece «Actualizar».
- **Lo que se despliega queda escrito:** el commit del checkout y el hash de los
  archivos de `dir`, incluidos los que no están en git.

### 4. Plan y despliegue

- **`iac.plan`** corre `ansible-playbook --check --diff` con los tags y el limit
  elegidos. Devuelve:
  - por host, qué tareas cambiarían y el resumen (`ok`, `changed`, `failed`);
  - cuántas tareas de comando no se pudieron previsualizar, con el aviso: «el
    check no corre comandos; N tareas sólo se verán al desplegar».
- **`iac.apply`** corre el mismo playbook con los mismos tags y limit.
  - La aprobación se ata al digest de: el destino, el commit, el hash de `dir`,
    los tags, el limit, las variables extra y el inventario generado.
  - Si algo cambió desde el plan, la aprobación caduca y hace falta otro.
- **En `prod`**, `iac.apply` siempre pregunta, y sólo «esta vez» (ADR-0025 §7).
  La tarjeta muestra los hosts, los tags, el commit y el resumen del check.
- **El humano también despliega sin agente:** «Desplegar» en el destino abre el
  mismo plan y la misma aprobación.

### 5. En vivo y como evidencia

- Keel trae su callback de Ansible (`keel_events`, del spike). Lo activa con
  `ANSIBLE_CALLBACK_PLUGINS` y `ANSIBLE_CALLBACKS_ENABLED`, sin tocar el
  proyecto.
- Cada tarea y cada resultado por host llegan al chat del run en vivo, como
  eventos semánticos instrumentados (ADR-0011).
- El resumen por host queda como evidencia de la tarea (ADR-0012). La salida
  completa queda como artefacto, redactada.
- Un host `unreachable` o una tarea `failed` corta el run con el mensaje de
  Ansible, redactado.

### 6. Secretos

- **La contraseña de `ansible-vault`** entra por `--vault-password-file`, con un
  script de Keel que la pide al daemon con un token de un solo uso, como
  `keel askpass`. Nunca toca el disco ni el entorno del agente.
- **Keel redacta lo que el vault de Ansible contiene.** Antes de correr,
  descifra en memoria los archivos cifrados de `dir`. Cada valor de texto entra
  como patrón literal de redacción (ADR-0013 §3), para la salida, el `--diff`,
  los eventos y el artefacto.
- **El agente ve** el resumen, la lista de tareas y los errores redactados.
  Nunca ve la contraseña ni el contenido del vault de Ansible.
- Según ADR-0025 §9, esta contraseña es un secreto de infraestructura, no una
  credencial de un proveedor de IA: puede vivir en el vault de Keel.

### 7. Lo que no hace

- No instala Ansible ni colecciones. Si falta `ansible-playbook`, la GUI dice
  cómo instalarlo (`pipx install ansible-core`).
- No corre comandos ad-hoc de Ansible. Para un comando suelto en el servidor
  está `ssh_run`.
- No corre en Windows nativo, porque Ansible no tiene nodo de control ahí. En
  Windows funciona dentro de WSL.

## Spike antes de implementar

Con permiso del humano, contra `prod-casamatte` y de sólo lectura.

Medido el 2026-10-28 (`spikes/ansible`): `ansible -m ping` con el inventario
generado desde la conexión y su huella guardada, en modo estricto, respondió
`pong` en 5.7 s. Con una huella distinta se rechazó, pero sólo sin la conexión
compartida de Ansible: con `ControlPersist`, el segundo intento reusa el socket
abierto y no vuelve a verificar la huella. Keel le da a cada ejecución su propia
carpeta de sockets de control (`ANSIBLE_SSH_CONTROL_PATH_DIR`).

Queda pendiente:

- `ansible -m ping` por el `ssh-agent` y el `known_hosts` de Keel, con la llave
  con frase pedida en la GUI;
- `--check --tags deploy` del `site.yml` de Casa Matte: tiempo, volumen de
  eventos y cuántas tareas se saltan.

## Criterios de aceptación

- Con el destino `casamatte` (`casamatte-vps → prod-casamatte`), «Desplegar»
  corre el check, muestra qué cambiaría y cuántas tareas no se previsualizan, y
  pide aprobación.
- Al aprobar, el despliegue corre con `--tags deploy`. Cada tarea aparece en el
  chat en vivo, y el resumen queda como evidencia.
- La llave con frase se pide en la GUI. La contraseña del vault de Ansible no
  aparece en ningún evento, artefacto ni resultado del agente, tampoco con
  `--diff` en una plantilla sin `no_log`.
- Si cambia un archivo de `dir` o el commit entre el plan y el despliegue, la
  aprobación caduca.
- Con la base atrás de `origin`, no despliega y ofrece «Actualizar».
- Un servidor con una huella distinta a la del `known_hosts` de Keel no se
  conecta.

## Consecuencias

- Keel trae un archivo Python (el callback) y un script para la contraseña. No
  modifica ni empaqueta Ansible.
- Desplegar depende del checkout del humano, no de un worktree. Es lo que exige
  un proyecto con secretos fuera de git, como Casa Matte.
- El check de un despliegue hecho con comandos es parcial, y Keel lo dice en vez
  de presentarlo como plan completo.

## Alternativas consideradas

- **Que el agente corra `ansible-playbook` por Bash.** Necesitaría la llave del
  humano y la contraseña del vault en su entorno. Rompe ADR-0025 §10.
- **Ansible por `ssh_run` en el servidor (`ansible-pull`).** Cambia el modelo de
  despliegue de Casa Matte y necesita Ansible y acceso al repo en el servidor.
- **Pasar `ansible_ssh_private_key_file`.** La llave tiene frase y Ansible no
  tiene cómo pedirla sin terminal. Además, el archivo es del humano y queda
  fuera del control de Keel.
- **Usar el inventario del proyecto tal cual.** Duplica host y usuario fuera del
  vault, y no garantiza la huella ni la entrada por el `ssh-agent` de Keel.
