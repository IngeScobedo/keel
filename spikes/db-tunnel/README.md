# Spike: Postgres detrás de un túnel SSH (ADR-0033)

Mide un túnel `ssh -L` hacia el Postgres de un servidor y el primer mensaje del
protocolo (`SSLRequest`), que no pide credenciales: así se prueba que el túnel
llega a la base sin tocar datos.

```bash
TUNNEL_DEST=root@servidor TUNNEL_TARGET=127.0.0.1:5432 bun spikes/db-tunnel/src/probe.ts
```

## Resultados (2026-10-28, WSL2 → VPS de Casa Matte, Postgres 16 en Docker en 127.0.0.1:5432)

| Medida                                       | Con la config del humano | Como Keel (`-F none`) |
| -------------------------------------------- | ------------------------ | --------------------- |
| Puerto local listo                           | 113 ms                   | 1038 ms               |
| Primer `SSLRequest` (respuesta `N`, sin TLS) | 167 ms                   | 547 ms                |
| Siguientes                                   | 165–183 ms               | 273–288 ms            |
| `ssh` sale al recibir SIGTERM                | no (5 s y seguía)        | sí, en 3 ms           |
| El puerto local queda abierto al cerrar      | **sí**                   | no                    |

- **Con la config del humano** (`ControlMaster auto`, `ControlPersist 10m`) el
  reenvío se monta en el proceso maestro que ya estaba abierto: es rápido, pero
  al terminar el `ssh` del túnel **el puerto hacia la base queda abierto** en el
  maestro hasta que vence (10 min). Se cerró a mano con `ssh -O cancel`.
- **Como Keel** (`-F none`, `ControlMaster=no`, `ControlPath=none`,
  `ExitOnForwardFailure=yes`): abrir cuesta 1 s porque autentica, cada conexión
  nueva por el túnel cuesta unos 280 ms y cerrar libera el puerto al instante.
- La base sólo escucha en `127.0.0.1` del servidor: sin túnel no se alcanza.
