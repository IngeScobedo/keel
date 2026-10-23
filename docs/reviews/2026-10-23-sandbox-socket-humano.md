# ¿Un sandbox impide que el agente abra el socket humano? · 2026-10-23

Medición para ADR-0018, en WSL2 (kernel 6.6.87.2) con bubblewrap 0.9.0. Se
corrió contra un daemon real en `/run/user/1000/keel-realpair.sock`. El «agente»
es un `python3` que hace `connect()` sobre `AF_UNIX`, lo mismo que haría una
shell libre.

```bash
P=/run/user/1000/keel-realpair.sock
C="import socket,sys; s=socket.socket(socket.AF_UNIX); s.connect(sys.argv[1]); print('CONECTA')"
python3 -c "$C" $P                                                                          # 1
bwrap --ro-bind / / --dev /dev --proc /proc python3 -c "$C" $P                             # 2
bwrap --ro-bind / / --dev /dev --proc /proc --tmpfs /run/user/1000 python3 -c "$C" $P      # 3
bwrap --ro-bind / / --dev /dev --proc /proc --tmpfs /run/user/1000 \
      --bind $P /run/user/1000/agent.sock python3 -c "$C" /run/user/1000/agent.sock         # 4
bwrap … --tmpfs /run/user/1000 --unshare-pid python3 -c "$C" /proc/<pid>/root$P            # 5
bwrap … --tmpfs /run/user/1000 python3 -c "$C" /proc/<pid>/root$P                          # 6
```

| #   | Montaje                                                                  | Resultado   |
| --- | ------------------------------------------------------------------------ | ----------- |
| 1   | Sin sandbox                                                              | Conecta     |
| 2   | Raíz entera de solo lectura                                              | **Conecta** |
| 3   | Solo lectura y `tmpfs` encima de `$XDG_RUNTIME_DIR`                      | `ENOENT`    |
| 4   | Lo mismo que 3, con otro socket montado a propósito                      | Conecta     |
| 5   | Lo mismo que 3, por `/proc/<pid del daemon>/root/…`, con `--unshare-pid` | `ENOENT`    |
| 6   | Lo mismo que 5, sin `--unshare-pid`                                      | `EACCES`    |

## Lectura

- **«Solo lectura» no protege un socket.** Linux no comprueba si el sistema de
  archivos es de solo lectura al hacer `connect()` sobre un socket. Un sandbox
  que sólo restringe escrituras deja al agente en la puerta humana. No se supone
  que el sandbox de Claude Code o el de Codex lo cubran: hay que medirlo.
- **Ocultar la ruta funciona**, y montar sólo la puerta de agentes también. Esto
  sostiene las piezas 2 y 3 de ADR-0018.

## Lo que esto no prueba

- Los sandbox de Claude Code y de Codex. Aquí sólo se midió bubblewrap.
- macOS y Windows.
- Sockets abstractos. Keel no los usa, y `--unshare-net` los aísla.
