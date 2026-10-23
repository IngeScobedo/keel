# ADR-0009: Tools de Keel para agentes por MCP y el actor `agent:<run_id>`

- **Estado:** Propuesto
- **Fecha:** 2026-10-23
- **Criticidad:** Máxima
- **Relacionados:** ADR-0005 §7 (identidad desde la conexión), ADR-0007 §6
  (tools como servidor MCP), `LIFECYCLE_EDGES` de `@keel/core` (autoridad por
  arista), SDD 01 §3 («cierre humano»), SDD 02 §2

## Contexto

ADR-0007 decidió que las tools de Keel para agentes (crear tareas y sus
detalles, reportar progreso, pedir un handoff, lanzar agentes) sean un servidor
MCP, para que las use cualquier harness. Falta decidir **cómo se identifica** un
agente ante el daemon y **qué puede pedir**.

Hecho que condiciona todo: el agente corre como el mismo usuario del sistema que
el humano. El socket del daemon es `0600` o hereda la ACL del perfil (ADR-0005
§1). Eso deja fuera a otros usuarios, pero **no distingue a un humano de un
agente del mismo usuario**. Un agente con shell libre podría abrir el socket
directamente.

## Decisión

1. **`keel mcp`, un puente stdio.** Es un proceso que habla MCP con el agente y
   el protocolo de ADR-0005 con el daemon. Lo puede configurar cualquier
   harness: Keel, Claude Code solo, Codex u otros. En los runs de Keel, el
   daemon lo inyecta en la configuración MCP del proveedor.
2. **Identidad por capacidad, no por conexión.** Al despachar un run, el daemon
   emite un token aleatorio de un solo uso, ligado a
   `{run_id, project_id, scopes, expires_at}`, y se lo pasa al puente por el
   entorno (`KEEL_RUN_TOKEN`). El puente lo presenta con un método nuevo,
   `session.bind_agent`, y desde ese momento el daemon trata esa conexión como
   actor `agent:<run_id>` (`kind: "agent"`). El token vive en memoria del
   daemon, caduca al terminar el run y se redacta como cualquier `*_TOKEN`.
3. **Autoridad del actor `agent`.**
   - **Puede:** leer tareas y su detalle; crear tareas (`source = 'agent'`,
     nacen en `triage`); añadir notas y progreso a su tarea; pedir un handoff
     (nota más tarea en `triage` con el vínculo al run de origen).
   - **No puede:** ninguna transición con autoridad `human` ni `human_close`,
     resolver aprobaciones, cambiar límites o presupuesto, ni arrancar runs.
     Lanzar agentes es una petición que el scheduler o el humano confirman (Fase
     2).
   - Lo hace cumplir el daemon en la misma unidad de trabajo que el resto
     (`command.ts`), con recibos de idempotencia por actor.
4. **Trazabilidad.** Cada mutación de un agente emite su evento con `actor`, y
   la UI distingue «creado por agente» de lo humano.
5. **Lo que este ADR no promete.** La frontera de autoridad se sostiene para
   quien usa las tools de Keel. Un run con shell sin restricción puede alcanzar
   el socket como el usuario. Mitigaciones, en orden:
   - El gate de herramientas: `Bash` no está auto-aprobado (perfil por defecto)
     y su comando se ve antes de aprobarlo.
   - El sandbox de Codex `workspace-write` (ADR-0008).
   - Fase 2: regla en `canUseTool` que deniega comandos que nombran el endpoint
     del daemon.
   - Futuro, si hace falta: un endpoint separado para agentes con su propia ACL
     o un usuario del sistema por agente.

## Consecuencias

- Protocolo (ADR-0005 §5, por nota en el SDD con esquema Zod): métodos nuevos
  `session.bind_agent`, `notes.add`, `work_items.list`, `work_items.get` y
  `handoffs.request`; `Actor.kind` gana `agent`.
- Hace falta un paquete o binario `keel mcp`. Como es un consumidor más del
  protocolo, es el segundo consumidor que justifica extraer `@keel/ipc`
  (ADR-0007 §3).
- Las tools de `@keel/git` para agentes (ADR-0010) se publican por este mismo
  puente.

## Alternativas consideradas

- **Registro de tools propio de Keel.** Sólo lo usaría Keel (ADR-0007).
- **Identidad sólo por la conexión.** No distingue agente de humano en el mismo
  usuario.
- **Un usuario del sistema por agente.** Es la separación más fuerte, pero hace
  falta root para crear usuarios y rompe el acceso a los archivos del proyecto.
  Se reabre si el modelo de amenazas lo exige.
