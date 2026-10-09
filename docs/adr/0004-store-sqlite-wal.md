# ADR-0004: Store — SQLite WAL local; el envelope de Mirador se conserva

- **Estado:** Propuesto
- **Fecha:** 2026-10-08
- **Criticidad:** Alta
- **Relacionados:** ADR-0001 (adopta 0002 de Mirador salvo su sección «El
  store»), ADR-0003, SDD 03
- **Evidencia:** DDL del SDD 03 ejecutado el 2026-10-08 sobre SQLite 3.53.1 con
  FTS5 y `sqlite-vec` 0.1.9: 36 comprobaciones en verde.

## Contexto

ADR-0002 de Mirador eligió Postgres + `jsonb` + GIN y dejó anotado: «SQLite
local-first […] es la mejor opción si el producto se queda mono-usuario. […]
Revisar esta decisión si la instalación local con cero dependencias se vuelve
requisito.» Keel es ese requisito: se descarga y corre, sin contenedor de base
de datos.

El SDD 03 ya trae el esquema completo: `work_spaces`, `projects`,
`project_repos`, `work_items`, `runs`, `lanes`, `run_worktrees`,
`agent_instances`, `workflow_nodes`, `tool_calls`, `events`, `activities`,
`evidence`, `outbox`, Research Hub con FTS5 y `sqlite-vec`, Contract Hub con
historial append-only y triggers de inmutabilidad.

## Decisión

1. **SQLite 3 en modo WAL, un archivo por daemon, en el disco local del target
   que ejecuta el daemon.** `synchronous=FULL`, `foreign_keys=ON`,
   `busy_timeout`. El daemon es el único escritor; los clientes nunca abren el
   archivo (ADR-0005).
2. **El esquema de referencia es el del SDD 03**, versionado como migraciones
   numeradas con checksum y tabla de aplicación. El DDL del SDD no se copia a
   mano al código: la migración 0001 **es** ese DDL, y el test que lo valida
   (los 36 checks) se porta a `bun test`.
3. **Las reglas del envelope de ADR-0002 de Mirador se conservan en `events`:**
   `kind` string libre sin `CHECK`; `payload_json` íntegro y saneado sin
   descartar campos desconocidos; umbral de 256 KiB con preview + referencia a
   artefacto con hash y tamaño; nunca truncar en silencio; append-only por
   trigger. Derivaciones que fallen dejan `null`, no rechazan el evento.
4. **Proyecciones, no verdad.** `agent_instances`, `tool_calls` y
   `workflow_nodes` se reconstruyen desde `events` con `@keel/core`; un comando
   de rebuild lo demuestra en CI contra los fixtures.
5. **Extensiones.** FTS5 va siempre. `sqlite-vec` se carga si está disponible;
   si no, el Research Hub funciona en modo léxico y la UI lo dice (SDD 02 §5).
   Ninguna consulta asume vectores.
6. **Retención y borrado** son operaciones explícitas de mantenimiento, por
   `run_id`, nunca un `DELETE` en caliente del flujo normal.

## Consecuencias

**Positivas**

- Cero dependencias de infraestructura: «descarga y corre» se cumple.
- Un archivo = backup trivial (API de backup de SQLite, no `cp` con el daemon
  vivo).
- Las proyecciones reconstruibles hacen que un bug de correlación se arregle con
  un rebuild.

**Negativas**

- Un solo escritor y un solo host: «el equipo ve las corridas de todos» no
  existe en v1. Si llega, es un ADR nuevo (sync o servidor), no un cambio de
  este.
- Queries analíticas sobre JSON en SQLite son más pobres que en Postgres. Se
  mitiga con las proyecciones del punto 4 y con FTS5.
- `sqlite-vec` es una extensión nativa que hay que distribuir por plataforma;
  por eso es opcional.

## Alternativas consideradas

- **Postgres (ADR-0002 de Mirador).** Rechazada por el requisito de instalación
  local.
- **Store de eventos dedicado.** Rechazada: sobrecosto operativo sin usuario que
  lo pida.
- **JSON en disco sin base.** Rechazada: el scheduler, los leases y el outbox
  necesitan transacciones.
