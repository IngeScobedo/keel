# ADR-003: Modelo de correlación (run / session / agent / tool_use)

> **Superseded por [ADR-008](./0008-modelo-de-correlacion-revisado.md)**
> (2026-08-24), escrito con la evidencia de los fixtures de Fase 1 que este ADR
> pedía. El contenido original se conserva sin editar.

- **Estado:** Superseded por ADR-008
- **Fecha:** 2026-08-20
- **Criticidad:** Alta — es la decisión que más caro cuesta cambiar después
- **Relacionados:** ADR-002 (envelope), ADR-004 (gates)

## Contexto

Todas las vistas del producto son la misma relación mirada de distinto ángulo:

- el timeline es los eventos de un `run` ordenados por tiempo,
- el árbol de agentes es la relación `agent_id → parent_agent_id`,
- la traza de una query es los eventos que comparten `tool_use_id`,
- la vista de contexto es "qué salió de un `tool_use_id` y cuánto de eso
  sobrevivió".

Si el modelo de correlación se descubre tarde, no se arregla con una migración:
se reescribe el store, porque los datos históricos ya se ingirieron sin las
llaves.

Los eventos de hook traen `session_id`, `transcript_path`, `cwd`,
`hook_event_name`, y dentro de un subagente traen además `agent_id` /
`agent_type`. Eso es la materia prima, pero no alcanza: `session_id` puede
reaparecer entre resume/compact, y no hay un identificador que ate "todo lo que
pasó desde que escribí el prompt hasta que terminó".

## Decisión

Cuatro llaves, con reglas explícitas de origen y de fallback.

### 1. `run_id` — nuestro, no de Claude Code

Un ULID que **nosotros** generamos. Un `run` es una unidad de trabajo
observable: abre en `SessionStart` o en el primer evento de una sesión no vista,
y cierra en `SessionEnd` o por timeout de inactividad (default 30 min).

Es nuestro por dos razones: sobrevive a los resume (un `session_id` que
reaparece abre un `run` nuevo, ligado al anterior por `previous_run_id`) y
sobrevive a los compact (`PreCompact` / `PostCompact` **no** cierran el run, lo
marcan con un `compaction_seq` incremental, que es lo que después permite
reconstruir qué había en la ventana antes y después — ver ADR de fase 5).

### 2. `session_id` — de la fuente, tal cual

Se copia sin transformar. Es la llave para cruzar con el JSONL de
`~/.claude/projects/<slug>/<session_id>.jsonl`. **No** se usa como llave
primaria de agrupación, porque no es estable frente a resume.

### 3. `agent_id` / `parent_agent_id` — el árbol

- Si el evento trae `agent_id`, se usa.
- Si **no** lo trae, el evento es del agente principal y se le asigna
  `agent_id = 'root:' + run_id`, con `parent_agent_id = null`. Esto es
  importante: la ausencia de `agent_id` es dato, no falta de dato.
- `parent_agent_id` se resuelve por el `SubagentStart` correspondiente. Si llega
  un evento de un `agent_id` para el que aún no vimos su `SubagentStart`
  (llegada fuera de orden), se ingiere con `parent_agent_id = null` y un flag
  `parent_pending`, y se reconcilia después. **Nunca se descarta ni se bloquea
  la ingestión esperando al padre.**

### 4. `tool_use_id` — el par pre/post

Es lo que amarra `PreToolUse` con su `PostToolUse` (o `PostToolUseFailure`), y
lo que amarra ambos con lo que capture el proxy MCP.

Si la fuente lo provee, se usa. Si no, se sintetiza como hash estable de
`(run_id, agent_id, tool_name, JSON canónico de tool_input, ordinal)` — el
ordinal distingue dos llamadas idénticas seguidas. **El proxy MCP debe propagar
este mismo id** (ADR del proxy) o la correlación entre "el agente pidió una
query" y "esta query corrió en la base" se rompe, y con ella la vista que
justifica el proyecto.

### Máquina de estados de un tool call

```
pending  → PreToolUse recibido
blocked  → PermissionRequest / hook devolvió exit 2
running  → permiso resuelto, sin PostToolUse aún
done     → PostToolUse
failed   → PostToolUseFailure
orphan   → sin cierre tras timeout (default 5 min)
```

`orphan` es un estado de primera clase, no un bug. Hay un hueco estructural
conocido en la superficie de subagentes: un subagente puede quedarse colgado
indefinidamente en un gate de permisos MCP sin que la UI del CLI padre indique
nada. **No podemos confiar en `SubagentStop` para saber que un subagente
terminó.** Necesitamos timeout propio, y mostrar `orphan` explícitamente es una
de las cosas que la herramienta aporta.

## Consecuencias

**Positivas**

- Un solo modelo alimenta timeline, árbol, traza de query y vista de contexto.
- La ingestión nunca se bloquea por eventos fuera de orden o incompletos.
- Los estados degradados (`parent_pending`, `orphan`) son visibles, que es justo
  el valor.

**Negativas**

- La síntesis de `tool_use_id` es heurística. Dos llamadas idénticas en paralelo
  dentro del mismo agente pueden colisionar. Se acepta y se marca
  `tool_use_id_synthetic: true` para que la UI no presente esa correlación como
  certeza.
- La reconciliación de `parent_pending` es un job de fondo más que mantener.
- El timeout de `run` es un parámetro arbitrario que va a estar mal para
  alguien.

## Nota de implementación

Estas llaves y sus reglas viven en `@obs/core` como funciones puras con tests
sobre los fixtures capturados en la Fase 1. Son el primer código del proyecto y
el que más tests merece. Ningún adaptador implementa su propia versión de esta
lógica.
