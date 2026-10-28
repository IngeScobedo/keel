/**
 * Dobles de `ansible-playbook` y `ansible-vault` (ADR-0031): se portan como los de verdad
 * con el callback de Keel, escriben los eventos en KEEL_ANSIBLE_EVENTS y muestran lo que
 * Keel les pasó, para comprobarlo. Los usan ansible.test.ts y el daemon del e2e.
 */
import { chmodSync, mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"

export const VAULT_PASS = "pass-ansible-vault-4e2b"
export const VAULT_VALUE = "centinela-ansible-api-91c0"

/** Como `ansible-playbook` con el callback de Keel: eventos NDJSON y salida de pantalla. */
export const FAKE_PLAYBOOK = `#!/bin/bash
inv=""; vp=""; check=no
while [ $# -gt 0 ]; do case "$1" in -i) inv="$2"; shift;; --vault-password-file) vp="$2"; shift;; --check) check=yes;; esac; shift; done
pw=""; [ -n "$vp" ] && pw=$("$vp")
wrapper=$(grep ansible_ssh_executable "$inv" | sed 's/.*: "\\(.*\\)"/\\1/')
E="$KEEL_ANSIBLE_EVENTS"
echo '{"kind":"play","name":"Desplegar"}' >> "$E"
# Como un servidor que acepta la llave pero nunca abre la sesión (VPS, 2026-10-28).
if [ -f "$(dirname "$0")/hang" ]; then echo '{"kind":"task","name":"Gathering Facts","action":"gather_facts"}' >> "$E"; sleep 30; exit 0; fi
echo '{"kind":"task","name":"Instala paquetes","action":"ansible.builtin.apt"}' >> "$E"
echo '{"kind":"result","status":"changed","host":"web","task":"Instala paquetes","changed":true,"msg":null}' >> "$E"
echo '{"kind":"task","name":"Construye","action":"ansible.builtin.command"}' >> "$E"
if [ "$check" = yes ]; then
  echo '{"kind":"result","status":"skipped","host":"web","task":"Construye","changed":false,"msg":null}' >> "$E"
  echo '{"kind":"recap","hosts":{"web":{"ok":1,"changed":1,"failures":0,"unreachable":0,"skipped":1}}}' >> "$E"
else
  echo '{"kind":"result","status":"changed","host":"web","task":"Construye","changed":true,"msg":null}' >> "$E"
  echo '{"kind":"recap","hosts":{"web":{"ok":2,"changed":2,"failures":0,"unreachable":0,"skipped":0}}}' >> "$E"
fi
echo "TASK [Instala paquetes] vault=$pw api=${VAULT_VALUE}"
echo "check=$check hkc=$ANSIBLE_HOST_KEY_CHECKING transfer=$ANSIBLE_SSH_TRANSFER_METHOD"
echo "cp=$ANSIBLE_SSH_CONTROL_PATH_DIR"
echo "estricta=$(grep -c 'StrictHostKeyChecking=yes' "$wrapper")"
`
/** Como `ansible-vault view`: descifra con la contraseña del script y muestra el YAML. */
export const FAKE_VAULT = `#!/bin/bash
vp=""; while [ $# -gt 0 ]; do case "$1" in --vault-password-file) vp="$2"; shift;; esac; shift; done
[ "$("$vp")" = "${VAULT_PASS}" ] || { echo "Decryption failed" >&2; exit 1; }
printf 'api_key: "${VAULT_VALUE}"\\nport: 5432\\n'
`


/** Escribe los dos dobles en `bin`; `delay` deja ver el avance en vivo. */
export function writeFakeAnsible(bin: string, delay = 0): string {
  mkdirSync(bin, { recursive: true })
  const pause = delay ? `sleep ${delay}\n` : ""
  writeFileSync(
    join(bin, "ansible-playbook"),
    FAKE_PLAYBOOK.replaceAll('>> "$E"\n', `>> "$E"\n${pause}`),
  )
  writeFileSync(join(bin, "ansible-vault"), FAKE_VAULT)
  chmodSync(join(bin, "ansible-playbook"), 0o755)
  chmodSync(join(bin, "ansible-vault"), 0o755)
  return join(bin, "ansible-playbook")
}
