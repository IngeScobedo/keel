# Implementación de ADR-0011 y ADR-0012 · 2026-10-23

## ADR-0012, artefactos y evidencia

Todos los criterios de aceptación están cubiertos por `test/artifacts.test.ts`:

- Un payload de 1 MiB queda como artefacto, con su preview y el hash verificado.
- Dos escrituras del mismo contenido dejan un solo archivo.
- El respaldo verifica los hashes, y uno alterado no se restaura.
- Un cursor anterior a una purga recibe `cursor_expired`.

Una decisión de implementación: los eventos siguen siendo append-only, y el
trigger sólo deja borrar mientras `retention_in_progress` marca una purga
explícita, dentro de su misma transacción.

## ADR-0011, eventos semánticos

**Cubierto** (`test/semantic.test.ts`):

- La proyección `semantic_events` y sus tres intérpretes:
  - `keel@1`: identidad, para lo que ejecuta Keel.
  - `mcp-sql@1`: consultas por MCP, cobertura `observed`.
  - `shell-inferred@1`: `psql`, `git commit` y `git push` en `Bash`, cobertura
    `inferred`.
- El esquema Zod de cada `kind`. Lo que no valida queda como
  `generic.unvalidated`.
- La reconstrucción da el mismo resultado; los ids son deterministas.
- La pestaña «Operaciones» del run muestra la cobertura de cada operación.

**Distinto del texto del ADR:**

- **Los eventos semánticos no viajan por la suscripción de eventos (§7).**
  Tienen su propio cursor (`seq`) y se leen con `semantic.list`. Meterlos en
  `events` duplicaría la historia al reconstruir. La GUI los relee cuando llegan
  eventos del run.
- **La sensibilidad es siempre `internal`.** `restricted` lo fija la política de
  conexión de ADR-0013, que todavía no existe.

**Pendiente:**

- **`keel mcp proxy` (§6).** Keel aún no configura servidores MCP de terceros en
  sus runs (`settingSources: []`, sólo el puente propio), así que no hay nada
  que envolver. Llega con las conexiones de ADR-0013 y ADR-0014.
- **El exportador OTLP (§9).** No existe, así que no envía nada: el criterio se
  cumple sin él.
