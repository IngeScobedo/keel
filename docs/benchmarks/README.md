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

[Datos completos](2026-10-23-linux-wsl-unix.json). Equipo: AMD Ryzen 7 7730U con
16 hilos y 15 GiB, kernel 6.6.87.2-microsoft-standard-WSL2, Bun 1.4.2, SQLite
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

### Windows nativo, 2026-10-23

Mismo equipo que arriba, Windows 11 10.0.26200, Bun 1.4.4, SQLite 3.53.4, git
2.51.2.windows.1 y NTFS, commit `4821f36`. Las versiones de Bun, SQLite y git no
son las de WSL. Datos completos: [Named Pipe](2026-10-23-win32-pipe.json) y
[AF_UNIX](2026-10-23-win32-unix.json). Los 156 tests del workspace pasan en
Windows nativo.

| Medida                        | Pipe p50 | Pipe p95 | AF_UNIX p50 | AF_UNIX p95 |
| ----------------------------- | -------- | -------- | ----------- | ----------- |
| IPC ida y vuelta (`health`)   | 0.17     | 0.27     | 0.18        | 0.28        |
| Mutación `work_items.create`  | 1.02     | 1.53     | 1.01        | 1.47        |
| Entrega del evento tras crear | 0.98     | 1.36     | 0.97        | 1.41        |
| Replay de 20 300 eventos      | 125      | —        | 109         | —           |
| Backup de 10 MiB              | 68       | —        | 67          | —           |
| Crear worktree (500 archivos) | 459      | 491      | 463         | 511         |
| Liberar worktree limpio       | 539      | 689      | 543         | 604         |

Lectura: el transporte no cambia la latencia. Git en Windows cuesta del orden de
6 a 9 veces más que en Linux por worktree; un run `execute` paga alrededor de 1
s de git entre crear y liberar.

**ACL del endpoint.** El Named Pipe por defecto de Bun da lectura a Todos y a
ANONYMOUS LOGON; un socket AF_UNIX en `%LOCALAPPDATA%` sólo a SYSTEM,
Administradores y el usuario. El detalle y la propuesta de cambio están en
[ADR-0005](../adr/0005-ipc-json-rpc-ndjson-sobre-socket-local.md), pendientes de
decisión.

Defectos que esta prueba encontró y ya están corregidos:

- `migrate()` dejaba sentencias sin finalizar, y en Windows la base seguía
  bloqueada tras `close()`.
- `openStore` no cerraba la conexión al rechazar una migración.
- `reconcile()` no normalizaba las rutas `C:/…` de git.
- Faltaba `.gitattributes`: con `core.autocrlf`, el checksum de las migraciones
  dependía de la plataforma.

Sigue pendiente en Windows: la reconciliación de procesos lee `/proc`, así que
no encuentra ni termina procesos huérfanos (ADR-0003 §9), y la detección del
binario `claude` sólo busca rutas POSIX.
