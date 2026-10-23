# ADR-0005: IPC — JSON-RPC 2.0 en NDJSON sobre socket Unix / Named Pipe; los clientes nunca escriben la base

- **Estado:** Propuesto
- **Fecha:** 2026-10-08
- **Criticidad:** Alta
- **Relacionados:** ADR-0003 (esta frontera es lo que lo hace reversible),
  ADR-0004, SDD 02 §2 y §3

## Contexto

Mirador usó HTTP + SSE porque el flujo era casi unidireccional (ADR-0005 de
Mirador, «si el modo runtime interactivo llega a necesitar bidireccionalidad
real, ahí se reevalúa»). Keel es ese caso: los clientes mandan comandos (crear
tarea, aprobar gate, pausar run, adjuntar PTY) y reciben un stream de eventos;
además hay varios clientes (TUI, GUI, CLI) a la vez y uno de ellos puede estar
en otra máquina por SSH.

## Decisión

1. **Transporte:** socket Unix en `$XDG_RUNTIME_DIR/keel/keel.sock` (fallback
   por plataforma), directorio `0700`, socket `0600`. En Windows, socket AF_UNIX
   en `%LOCALAPPDATA%\keel\keel.sock`, con la ACL del usuario heredada del
   perfil; no se usa Named Pipe (revisión del 2026-10-23, abajo). Bind local
   siempre (hereda ADR-0004 de Mirador §5). Acceso remoto = túnel SSH al socket,
   nunca un puerto TCP expuesto.
2. **Framing:** una línea JSON UTF-8 por mensaje (NDJSON). Límite de frame 8
   MiB; lo que no cabe va como artefacto con hash, tamaño y preview (coherente
   con ADR-0004 §3).
3. **Protocolo:** JSON-RPC 2.0 con envelope versionado (`keel_protocol: 1`).
   Comandos de mutación llevan `request_id`, `idempotency_key` y, cuando
   aplique, revisión esperada; el daemon guarda `command_receipts` (SDD 03) y
   reintentar no duplica efectos. Errores estructurados con `code`, `message`,
   `retryable`, `details`.
4. **Suscripción:** `events.subscribe` con `after_event_seq`; el daemon manda
   snapshot + cursor y luego el stream. Reconectar repone lo que faltó.
   Backpressure por cliente; un cliente lento no frena al daemon ni a otros
   clientes.
5. **Operaciones iniciales** (SDD 02 §2): `work_items.*`, `runs.*`,
   `approvals.resolve`, `events.subscribe`, `fs.read`, `diff.read`,
   `pty.attach`. Se añaden por ADR o por nota en el SDD con su esquema Zod;
   **todo mensaje se valida en la frontera** con `@keel/core`.
6. **Los clientes nunca abren el archivo SQLite.** Ni para leer. Toda lectura
   pasa por el daemon. Es lo que permite que el daemon cambie de lenguaje o de
   store sin tocar clientes.
7. **Identidad del cliente** viene de la conexión (usuario del socket / pipe),
   no de un campo del mensaje. Un agente nunca puede fabricar un actor humano
   (SDD 01 §3, «cierre humano»).

## Revisión del punto 1 en Windows (2026-10-23, decidida por el humano)

Medido en Windows 11 (10.0.26200) con Bun 1.4.4 y el daemon real:

- El Named Pipe que crea `Bun.listen` lleva el DACL por defecto:
  `D:(A;;FR;;;WD)(A;;FR;;;AN)(A;;FA;;;SY)(A;;FA;;;BA)(A;;FA;;;<usuario>)`. Todos
  (`WD`) y ANONYMOUS LOGON (`AN`) tienen lectura, y el pipe es alcanzable por la
  red. Sin escritura no pueden mandar comandos, pero no es «la ACL del usuario»
  que exige el punto 1. Bun no permite fijar el descriptor de seguridad.
- Un socket AF_UNIX (Windows 10 1803 o posterior), que Bun también soporta, en
  `%LOCALAPPDATA%\keel\keel.sock` hereda
  `D:(A;ID;FA;;;SY)(A;ID;FA;;;BA)(A;ID;FA;;;<usuario>)`: sólo SYSTEM,
  Administradores y el usuario, y es local.
- La latencia es la misma con los dos: ida y vuelta p50 0.17 frente a 0.18 ms,
  mutación p50 1.02 frente a 1.01 ms
  ([docs/benchmarks](../benchmarks/README.md)).

Decisión del humano (2026-10-23): en Windows, socket AF_UNIX en
`%LOCALAPPDATA%\keel\` en lugar del Named Pipe. El resto del punto 1 no cambia.
Consecuencia: el shell de Tauri necesita un cliente AF_UNIX para Windows, porque
`tokio::net::UnixStream` sólo existe en Unix. `transport.rs` usa `uds_windows`
puenteado a tokio. Compilado y probado en Windows con `cargo test` contra el
daemon real el 2026-10-23. La alternativa que conserva el pipe exige crearlo con
`SECURITY_ATTRIBUTES` propios fuera de Bun (FFI o un binario nativo) y que el
daemon lo integre en su bucle. El estado del ADR sigue en Propuesto: la
aceptación del conjunto es del humano.

## Consecuencias

**Positivas**

- Un solo contrato para TUI, GUI y CLI; el daemon se prueba con un cliente de
  test en NDJSON.
- Depurable con `socat` / `nc`.
- Reconexión y multi-cliente sin estado en el cliente.

**Negativas**

- Más trabajo que SSE: hay que implementar cursor, snapshot y backpressure desde
  el inicio.
- Named Pipes en Windows y sockets en WSL2 son dos implementaciones del punto 1
  que hay que probar en matriz.

## Alternativas consideradas

- **HTTP + SSE (Mirador).** Rechazada: el flujo es bidireccional y
  multi-cliente.
- **WebSocket.** Rechazada: añade HTTP y un puerto donde basta un socket local.
- **gRPC.** Rechazada: tooling pesado para un protocolo que una persona tiene
  que poder leer con `nc`.
