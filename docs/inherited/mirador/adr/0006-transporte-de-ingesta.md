# ADR-006: Transporte de ingesta (hook → colector)

> **Nota (2026-08-24, mediciones de ADR-007):** el presupuesto de 50 ms es la
> métrica equivocada: ningún runtime spawnea un proceso en menos de eso en la
> máquina de referencia (suelo Bun ≈ 37 ms, Node ≈ 56 ms, bridge Fase 1 ≈ 86
> ms), y lo que protege la sesión no es la latencia sino **no bloquear**.
> Propuesta pendiente de su propio ADR: eventos observacionales con
> `async: true` (siguen sin ser gates — ADR-004), presupuesto redefinido como
> **pérdida de eventos** en vez de milisegundos, y gates presupuestados en
> segundos. El spool como fuente de verdad y el exit 0 incondicional no cambian.

- **Estado:** Aceptado
- **Fecha:** 2026-08-20
- **Relacionados:** ADR-002 (envelope), ADR-004 (gates)

## Contexto

Los hooks de Claude Code son procesos que se spawnean, leen JSON de stdin y
contestan por exit code y stdout. **Corren en el camino crítico del agente.** Un
hook lento hace lenta la sesión de la persona; un hook que truena puede bloquear
una tool call.

Esto define una restricción que manda sobre todo lo demás: **la herramienta de
observabilidad no puede degradar la experiencia de la sesión observada.** Si el
colector está caído, la sesión debe correr exactamente igual que sin nosotros.

Un `curl` directo del hook al colector es el spike de la Fase 1, pero no es la
solución: si el colector no responde, `curl` se cuelga hasta su timeout, dentro
del camino crítico.

## Decisión

**Spool local en disco como fuente de verdad de la ingesta; el envío por red es
best-effort y asíncrono.**

### `hook-bridge`

Un binario pequeño (`packages/hook-bridge`) que se registra en `settings.json`
para todos los eventos. Su contrato:

1. Lee stdin completo.
2. Hace `append` de una línea NDJSON al spool:
   `~/.<producto>/spool/<fecha>.ndjson`. Append atómico, `O_APPEND`, una línea
   por evento.
3. Intenta `POST` al colector con timeout **duro de 300 ms**. Si falla o expira,
   no importa: el evento ya está en el spool.
4. Sale con **código 0 siempre**, salvo el caso de gate explícito (abajo).

Presupuesto de latencia total: menos de 50 ms en el caso feliz. Se mide y se
testea.

Un sweeper en el colector lee los spools y reingiere lo que no llegó,
deduplicando por el ULID que genera el bridge. La ingesta es idempotente por
diseño.

### Excepción: el modo gate

El único caso donde el bridge **sí** bloquea es el gate de permisos (ADR-004), y
ahí es intencional: consulta al colector y espera la decisión dentro de la
ventana configurada, que debe quedar por debajo del timeout de hooks (60 s por
default). Si el colector no responde, aplica `deny-on-timeout` con mensaje
accionable en stderr.

Los eventos con gate se declaran explícitamente en la configuración por matcher.
Todo lo demás es no bloqueante. **Un evento nunca se vuelve bloqueante por
accidente.**

### Consecuencia de diseño: el spool es el contrato

Una vez que existe el spool, el colector deja de ser un servicio que "tiene que
estar prendido". Puedes observar sesiones con el dashboard apagado y ver todo
después. Eso también hace trivial el backfill de la Fase 5: el JSONL entra por
el mismo sweeper.

## Consecuencias

**Positivas**

- La sesión observada nunca depende de que nuestro servicio esté vivo.
- Cero pérdida de eventos si el colector se reinicia o se actualiza.
- El spool es un artefacto portable: se puede mandar para debuggear sin acceso a
  la BD.

**Negativas**

- Dos caminos de ingesta (POST directo y sweeper) que hay que mantener
  consistentes. Se mitiga porque ambos terminan en la misma función de ingesta
  idempotente.
- Rotación y limpieza del spool es trabajo operativo adicional.
- Escribir a disco en cada evento tiene costo de I/O. Medido, es despreciable
  frente al presupuesto de 50 ms, pero hay que medirlo, no asumirlo.

## Alternativas consideradas

- **`curl` directo.** Aceptable sólo para el spike de Fase 1. Rechazada para
  producción: acopla el camino crítico del agente a la disponibilidad de nuestro
  servicio.
- **Socket Unix.** Más rápido que HTTP y sin puerto expuesto, pero sigue
  requiriendo que el colector esté vivo, que es el problema real. Considerable
  como optimización _encima_ del spool, no en lugar de él.
- **Sólo tailear los JSONL de `~/.claude/projects/`, sin hooks.** Rechazada:
  cero intrusión, pero llega con lag, no permite gates, y no expone el detalle
  de tool inputs con la fidelidad de los hooks. Se usa como fuente
  complementaria (Fase 5), no primaria.
- **OTel como transporte primario.** Rechazada para v1: excelente para latencia
  y costo, pero los spans no cargan los payloads completos que necesita la vista
  de contexto. Complementaria, no sustituta.
