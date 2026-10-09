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
   por plataforma), directorio `0700`, socket `0600`; en Windows, Named Pipe
   `\\.\pipe\keel-daemon-<usuario>` con ACL del usuario. Bind local siempre
   (hereda ADR-0004 de Mirador §5). Acceso remoto = túnel SSH al socket, nunca
   un puerto TCP expuesto.
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
