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

## ADR-0013, intermediario de recursos

**Cubierto** (`test/resources.test.ts`):

- **Lectura sin credencial al agente.** `query.read` con grant `auto` en `dev`
  devuelve las filas; queda evidencia con procedencia y el evento
  `database.query.completed` como `instrumented`.
- **La base rechaza escribir.** Un `query.read` que intenta escribir falla en la
  propia base SQLite, abierta en `mode=ro`, aunque el texto engañe.
- **Sin grant se pregunta.** Si se deniega, no corre; si se aprueba, corre una
  vez.
- **Producción.** Las escrituras nunca son `auto`, lo producido es `restricted`
  y no aparece en la búsqueda.
- **SSH.** Sólo pasan los comandos de la lista, y un encadenamiento no pasa.
- **Terraform real.** `apply` sólo ejecuta el plan aprobado, y uno alterado se
  rechaza. El secreto centinela no aparece en ninguna tabla de Keel, en los
  artefactos ni en lo devuelto.

**Distinto del texto del ADR:**

- **El archivo de plan de Terraform no es un artefacto.** Lleva las variables,
  secretos incluidos, en claro, y guardarlo en el almacén rompería el criterio
  del secreto centinela. Vive en la carpeta privada de Keel (`plans/`, 0600) con
  su hash, y la aprobación se ata a ese hash. El artefacto es la salida
  redactada de `terraform show`.
- **SSH usa las llaves y el agente del usuario.** Keel no maneja llaves.
  `secret_ref` no aplica a SSH.

**Pendiente:**

- **PostgreSQL.** Está implementado con `Bun.SQL`: transacción `READ ONLY`,
  `statement_timeout` y credencial de sólo lectura si existe. No se probó contra
  un servidor real, porque aquí no hay ninguno instalado.
- **El llavero de Windows** (Credential Manager).
- **Las redes remotas y los secretos rotativos de Vault**, que el propio ADR
  deja fuera.
