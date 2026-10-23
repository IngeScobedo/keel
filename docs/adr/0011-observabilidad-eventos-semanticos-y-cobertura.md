# ADR-0011: Observabilidad: eventos de origen, eventos semánticos y cobertura

- **Estado:** Propuesto
- **Fecha:** 2026-10-22
- **Criticidad:** Alta
- **Relacionados:** ADR-0004 §3–§4 (envelope de eventos, proyecciones), ADR-0005
  (suscripción con cursor), ADR-0009 §7, ADR-0012 (artefactos), ADR-0014
  (intérpretes de terceros), SDD 02 §8

## Contexto

El humano quiere ver en vivo lo que hacen los agentes y revisarlo después: qué
consulta SQL corrió, qué devolvió, qué commit hizo y desde qué worktree. El caso
que lo motiva es una auditoría de dinero, donde importan las consultas y sus
resultados tanto como la conclusión.

Hoy `events` guarda lo que emite cada fuente (`source`, `fidelity`,
`adapter_version`, `kind` libre, `payload_json` saneado, umbral de 256 KiB,
append-only), y `@keel/core` proyecta nodos y tool calls. Eso basta para un
visor de mensajes, pero no para reconocer «esto fue una consulta a PostgreSQL».

Las convenciones GenAI y MCP de OpenTelemetry (`invoke_agent`, `execute_tool`)
existen, pero siguen en estado _Development_: los nombres de atributos pueden
cambiar.

## Decisión

1. **Dos capas.** El evento de origen es lo que emitió el SDK, el CLI, el
   servidor MCP o Keel. Se guarda en `events` como hoy y es la verdad. El evento
   semántico es una proyección: un intérprete versionado lee eventos de origen y
   produce `database.query.completed`, `git.commit.created` y similares. Se
   reconstruye desde `events` (ADR-0004 §4), así que mejorar un intérprete no
   pierde historia.
2. **Lo que ejecuta Keel nace semántico.** Cuando la operación la hace Keel (sus
   tools de git, el intermediario de recursos de ADR-0013), el evento de origen
   ya lleva el `kind` semántico (`source = 'keel'`) y el intérprete es la
   identidad.
3. **Nombres y esquemas.** `<dominio>.<objeto>.<verbo en participio>`. Cada
   `kind` semántico tiene un esquema Zod con `schema_version` en `@keel/core` o
   en la integración que lo define (ADR-0014). Un payload que no valida se
   guarda como evento genérico, nunca se descarta.
4. **Correlación.** Todo evento semántico apunta a proyecto, tarea, run, nodo de
   agente y tool call cuando existen, y a los ids de los eventos de origen que
   lo produjeron. El run es la traza y la tool call es el span. Si el transporte
   admite `traceparent`, Keel lo propaga; si no, basta su propia correlación.
5. **Cobertura declarada.** Cada evento semántico dice cómo se obtuvo:
   - `instrumented`: lo ejecutó Keel o un proxy suyo vio petición y respuesta.
   - `observed`: el proveedor reportó la llamada y su resultado (por ejemplo,
     `mcp__postgres__query` en el stream del SDK).
   - `inferred`: deducido del texto de un comando o del estado del repo.

   La UI muestra la cobertura. Algo inferido nunca se presenta como observado, y
   lo que no se ve se dice: un `psql` dentro de `Bash` no tiene filas.

6. **Servidores MCP de terceros.** Keel sólo ve lo que pasa por su proceso. Para
   cobertura `instrumented` de un servidor stdio que Keel configura, lo lanza
   envuelto en `keel mcp proxy -- <comando>`. El proxy reenvía sin modificar y
   registra petición, respuesta y duración. Un servidor MCP que el usuario
   configuró fuera de Keel queda fuera de su vista, y Keel no lo aparenta.
7. **En vivo y después, por el mismo canal.** Los eventos semánticos viajan por
   la suscripción con cursor de ADR-0005. Los clientes filtran por `kind`. Los
   resultados grandes van como artefacto (ADR-0012), nunca embebidos.
8. **Sensibilidad.** Cada evento semántico lleva `sensitivity`: `internal` o
   `restricted`. `restricted` lo fija la política de la conexión (ADR-0013, por
   ejemplo producción). Lo restringido no se exporta, no entra a búsqueda ni a
   embeddings (ADR-0017), y su vista previa va oculta por defecto.
9. **OpenTelemetry es exportación, no esquema.** Un exportador OTLP opcional,
   apagado por defecto, mapea runs y tool calls a `invoke_agent` y
   `execute_tool`. El esquema propio de Keel manda, porque las convenciones
   siguen cambiando. Nada sale de la máquina sin que el humano lo active.

## Criterios de aceptación

- Un fixture con una llamada MCP a PostgreSQL produce `database.query.completed`
  con consulta, número de filas, artefacto del resultado y cobertura `observed`.
- Borrar la tabla semántica y reconstruirla desde `events` da el mismo
  resultado.
- Un `Bash` con `psql` produce como mucho un evento `inferred`, nunca uno
  `observed`.
- El exportador OTLP no envía nada sin activarlo.

## Consecuencias

- Migración: tabla `semantic_events` (proyección) con `kind`, `schema_version`,
  `coverage`, `sensitivity`, `interpreter` (`nombre@versión`),
  `source_event_ids` y referencias a artefactos.
- El proyector actual se vuelve el primer intérprete (tool calls y nodos).
- `keel mcp proxy` es otro modo del binario de ADR-0009.

## Alternativas consideradas

- **Sólo un visor de JSON del proveedor.** Sirve para depurar, no para auditar
  ni para mostrar una consulta con sus filas.
- **Guardar todo en el esquema de OpenTelemetry.** Las convenciones GenAI y MCP
  están en _Development_; atarse a ellas obligaría a migraciones ajenas.
- **Un servicio aparte con PostgreSQL para eventos.** ADR-0004 decide SQLite
  local; el volumen de un usuario no lo justifica.
- **Intérpretes que escriben verdad.** Si el evento semántico fuera la fuente,
  un intérprete con errores corrompería la historia.
