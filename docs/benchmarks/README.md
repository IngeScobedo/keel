# Benchmarks

Cifras medidas con scripts que se pueden volver a correr. Ninguna cifra de un
ADR o del SDD sale de otro sitio (CLAUDE.md, «medir, no asumir»).

## Fase 0: latencias del daemon (SDD 04)

```sh
bun run bench:phase0            # imprime entorno y percentiles
bun run bench:phase0 -- --write # además guarda docs/benchmarks/<fecha>-<plataforma>.json
```

`scripts/bench-phase0.ts` arranca el daemon real como proceso aparte y mide
desde un cliente en otro proceso por el socket Unix. No lanza agentes, así que
no consume la cuenta del proveedor. Siembra 20 000 eventos de unos 200 bytes y
un repo de 500 archivos en un directorio temporal, que borra al terminar.

| Medida                           | Qué incluye                                                                                   |
| -------------------------------- | --------------------------------------------------------------------------------------------- |
| `ipc_roundtrip_health_ms`        | Ida y vuelta JSON-RPC con framing y validación Zod, sin trabajo de dominio.                   |
| `mutation_work_items_create_ms`  | Hash de la request, transacción IMMEDIATE con `synchronous=FULL`, evento y recibo; respuesta. |
| `event_delivery_after_create_ms` | Desde que el cliente manda la mutación hasta que otro cliente suscrito recibe el evento.      |
| `subscribe_replay_<n>_events_ms` | Suscripción desde el cursor 0: replay paginado completo hasta la respuesta.                   |
| `backup_vacuum_into_<n>mib_ms`   | `VACUUM INTO` con el daemon vivo (SDD 03 §7).                                                 |
| `worktree_create_<n>_files_ms`   | `@keel/git` `createWorktree`: ref, `worktree add` y metadatos.                                |
| `worktree_release_clean_ms`      | `removeWorktree` de un worktree limpio: comprobación de rescate, `worktree remove` y refs.    |

### POSIX: Linux en WSL2, 2026-10-23

[Datos completos](2026-10-23-linux-wsl-unix.json). Equipo: AMD Ryzen 7 7730U con 16
hilos y 15 GiB, kernel 6.6.87.2-microsoft-standard-WSL2, Bun 1.4.2, SQLite
3.53.2, git 2.43.0, `/tmp` en ext4, commit `8ebadf5`. Hubo tres corridas
seguidas con resultados del mismo orden; la tabla y el JSON son la tercera.

| Medida                        | n   | p50 (ms) | p95 (ms) | máx (ms) |
| ----------------------------- | --- | -------- | -------- | -------- |
| IPC ida y vuelta (`health`)   | 500 | 0.18     | 0.31     | 11.5     |
| Mutación `work_items.create`  | 300 | 2.4      | 3.6      | 11.1     |
| Entrega del evento tras crear | 300 | 2.4      | 3.5      | 11.1     |
| Replay de 20 300 eventos      | 1   | 151      | —        | —        |
| Backup de 10 MiB              | 1   | 81       | —        | —        |
| Crear worktree (500 archivos) | 30  | 73       | 79       | 89       |
| Liberar worktree limpio       | 30  | 62       | 68       | 70       |

Lectura: la mutación no es submilisegundo; está en el orden de 2 a 3 ms por
commit. Un worktree cuesta del orden de decenas de milisegundos porque son
varios procesos `git`. Ninguna cifra se extrapola a otra máquina ni a Windows.

### Windows nativo: transporte viable, daemon pendiente

`scripts/probe-windows-pipe.ts`, corrido el 2026-10-23 en Windows nativo desde
WSL con `cmd.exe` y Bun 1.3.11 (win32):

- `Bun.listen`/`Bun.connect` sobre `\\.\pipe\…` funcionan. Una «ñ» partida entre
  dos escrituras llegó intacta.
- Ida y vuelta de 300 frames en el mismo proceso: p50 0.011 ms, p95 0.020 ms,
  máx 1.2 ms. No es comparable con la medición entre procesos de Linux.

El daemon ya elige el Named Pipe en Windows
(`packages/daemon/src/ipc/endpoint.ts`) y no hace `mkdir`, `chmod` ni `unlink`
sobre él. Antes de medir el daemon completo en Windows falta:

1. Bun ≥ 1.4 en Windows (ADR-0003). El equipo tiene 1.3.11.
2. Verificar la ACL del pipe. ADR-0005 §1 pide la ACL del usuario, Bun no expone
   el descriptor de seguridad, y el DACL por defecto no está medido. Hasta
   verificarlo, el daemon en Windows no cumple §1.
3. Las piezas que hoy sólo existen en POSIX: la reconciliación de procesos (lee
   `/proc`; en Windows no encuentra ni termina procesos huérfanos, ADR-0003 §9),
   la búsqueda del binario `claude` y el binario de `sqlite-vec` para win32.

Por eso «registrar latencia de Windows» del DoD de la Fase 0 sigue abierto.
