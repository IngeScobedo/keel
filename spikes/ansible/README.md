# Spike: Ansible por Keel (ADR-0031)

Mide, sin tocar ningún servidor, lo que ADR-0031 necesita de Ansible:

- un callback propio que le dé a Keel cada tarea y host en vivo;
- la contraseña de `ansible-vault` por un script, sin archivo ni entorno del
  agente;
- qué deja ver `--check --diff`.

## Correr

```bash
cd spikes/ansible
# un script que imprima la contraseña; en Keel la pide al daemon con un token
printf '#!/bin/sh\nprintf %%s "$SPIKE_VAULT_PASS"\n' > /tmp/keel-vault-pass && chmod +x /tmp/keel-vault-pass
SPIKE_VAULT_PASS=clave-de-prueba KEEL_ANSIBLE_EVENTS=captures/events.ndjson \
  ANSIBLE_CALLBACK_PLUGINS=$PWD/callback ANSIBLE_CALLBACKS_ENABLED=keel_events \
  ansible-playbook demo/site.yml -i demo/inv.yml \
  --vault-password-file /tmp/keel-vault-pass -e out_dir=/tmp/x [--check --diff]
```

`demo/inv.yml` usa `ansible_connection: local`. `demo/vault.yml` está cifrado
con la contraseña de prueba `clave-de-prueba`. `captures/` está en `.gitignore`.

## Resultados (2026-10-28, WSL2, ansible-core 2.21.2)

- **Callback `keel_events`** (`callback/keel_events.py`): escribe un NDJSON por
  evento:
  - `play` y `task`;
  - `result`, con el estado (`ok`, `changed`, `failed`, `ignored`, `skipped` o
    `unreachable`), el host, la tarea y un mensaje corto;
  - `recap`, por host.

  Se activa con `ANSIBLE_CALLBACK_PLUGINS` y `ANSIBLE_CALLBACKS_ENABLED`, sin
  tocar el `ansible.cfg` del proyecto. La salida de pantalla no cambia.

- **El demo** (3 tareas, conexión local) tarda 1.6–1.8 s, en `--check` y en
  real.
- **`--vault-password-file` acepta un ejecutable.** Ansible lo corre y lee su
  salida. El secreto del vault no apareció ni en la salida ni en los eventos.
- **En `--check`, `command` y `shell` se saltan** (`skipped`). Un despliegue que
  construye con comandos, como el rol `app` de Casa Matte, no se puede
  previsualizar entero: el check sólo dice qué cambiarían los módulos
  declarativos.
- **`--diff` imprime los secretos.** Una plantilla con `API_KEY={{ secreto }}`
  salió con el valor en claro en la salida de `--check --diff`. Sólo
  `no_log: true` en la tarea lo evita. Casa Matte lo tiene en la plantilla de su
  `.env`, pero Keel no puede contar con eso.
- **Casa Matte (`infrastructure/ansible/site.yml`).**
  - Sin la contraseña del vault no pasa ni `--syntax-check`, porque `vars_files`
    carga `group_vars/vault.yml` cifrado.
  - Los archivos que hacen falta para desplegar (`vault.yml` e
    `inventory/production.yml`) están en `.gitignore`: viven sólo en el checkout
    del humano, no en un worktree de Keel.

## Falta medir (necesita el servidor)

- `ansible -m ping` y `--check` contra `prod-casamatte`, con el `ssh-agent` y el
  `known_hosts` de Keel y la llave con frase pedida en la GUI.
- El tiempo y el volumen de eventos de un `--tags deploy` real.
