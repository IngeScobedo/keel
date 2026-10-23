# ADR-0013: Intermediario de recursos: conexiones, secretos y permisos por operación

- **Estado:** Aceptado (2026-10-23)
- **Fecha:** 2026-10-22
- **Criticidad:** Máxima
- **Relacionados:** ADR-0002 (sin manejo de credenciales de proveedores),
  ADR-0003 (el vault guarda referencias), ADR-0009 §6, ADR-0011 §8, ADR-0012,
  SDD 01 §08 (Connection Broker, reglas `auto`/`ask`/`dry_run_then_ask`/`deny`),
  SDD 02 §9, SDD 04 Fase 6

## Contexto

Un proyecto puede tener acceso a servidores por SSH, bases de datos de
desarrollo y producción, y despliegues con Terraform. El humano quiere que el
agente las use con el contexto del workspace, y ver qué hizo con ellas.

El SDD ya define la pieza: `connections` (con `secret_ref`), `permission_grants`
con las políticas `auto`, `ask`, `dry_run_then_ask` y `deny` con alcance y
caducidad, `approval_requests` con hash de la operación, y roles `agent_ro` y
`agent_rw`. Falta decidir dónde viven los secretos, quién ejecuta y qué
garantiza cada control.

Hechos que pesan:

- Un secreto en el entorno o en la configuración del agente lo puede leer el
  propio agente (ADR-0009, contexto).
- Revisar que una consulta empiece con `SELECT` no garantiza que sea de lectura.
- Bun tiene recolector de basura: no se puede prometer borrar un secreto de la
  memoria (ADR-0003).

## Decisión

1. **Keel no guarda valores de secretos.** `secret_ref` apunta a un almacén
   externo:
   - El llavero del sistema (libsecret, Keychain o el Credential Manager de
     Windows).
   - `op://` de 1Password CLI o una ruta de HashiCorp Vault.
   - El nombre de una variable de entorno del daemon.

   El daemon resuelve la referencia sólo al ejecutar y la suelta al terminar. Lo
   único que se promete es que el secreto vive en memoria el menor tiempo
   posible (ADR-0003).

2. **El agente recibe operaciones, no credenciales.** Por el puente de ADR-0009
   ve `resources.list` (conexiones del proyecto vinculado con sus operaciones
   permitidas) y tools tipadas: `db.query`, `ssh.run` e `iac.plan`/`iac.apply`.
   Las ejecuta el daemon con la credencial y el agente ve el resultado. Ninguna
   credencial entra al entorno del agente, a un prompt, a un evento o a un
   resultado MCP.
3. **Redacción exacta.** Mientras el intermediario tiene el valor resuelto, lo
   añade como patrón literal de redacción. Si el servidor lo devuelve en la
   salida, se borra antes de guardar o mostrar nada.
4. **Política por conexión, operación y entorno.**
   - Cada tipo define sus operaciones: PostgreSQL `schema.read`, `query.read` y
     `query.write`; SSH `command.run`; Terraform `plan` y `apply`.
   - Cada conexión declara su entorno (`dev`, `staging`, `prod`).
   - Una conexión nueva empieza en `ask` para todo. El humano puede poner en
     `auto` las lecturas de `dev`.
   - En `prod`, las escrituras, `command.run` y `apply` nunca son `auto`.
     Producción es `restricted` (ADR-0011 §8).
   - Pertenecer al proyecto no da acceso: hace falta un grant vigente.
5. **El control vive en el recurso, no en el texto.**
   - **Bases de datos:** la lectura se garantiza con un rol de sólo lectura (la
     credencial de `agent_ro` es otra referencia), `SET TRANSACTION READ ONLY`,
     `statement_timeout` y tope de filas. Revisar el SQL es una ayuda, no la
     garantía.
   - **SSH:** la garantía es un usuario restringido o un comando forzado en el
     servidor. La lista de comandos de Keel es una capa más.
   - **Terraform:** `apply` sólo ejecuta el archivo de plan aprobado. El plan se
     guarda como artefacto y la aprobación se ata a su hash; si el plan cambia,
     la aprobación caduca.
   - Keel documenta, por conexión, qué garantía tiene en el servidor y cuál sólo
     en Keel. La UI lo muestra.
6. **Todo queda como evidencia.** Cada operación emite su evento semántico con
   cobertura `instrumented` (ADR-0011). El resultado se guarda como evidencia
   con su procedencia (ADR-0012): conexión, rol, hash de la consulta y sus
   parámetros, duración y, si la fuente lo da, id de transacción. Las
   aprobaciones usan `approval_requests` con el hash de la operación exacta.
7. **Alcance de esta versión.** Conexiones locales al host del daemon (o por un
   túnel que el humano ya tenga). La red remota y los secretos rotativos de
   Vault quedan para cuando haya un caso real.

## Criterios de aceptación

- Ningún evento, artefacto, log ni resultado MCP contiene el valor de un
  secreto: hay una prueba con un secreto centinela.
- `query.write` contra una conexión de lectura falla en la base, aunque el SQL
  engañe a la revisión textual.
- Un `apply` con un plan distinto del aprobado se rechaza.
- Sin grant vigente, la operación termina en la bandeja de aprobaciones o se
  deniega, según la política.

## Consecuencias

- `connections` gana `environment` y `guarantees_json`. `permission_grants` gana
  `operation`.
- El intermediario es un módulo del daemon. Se empaqueta cuando aparezca otro
  consumidor (ADR-0007 §3).
- Cada tipo de conexión es una integración con sus esquemas semánticos
  (ADR-0014). Las primeras son PostgreSQL y SSH.

## Alternativas consideradas

- **Dar la credencial al agente** por entorno o configuración. El agente puede
  leerla, filtrarla o usarla fuera de toda política.
- **Un servidor MCP por base, con la credencial en su configuración.** La
  credencial queda en la línea de comandos y no hay una política común.
- **Confiar en revisar el texto de la consulta o del comando.** Se evade con
  facilidad. Queda sólo como ayuda.
- **Que Keel sea su propio vault.** Duplica lo que el sistema operativo y los
  gestores de secretos ya hacen mejor.
