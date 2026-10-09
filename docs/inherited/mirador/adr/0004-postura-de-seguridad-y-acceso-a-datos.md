# ADR-004: Postura de seguridad, acceso a datos y gates de permiso

- **Estado:** Aceptado
- **Fecha:** 2026-08-20
- **Relacionados:** ADR-003 (estados de tool call), ADR del proxy MCP

## Contexto

El objetivo declarado del proyecto incluye darle al agente poder de ejecución sobre bases
de datos reales. Eso convierte a esta herramienta en parte de la superficie de ataque de
esas bases. Además, el store va a contener result sets completos de queries —
potencialmente datos personales de producción — en una máquina de desarrollo.

Escribir esto como ADR obliga a decidirlo antes de que la primera integración cómoda con
credenciales de superusuario se vuelva permanente.

## Decisión

### 1. Menor privilegio por default, a nivel de base de datos

Dos roles de Postgres distintos, no uno con lógica de aplicación encima:

- `agent_ro`: `SELECT` únicamente, `statement_timeout` agresivo, sin acceso a tablas de
  credenciales/auditoría. Es el que usa el agente **siempre**, por default.
- `agent_rw`: privilegios de escritura acotados por schema. Se usa **sólo** dentro de una
  sesión elevada y explícitamente aprobada.

El aislamiento vive en la base, no en nuestro código. Un bug nuestro no debe poder
convertirse en un `DROP`.

### 2. El tenant lo impone el proxy, no el agente

Donde haya RLS o multi-tenancy, el `SET` del tenant lo ejecuta el proxy MCP al abrir la
conexión, tomándolo de la configuración de la corrida. **No se confía en que el agente lo
incluya en su SQL.** Un agente que olvida el filtro de tenant no debe poder ver de más.

### 3. El gate de permisos es informado, y con política de falla explícita

El valor sobre el prompt del CLI es que la aprobación llega con contexto: el SQL parseado,
el plan de ejecución, la estimación de filas afectadas y qué tablas toca.

Restricción operativa dura: **el timeout default de los hooks es de 60 segundos.** Un gate
que espera a que la persona regrese a la computadora simplemente truena. Por eso:

- **Default: `deny-on-timeout`.** Si nadie resuelve en la ventana, se deniega, se registra
  y el agente recibe un mensaje accionable en stderr para que reintente o pida de otro
  modo. Fallar cerrado.
- El modo `async: true` (hook en background que no bloquea) **no es un gate**, es una
  notificación. Es válido para observabilidad, y está prohibido presentarlo en la UI como
  si fuera una aprobación. No son intercambiables.
- La elevación a `agent_rw` es por sesión, con TTL corto (default 15 min) y alcance
  declarado. No hay "aprobar todo por siempre" en la v1.

### 4. Secretos y datos capturados

- Las credenciales de conectores (BD, MCP) **nunca** entran al event store. Van a un store
  de secretos aparte; el envelope guarda referencia, no valor.
- Redacción en el borde de ingesta, antes de escribir: patrones configurables sobre `raw`
  para tokens, `Authorization`, `password`, cadenas de conexión. Es best-effort y hay que
  decirlo así en el README, no venderlo como garantía.
- Los result sets completos que capture el proxy son la parte más sensible del sistema.
  Retención por default corta (7 días), configurable, y borrado por `run_id`. Debe existir
  un modo "no persistir cuerpos de resultado, sólo metadatos" para conectar a producción.

### 5. Bind local por default

El colector escucha en `127.0.0.1` por default. Exponerlo en red requiere flag explícito y
autenticación. Un dashboard que expone tool inputs y result sets no debe volverse
accesible en la red de la oficina por accidente de configuración.

## Consecuencias

**Positivas**
- El caso "el agente rompió algo en la base" queda acotado por privilegios reales.
- `deny-on-timeout` hace que el comportamiento bajo ausencia sea predecible.
- La retención corta por default limita el daño si la máquina se compromete.

**Negativas**
- Fricción real: el flujo de escritura requiere estar presente. Es intencional en v1 y va
  a ser lo primero que alguien quiera relajar.
- La redacción best-effort da falsa sensación de seguridad si se comunica mal.
- Dos roles de BD implica setup de migraciones y documentación que no existiría con uno.

## Alternativas consideradas

- **Un solo rol con validación de SQL en nuestro código** (parsear y rechazar DML).
  Rechazada: el parseo de SQL es evadible y nos vuelve el único punto de defensa.
- **Aprobación persistente por patrón de query.** Postergada. Es la evolución natural del
  gate una vez que haya datos de uso, pero necesita un modelo de reglas que no tenemos.
- **No persistir nada de result sets.** Rechazada como default porque elimina la vista de
  "cuántas filas volvieron vs. cuántas entraron al contexto", que es el diferenciador del
  producto. Se ofrece como modo opcional.
