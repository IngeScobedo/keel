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

## ADR-0014, integraciones, plugins y visualizadores

**Cubierto:**

- **Nivel 1.** Un resultado tabular de cualquier herramienta o servidor MCP se
  ve como tabla y se grafica sin código. La gráfica es una especificación
  Vega-Lite y se puede guardar como evidencia. Vega corre en su modo seguro para
  CSP (intérprete de AST, sin `eval`) y se carga sólo al graficar.
- **Plugins** (`test/plugins.test.ts`):
  - Un manifiesto `keel-plugin.json` validado, instalado con versión y hash
    fijos.
  - El intérprete corre en su propio proceso por JSON-RPC sobre stdio, con plazo
    límite y sin secretos en el entorno.
  - Lo que devuelve se valida contra el esquema y los permisos declarados, y lo
    que no valida se rechaza con constancia.
  - Si el proceso cae, el daemon sigue y la vez siguiente lo relanza.
  - Desinstalar no borra lo interpretado, y un plugin alterado en disco no
    corre.
- **Visualizadores declarativos.** Las primitivas son `kv`, `table` y `code`, y
  no ejecutan código del plugin.

**Pendiente:**

- **MCP Apps** (§4, «después»).
- **Limitar sistema de archivos y red del plugin por sistema operativo.** El ADR
  pide medirlo antes de prometerlo; el sandbox de ADR-0018 es el candidato.
- **Publicar `@keel/plugin-sdk`.** Espera al primer plugin externo, como dice el
  ADR.
- **Los visualizadores en la TUI**, que todavía no existe.

## ADR-0016, investigaciones y reportes

**Cubierto** (`test/research.test.ts`):

- **Quién propone y quién decide.** El agente propone hipótesis, hallazgos y
  conclusiones; sólo el humano verifica o refuta. Un hallazgo sin evidencia sale
  como «sin evidencia», en la UI y en el reporte.
- **Reporte determinista.** Se genera desde los registros: los mismos dan el
  mismo hash y se reusa la versión; un cambio crea otra versión, y las
  anteriores no se tocan (trigger).
- **Gráficas.** La gráfica del reporte es el mismo artefacto que se vio en vivo.
  El HTML exportado la lleva renderizada: la GUI guarda el SVG al guardar la
  gráfica.
- **Evidencia restringida.** Sólo se exporta si el humano lo elige.

**Pendiente:**

- **Publicar al Shared Research Hub (§6).** `shared_researches` exige una
  instancia de agente y un snapshot de repo. Llega con el hub.
- **El PDF**, que el propio ADR deja para después.

## Windows: respuestas que no llegan dentro de `bun test`

**Qué pasa.** Bun 1.4.4 en Windows, en `test/resources.test.ts`, en «sin grant
vigente se pregunta». Un agente espera la decisión por la puerta de agentes, y
el humano la resuelve por la humana. El servidor escribe las dos respuestas en
el mismo tick, y la traza (`DBG send` y `DBG write`) muestra los bytes escritos
en cada socket. Aun así, ningún cliente del mismo proceso las recibe y la prueba
vence.

**Lo que no falla:**

- El mismo flujo en un script fuera de `bun test`, con las mismas consultas cada
  20 ms, funciona: la denegación llega en unos 2 ms.
- Linux.

**Mientras tanto.** La prueba se salta en Windows. Hay que reducirlo a un caso
mínimo para saber si es de Bun, y probar el puente real de un agente en Windows
antes de darlo por bueno ahí.
