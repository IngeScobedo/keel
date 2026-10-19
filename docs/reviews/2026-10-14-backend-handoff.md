# Revisión del backend para retomar con Claude

Fecha: 2026-10-14. Base revisada: `5996ec9`. Estos hallazgos están pendientes;
el trabajo actual continúa en la GUI según la instrucción del usuario.

## Verificación

Pasaron `bun run typecheck`, `bun run ddl:check` y las 97 pruebas existentes (79
core + 18 daemon). `bun run lint` pasó con un aviso informativo de versión del
schema Biome. Las reproducciones adicionales usaron SQLite temporal, sockets
locales y queryFn de fixtures; no ejecutaron consultas a proveedores.

## Hallazgos reproducidos

| ID   | Prioridad | Archivo / ubicación                                                               | Resultado observado                                                                                                                                | Corrección y regresión requerida                                                                                                                             |
| ---- | --------- | --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| K-01 | P1        | `packages/core/src/protocol.ts:357`, `packages/daemon/src/ipc/server.ts:181`      | `method: toString` pasa `method in Methods`, intenta `params.safeParse` sobre una propiedad heredada y termina el daemon con exit 1.               | Comprobar propiedades propias; capturar fallos de validación dentro del handler. Probar toString/constructor y que health siga respondiendo.                 |
| K-02 | P1        | `packages/daemon/src/daemon.ts:223`                                               | `runs.start` lanzó un run `running` para una tarea cuyo lifecycle seguía `blocked`.                                                                | Validar elegibilidad, lifecycle y bloqueos antes de crear/despachar. Probar contrato/budget/human blocks y no ejecutar queryFn.                              |
| K-03 | P1        | `packages/daemon/src/ipc/server.ts:236`                                           | Con 1,005 eventos guardados, subscribe entregó 1,000 y devolvió cursor 1,005. Los cinco restantes no se recuperan por el stream futuro.            | Paginar hasta el cursor capturado; probar más de dos páginas y concurrencia con nuevos eventos.                                                              |
| K-04 | P1        | `packages/daemon/src/daemon.ts:162`                                               | Al inyectar un fallo SQLite en INSERT command_receipts, la tarea ya estaba guardada. Reintentar con la misma key creó una segunda tarea.           | Mutación de dominio, evento y recibo en una transacción. Dispatch/bus después del commit. Prueba de fallo entre mutación y recibo.                           |
| K-05 | P2        | `packages/daemon/src/ipc/server.ts:102`, `packages/daemon/src/ipc/client.ts:34`   | Separar los bytes UTF-8 de ñ entre dos chunks cambió Español por Espa��ol en la tarea guardada.                                                    | Buffer de bytes o decoder streaming. Usar bytes también para límites/partial writes, no String.length. Probar tildes, emoji y caracteres multibyte partidos. |
| K-06 | P2        | `packages/daemon/src/projector.ts:208`                                            | Una tool_response JSON válida de 300,000 caracteres fue cortada con slice; SQLite rechazó output_json por json_valid y el tool call quedó running. | Preview JSON válido + puntero/hash/tamaño al cuerpo íntegro. Probar respuestas grandes sin interrumpir el run ni perder el cuerpo.                           |
| K-07 | P2        | `packages/daemon/src/daemon.ts:211`                                               | expected_revision 999 fue aceptada sobre una tarea revision 0; cambió a planned/revision 1.                                                        | CAS en UPDATE/transaction y error conflict al no coincidir. Validar también transiciones legales, no solo prohibir done.                                     |
| K-08 | P2        | `packages/daemon/src/adapters/claude.ts:128`, `packages/daemon/src/daemon.ts:239` | En api_key sin clave, buildEnv rechazó antes del try y dejó el run queued/vivo. El caller usa then sin catch.                                      | Fallo terminal y evento antes del spawn; catch de ejecución background. Probar error de config/auth y siguiente intento sin bloqueo zombie.                  |

La prueba de dos work_items.create concurrentes con la misma key sí devolvió la
misma tarea; K-04 se refiere al fallo entre escritura y recibo, no a una carrera
concurrente demostrada.

## Pendientes encontrados durante la GUI

- `events.subscribe` sin project_id devuelve snapshot vacío. Para una base nueva
  el cliente no puede descubrir el proyecto por snapshot. Hace falta listar
  proyectos o incluir el proyecto por defecto en health/bootstrap.
- `approval.requested` lleva ID, hash y tool, pero no la operación completa.
  Antes de aprobar desde la GUI hace falta un método de lectura del detalle que
  entregue target, parámetros saneados, scope, TTL y revisión. La GUI debe
  retener la aprobación si no puede mostrar ese detalle.
- `projection.updated` notifica IDs de agentes/tools. Falta lectura de nodos y
  detalle de tool calls para construir un árbol vivo reconstruible después de
  reconectar; el snapshot actual sólo incluye tareas y runs.
- runs.start recibe profile, pero el handler usa siempre el perfil global.
  Declarar unsupported o resolver la revisión solicitada explícitamente.
- work_items.create recibe project_id, pero se crea siempre en el proyecto
  default del daemon. La selección multi-proyecto necesita contrato efectivo.
- Shutdown/reconcile: revisar cancelación y quiescencia antes de cerrar DB o
  liberar un run. findChildProcess(binary,cwd) no distingue dos hijos del mismo
  binario/cwd; el registro de PID debe provenir del spawn de ese run.
- Los runs usan el cwd principal; worktrees/lanes, metering en vivo y gates de
  contratos todavía requieren implementación. Mantener esas acciones
  diferenciadas de los ejemplos de diseño.

Estos pendientes son límites de integración observados; no se presentan como
defectos ya reproducidos de funciones que aún no se han implementado.

## Diseño leído por MCP

El canvas actual se leyó el 2026-10-14: 17 páginas, 123 variantes de pantalla,
112 componentes y 107 tokens. Los tokens del repo coinciden con el canvas.
[Snapshot de IDs y tokens](2026-10-14-canvas-snapshot.json).

Las 12 fixtures TUI tienen correctamente 80×24 o 160×40 celdas. Se revisaron
visualmente diez pantallas representativas, además de jerarquía/textos de todas
las variantes. Los avisos de bounds necesitan triage: clipping de
viewport/variantes deshabilitadas no equivale por sí solo a un defecto.
