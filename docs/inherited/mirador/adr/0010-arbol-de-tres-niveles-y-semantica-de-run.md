# ADR-010: Resolución de padres por tres canales, árbol de tres niveles y semántica de run

- **Estado:** Aceptado
- **Fecha:** 2026-08-24
- **Criticidad:** Máxima — hereda la de ADR-008
- **Supersede:** ADR-008, parcialmente — la resolución de padres del modelo de
  árbol (su punto 1 y la parte de `parent_agent_id` en «Lo que ADR-003 acertó»)
  y la semántica de run (su punto 6, herencia de ADR-003). El resto de ADR-008
  sigue vigente.
- **Relacionados:** ADR-002 (nada se descarta), ADR-008 (base del modelo)
- **Evidencia:** 5,766 eventos crudos (31 `SubagentStart`) medidos el
  2026-08-24; los porcentajes de resolución se reproducen sobre los fixtures
  redactados del repo porque la redacción preserva ids y consistencia entre
  campos.

## Contexto

Con la UI navegable, el árbol de ADR-008 resultó no ser árbol: 28 agentes, 28
`parent_pending`. El canal de resolución que ADR-008 declaró («el `PostToolUse`
del tool que lanzó trae el id del hijo») existe en **2 de 31** casos reales. Y
el particionado de runs producía runs de 1–3 eventos administrativos y cortaba
el run grande por un timeout medido contra cualquier evento. Este ADR corrige
ambas cosas con reglas medidas.

## Decisión

### 1. Tres canales de resolución de padre, con precedencia explícita

En orden de precedencia (gana el de número menor) y con su tasa medida:

1. **`agent_transcript_path` del `SubagentStop`.** La ruta
   `…/subagents/workflows/wf_XXX/agent-*.jsonl` enlaza al workflow concreto,
   **sin heurística**. Cubre 22/25 workflow-subagents (88%). Resuelve al momento
   del stop.
2. **`tool_response.agentId` del tool que lanzó** — el canal de ADR-008. Sólo
   2/31. Se conserva **porque es ground truth, no porque cubra**: cuando existe,
   es certeza.
3. **`(session_id, prompt_id)` + orden temporal**: el último `PreToolUse` de
   `Agent` o `Workflow` previo en el mismo turno es el lanzador. 26/31 (84%);
   100% en tipos no-workflow; validado 2/2 contra el canal 2. Es heurística y se
   marca como tal (`parent_source`).

Combinados: **31/31** (25/25 en la ventana de los fixtures). Un canal de mayor
precedencia que llega después **sobrescribe** al de menor; si dos canales
concretos discrepan, gana el de mayor precedencia y **la discrepancia se
registra** en el agente (`parent_discrepancy`), nunca se resuelve en silencio.
`parent_pending` queda reservado para el caso sin ningún canal.

### 2. Árbol de tres niveles con dos clases de nodo

```text
root (agente)
├── workflow wf_XXX (TASK, no agente)      ← background_tasks[].type: 'workflow'
│   ├── subagente hex (agente)               + tool_response.runId / taskId
│   └── subagente hex (agente)
├── subagente hex (agente, lanzado por Agent)
└── teammate / shell / monitor (tasks)
```

El nodo intermedio de los workflow-subagents es el **workflow**: una task
identificada por su `wf_run_id` (de `tool_response.runId`, unida al id corto de
`background_tasks[]` vía `tool_response.taskId`), cuyo padre es el agente que
llamó al tool `Workflow`. **El árbol deja de ser homogéneo**: hay nodos-agente y
nodos-task, con llaves de formato distinto. Implicación para la UI: no puede
asumir que todo nodo expandible tiene tool calls ni `agent_type`; un nodo-task
muestra estado de task (`running/gone/orphan`) y agrupa a sus agentes hijos. Si
un workflow se conoce sólo por el canal 1 (nunca se vio su task en
`background_tasks[]`), el nodo-task se **materializa igualmente** para que el
árbol no tenga huérfanos estructurales.

### 3. Semántica de run

**Actividad real** = `UserPromptSubmit`, `PreToolUse`, `PostToolUse`,
`PostToolUseFailure`, `SubagentStart`, `SubagentStop`, `PermissionRequest`. Todo
lo demás (`InstructionsLoaded`, `ConfigChange`, `Notification`,
`MessageDisplay`, `CwdChanged`, `Stop`, `StopFailure`, compactación, …) es
**administrativo**.

1. **El timeout de inactividad corre sólo sobre actividad real.** Los eventos
   administrativos no reinician el reloj **ni abren run**: se adhieren al run
   abierto o, si no lo hay, al último run de su sesión.
2. **Un run sin actividad no se materializa como run de trabajo**: si su sesión
   nunca tuvo actividad, queda como único run marcado `administrative: true` —
   visible y filtrable, nunca descartado (ADR-002).
3. **`SessionEnd` tardío cierra el run anterior** de la sesión (re-marca
   `session_end`), en vez de abrir un run de un evento.
4. **Timeout default: 60 min** (antes 30).

Medido sobre los crudos: los cortes por gap pasan de 15 a 7; desaparecen los
runs de sólo `ConfigChange`, los `SessionStart` varados y los `SessionEnd` de un
evento.

### Limitación aceptada

**Ninguna regla de inactividad distingue una pausa humana de un fin de
trabajo.** El corte del run grande fue una pausa real de 37 minutos entre
turnos: con 30 min corta, con 60 no, y con cualquier umbral existe la pausa que
lo cruza. Subir el umbral mueve el problema, no lo resuelve. La salida correcta
es que el usuario pueda **unir o dividir runs manualmente en la UI**; queda como
trabajo futuro y no se implementa ahora.

## Anexo: el espacio de agent_type sigue abierto — y ahora hay equipos

Tres `agent_type` de teammate nuevos aparecieron en una semana:
`ing-back-binding`, `ing-admin-binding`, `rev-binding` (además de
`arq-binding`). La regla de ADR-008 §9 (sin enum, sin lista fija) se confirma
sola — y la evidencia ya no es de teammates sueltos sino de **equipos** (un
`team_name` con varios miembros).

## Consecuencias

**Positivas**

- El árbol es árbol: 31/31 padres resueltos con precedencia y proveniencia
  explícitas.
- Los runs se corresponden con unidades de trabajo; el ruido administrativo deja
  de fabricar runs fantasma.
- La proveniencia (`parent_source`) permite a la UI distinguir certeza de
  heurística.

**Negativas**

- El canal 1 resuelve **al stop**: mientras un workflow-subagent corre, su padre
  viene del canal 3 (o pendiente) y puede cambiar al terminar. La UI debe
  tolerar re-parenting.
- Árbol heterogéneo: más complejidad en UI y en cualquier consumidor del
  snapshot.
- La adhesión de administrativos a runs cerrados hace que `event_count` de un
  run pueda crecer después de `ended_at`. Es deliberado: pertenencia ≠ duración.

## Alternativas consideradas

- **Sólo el canal del ADR-008.** Rechazada: 2/31 medido.
- **Sólo la heurística de prompt_id.** Rechazada: 84%, y aplana los workflows
  bajo root.
- **Árbol homogéneo (workflow como pseudo-agente).** Rechazada: fingiría
  `agent_type` y tool calls que no existen; la task ya es la identidad real
  (ADR-008 §1).
- **Umbral de timeout adaptativo por sesión.** Rechazada por ahora: complejidad
  sin datos que la justifiquen; la edición manual de runs es la salida honesta.
