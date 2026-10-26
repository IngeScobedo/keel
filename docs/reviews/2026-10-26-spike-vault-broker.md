# Spike de ADR-0025: la frontera, el ssh-agent de Keel, askpass y el cifrado

- **Fecha:** 2026-10-26
- **Relacionados:** ADR-0025 (vault y broker), ADR-0018 (sandbox), ADR-0013
- **Se vuelve a correr con:** `bun spikes/sdk-capabilities/src/vault-probe.ts`
  (la captura queda en `spikes/sdk-capabilities/captures/`, fuera de git)
- **Máquina:** WSL2, bubblewrap 0.9.0, OpenSSH 9.6p1, gnome-keyring 46.1, Bun
  1.3.11

## Lo medido

| Prueba                                     | Fuera del sandbox | Sandbox de hoy (ADR-0018) | Sandbox propuesto |
| ------------------------------------------ | ----------------- | ------------------------- | ----------------- |
| Bus de D-Bus de la sesión                  | sí                | **sí**                    | no                |
| Secret Service (`org.freedesktop.secrets`) | sí                | **sí**                    | no                |
| `~/.ssh` con contenido                     | sí                | **sí**                    | no                |
| `ssh-agent` del humano (`ssh-add -l`)      | sí                | **sí**                    | no                |
| Puerta de agentes                          | sí                | sí                        | sí                |
| Estado de Keel                             | visible           | tapado                    | tapado            |

- **El sandbox de hoy deja pasar el llavero.** Tapa el estado de Keel y la
  carpeta del socket humano, pero no `$XDG_RUNTIME_DIR` entero ni `~/.ssh`. Una
  referencia `keychain:` de ADR-0013 es legible desde la shell del agente, y el
  agente puede usar el `ssh-agent` del humano.
- **El sandbox propuesto** tapa con `tmpfs` `$XDG_RUNTIME_DIR`, `~/.ssh` y el
  estado de Keel, vuelve a montar sólo la puerta de agentes y quita
  `SSH_AUTH_SOCK` y `DBUS_SESSION_BUS_ADDRESS` del entorno. Con eso, las cuatro
  pruebas de alcance dan «no» y la puerta de agentes sigue funcionando.
- **Llave en memoria.** Una ed25519 generada con `node:crypto` y escrita en el
  formato `openssh-key-v1` entra al `ssh-agent` de Keel con `ssh-add -t 60 -`
  por la entrada estándar. `ssh-add -L` devuelve la misma pública, y en la
  carpeta del agente sólo existe su socket: la llave no tocó el disco.
- **askpass.** `ssh-add` de una llave con frase, con
  `SSH_ASKPASS_REQUIRE=force`, llama al programa de Keel con el texto del prompt
  («Enter passphrase for …»). El programa entrega la frase si el token de un
  solo uso coincide; el segundo intento con el mismo token se rechaza.
- **Llavero.** El Secret Service responde fuera del sandbox, pero
  **`secret-tool` no está instalado** (lo trae `libsecret-tools`). Sin él, el
  vault usa la frase de respaldo (ADR-0025 §2). Instalarlo es un paso del
  humano: `sudo apt install libsecret-tools`.
- **Cifrado.** AES-256-GCM con una DEK por secreto, envuelta por la KEK con
  AES-KW, todo con WebCrypto: ida y vuelta correcta, DEK envuelta de 40 bytes y
  el valor centinela ausente del texto cifrado.

## Lo que no se midió

- `ssh` contra un servidor real: no hay `sshd` en la máquina ni `sudo` para
  instalarlo. `ssh` y `ssh-add` usan el mismo agente y el mismo askpass; las
  pruebas del daemon usan un `ssh` falso (`ssh_path`) que comprueba el entorno
  que recibe.
- D-Bus con sockets abstractos (`unix:abstract=`), que algunas distribuciones
  usan: tapar la ruta no los cubre. Aquí el bus es una ruta. Si aparece, hace
  falta `--unshare-net`, que hoy no se usa porque el proveedor necesita red.
- macOS (Keychain, Seatbelt) y Windows (Credential Manager).

## Un error del spike, no del diseño

El servidor de askpass vivía en el mismo proceso que lanzaba `ssh-add` con
`spawnSync`, que bloquea el event loop: nadie contestaba. En el daemon el
servidor y el `ssh` ya corren en procesos distintos; aun así, el broker lanza
`ssh` de forma asíncrona.
