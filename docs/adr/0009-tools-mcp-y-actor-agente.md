# ADR-0009: Acceso de agentes a Keel por MCP e identidad de ejecución

- **Estado:** Aceptado (por el humano, 2026-10-22)
- **Fecha:** 2026-10-23
- **Criticidad:** Máxima
- **Relacionados:** ADR-0005 §7 (identidad desde la conexión), ADR-0007 §6
  (tools como servidor MCP), ADR-0008 §4 (sandbox de Codex), ADR-0010 (tools de
  `@keel/git`), `LIFECYCLE_EDGES` de `@keel/core` (autoridad por arista), SDD 01
  §3 («cierre humano»), SDD 02 §2

## Contexto

ADR-0007 decidió que las tools de Keel para agentes (crear tareas, reportar
progreso, pedir un handoff, lanzar agentes) sean un servidor MCP, para que las
use cualquier harness. Falta decidir cómo se identifica un agente ante el
daemon, qué puede pedir y qué pasa con los agentes que Keel no lanzó (un Claude
Code abierto a mano en el repo).

Hechos que condicionan todo:

- El agente corre como el mismo usuario del sistema que el humano. El socket del
  daemon es `0600` o hereda la ACL del perfil (ADR-0005 §1). Eso deja fuera a
  otros usuarios, pero no distingue a un humano de un agente del mismo usuario.
- ADR-0005 §7 toma la identidad de la conexión: hoy toda conexión local es
  humana. Un puente MCP que se conecte sin más heredaría autoridad humana.
- La configuración MCP que recibe el proveedor viaja en su línea de comandos o
  en su entorno, visibles para cualquier proceso del mismo usuario
  (`/proc/<pid>/cmdline`). Un secreto puesto ahí lo puede leer el propio agente
  con su shell.

La investigación del humano propone separar cuatro temas: acceso por MCP,
observabilidad, extensiones y acceso a recursos. Este ADR decide sólo el
primero: identidad, autoridad y acceso. Los otros quedan como ADRs aparte
(Consecuencias).

## Decisión

1. **`keel mcp`, un puente stdio.** Habla MCP con el agente y el protocolo de
   ADR-0005 con el daemon. Sus tools son adaptadores de los mismos comandos de
   dominio que usan la CLI, la TUI y la GUI (`command.ts`), sin lógica propia.
   La validación, la idempotencia y la transacción siguen en el daemon. En los
   runs de Keel, el daemon lo inyecta en la configuración MCP del proveedor.
2. **El puente nunca actúa como humano.** Su conexión empieza con
   `session.bind_agent` (run de Keel) o `session.pair` (sesión externa). Hasta
   vincularse, el daemon sólo le responde esos métodos y `daemon.health`. Una
   conexión vinculada es del actor `agent` (`Actor.kind` gana `agent`) y lo
   sigue siendo hasta que se cierra.
3. **Runs de Keel: una capacidad de un solo uso.** Al despachar un run, el
   daemon emite un token aleatorio ligado a
   `{run_id, project_id, work_item_id, scopes, expires_at}` y guarda sólo su
   hash.
   - **Entrega:** un archivo `0600` en el directorio de estado privado del run.
     La configuración MCP lleva sólo la ruta (`KEEL_RUN_TOKEN_FILE`), nunca el
     valor. El puente lo lee, lo borra y se vincula.
   - **Un solo uso:** una segunda presentación se rechaza. El proveedor arranca
     sus servidores MCP antes del primer turno (el `init` del SDK lista su
     estado), así que el puente se vincula antes de que el agente pueda correr
     una herramienta. Ese orden se comprueba con una prueba, no se supone.
   - **Falla cerrado:** si el puente no se vincula o pierde la conexión, el run
     sigue sin las tools de Keel y se emite un evento. Nunca cae a la identidad
     humana ni se vuelve a vincular con el mismo token.
   - El token caduca al terminar el run y se redacta como cualquier `*_TOKEN`.
4. **Sesiones externas** (Claude Code, Codex u otro harness abierto fuera de
   Keel).
   - `keel mcp` sin token pide `session.pair` con lo que puede declarar: `cwd` y
     nombre del cliente. El daemon crea una solicitud de emparejamiento en el
     inbox de aprobaciones.
   - El humano la aprueba eligiendo proyecto, tarea opcional y scopes. Desde ahí
     la conexión es el actor `agent:ext:<session_id>`, nunca la identidad de un
     run.
   - El vínculo dura lo que dura el proceso del puente. Reconectar exige un
     emparejamiento nuevo.
   - La «tarea actual» sale siempre de un vínculo explícito (el run o el
     emparejamiento), nunca de suponer que hay una sola tarea activa.
5. **Autoridad comprobada en cada operación.** El daemon evalúa actor, scopes de
   la capacidad, recurso y autoridad del ciclo de vida. Que el proyecto o la
   tarea pertenezcan a la capacidad se comprueba siempre: conocer un id no
   autoriza nada.
   - **Puede:** leer las tareas del proyecto vinculado; crear tareas
     (`source = 'agent'`, nacen en `triage`); añadir notas y progreso a su
     tarea; pedir un handoff (nota más tarea en `triage` con el vínculo al
     origen).
   - **Pide, no hace:** `runs.request` crea una solicitud de run que el
     scheduler o el humano aprueban (Fase 2). Lo mismo para cualquier operación
     de más autoridad.
   - **No puede:** transiciones con autoridad `human` o `human_close`; resolver
     aprobaciones, tampoco las suyas; cambiar límites, presupuesto o permisos;
     concederse scopes; arrancar runs.
   - Se aplica en la misma unidad de trabajo que el resto, con recibos de
     idempotencia por actor.
6. **Recursos fuera de alcance.** Pertenecer a un proyecto no da acceso a SSH,
   bases de datos, infraestructura ni secretos. Esas operaciones irán por un
   intermediario con permisos por operación (ADR aparte). Las credenciales no
   llegan al modelo ni a los resultados MCP.
7. **Trazabilidad.** Cada mutación de un agente emite su evento con `actor` y
   correlación (run, tarea, sesión), y la UI distingue «creado por agente» de lo
   humano. Lo que el agente hace fuera de las tools de Keel (shell u otros
   servidores MCP) no se presenta como observado, salvo con instrumentación
   explícita (ADR de observabilidad).
8. **Lo que este ADR no promete.** La frontera de autoridad se sostiene para
   quien usa las tools de Keel. Un agente con shell sin restricción puede
   conectarse al socket como el usuario y el daemon lo verá como humano.
   Mitigaciones, en orden:
   - El gate de herramientas: `Bash` no está auto-aprobado (perfil por defecto)
     y su comando se ve antes de aprobarlo.
   - El sandbox de Codex (ADR-0008 §4), medido por plataforma.
   - Una regla en `canUseTool` que deniega comandos que nombran el endpoint del
     daemon. Es una capa más, no una frontera: la inspección de texto se evade.
   - A evaluar con medida: las credenciales del par del socket (`SO_PEERCRED` en
     Linux) para tratar como agente una conexión que viene del árbol de procesos
     de un run.
   - Futuro, si el modelo de amenazas lo exige: un endpoint aparte para agentes
     con su propia ACL, o un usuario del sistema por agente.

## Criterios de aceptación

- Un agente de un run lee y actualiza su tarea, y no puede tocar otro proyecto.
- La segunda presentación de un token y un token de un run terminado se
  rechazan.
- El puente sin token ni emparejamiento no puede mutar nada ni obtiene un actor
  humano.
- Una sesión externa no puede asumir la identidad de un run.
- Las transiciones con autoridad humana se rechazan para el actor `agent`.
- Las mutaciones de agentes son idempotentes y emiten eventos con su actor.
- El valor del token no aparece en la línea de comandos ni en el entorno del
  proveedor, ni en eventos o logs.
- Una prueba documenta el límite conocido: una conexión directa al socket desde
  el shell del agente sigue siendo posible.

## Consecuencias

- Protocolo (ADR-0005 §5, por nota en el SDD con esquema Zod): métodos nuevos
  `session.bind_agent`, `session.pair`, `notes.add`, `work_items.list`,
  `work_items.get`, `handoffs.request` y `runs.request`. `Actor.kind` gana
  `agent`. El emparejamiento entra al inbox de aprobaciones.
- `keel mcp` es otro consumidor del protocolo y justifica extraer `@keel/ipc`
  (ADR-0007 §3).
- Las tools de `@keel/git` para agentes (ADR-0010) se publican por este mismo
  puente.
- ADRs que la investigación separa de este y quedan por redactar, en este orden:
  1. **Observabilidad, eventos y evidencias.** Evento original frente a evento
     semántico, artefactos fuera del evento (incluye el store para cargas de más
     de 256 KiB), cobertura declarada, interoperabilidad con OpenTelemetry y
     `keel mcp proxy` para instrumentar otros servidores MCP.
  2. **Intermediario de recursos.** Secretos, SSH, bases de datos e IaC con
     permisos por operación.
  3. **Extensiones y visualizadores.** Manifiesto, permisos, aislamiento de
     plugins y MCP Apps.

## Alternativas consideradas

- **Registro de tools propio de Keel.** Sólo lo usaría Keel (ADR-0007).
- **Identidad sólo por la conexión.** No distingue agente de humano en el mismo
  usuario.
- **Tratar al puente sin token como cualquier cliente local.** Es lo que pasaría
  hoy por ADR-0005 §7: le daría autoridad humana a cualquier agente externo.
- **Token en una variable de entorno** (primera versión de este ADR). Queda
  visible en la línea de comandos o el entorno del proveedor y se puede
  reutilizar. Lo reemplaza el archivo de un solo uso.
- **Un usuario del sistema por agente.** Es la separación más fuerte, pero hace
  falta root para crear usuarios y rompe el acceso a los archivos del proyecto.
  Se reabre si el modelo de amenazas lo exige.
