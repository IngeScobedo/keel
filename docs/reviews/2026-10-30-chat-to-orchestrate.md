# Chat to Orchestrate: validación del research, del canvas y cómo entra en Keel

- **Fecha:** 2026-10-30
- **Fuentes revisadas:**
  - `docs/sdd/05-chat-to-orchestrate.md` (research del 2026-10-29).
  - Canvas de pen.dev: `page/20 Chat to Orchestrate · Components` (`an7eX`) y
    los 20 frames `CTO / 01…10 / Dark|Light`.
- **ADRs propuestos a partir de esta revisión:** 0035 a 0041, todos en
  Propuesto.

## 1. La idea en una línea, contra lo que Keel ya es

El research pide que la conversación sea la entrada y que el grafo de trabajo
sea la verdad. Keel ya tiene casi todas las piezas de ese grafo, pero las
arranca a mano:

| Concepto del research   | Lo que ya existe en Keel                                                        | Lo que falta                                                        |
| ----------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Thread                  | La conversación del proyecto (ADR-0024): tarea oculta, runs de sólo lectura     | Varias conversaciones por proyecto; que de un mensaje nazca un lote |
| Lote (batch)            | Una tarea padre con rama de feature y subtareas (ADR-0022)                      | Que nazca de un mensaje y no de un documento `tasks` del diseño     |
| Intent                  | Una línea del documento `tasks` (`PlannedTask`: clave, fase, frontera, `after`) | Clase, orden, check de listo y procedencia                          |
| Check de "listo"        | La validación del brief: Problema, Alcance y Criterios de aceptación (ADR-0021) | Aplicarla por intent, no por tarea                                  |
| Tarjeta de plan         | El gate (b) con el árbol de la feature (ADR-0022, `FeatureTree`)                | Editar, unir, partir y diferir antes de aprobar                     |
| Pregunta                | La pregunta del agente (ADR-0020 §7) y el grilling del brief                    | Preguntas que nacen del razonador, sin run                          |
| Decisión                | —                                                                               | Todo                                                                |
| Supuesto                | —                                                                               | Todo                                                                |
| Invariante              | `invariants` del perfil del proyecto (ADR-0021 §5): sólo patrones               | Reglas con texto, alcance, procedencia y su test                    |
| Gate                    | `verify` del perfil, delta-verde, QA y su veredicto (ADR-0021, ADR-0029)        | El gate como objeto, diferido al cierre, waiver con decisión        |
| Cierre de lote          | La revisión del padre cuando todas las subtareas se integran (ADR-0022 §4)      | Supuestos bloqueantes, changelog y reporte del lote                 |
| Carril y lease          | Fronteras de archivos disjuntas por subtarea (ADR-0022), worktree por run       | Paralelo de verdad (hoy `max_concurrent_runs: 1`) y handoff         |
| Fuente y procedencia    | Contexto y búsqueda (ADR-0017), evidencia con procedencia (ADR-0012)            | Pasajes con id, citas y el visor                                    |
| Artifact embebido       | El navegador en vivo (ADR-0030, Propuesto)                                      | Comentarios que vuelven como decisiones                             |
| Veredicto de research   | Investigaciones y reportes con evidencia (ADR-0016)                             | Que un veredicto proponga una decisión                              |
| Entrega                 | Plan de git aprobado (ADR-0015), despliegue con Ansible (ADR-0031)              | Changelog desde tareas y decisiones                                 |
| Bandeja "Te toca a ti"  | «Te necesita» de todos los proyectos y avisos accionables (ADR-0034 §6)         | Decisiones, supuestos y planes; orden por trabajo que desbloquea    |
| Peek, panel, maximizado | Detalle encima, panel de contexto y pila de lugares (ADR-0034 §4 y §5)          | El popover anclado a la tarjeta; el composer que no desaparece      |
| Replay del lote         | El log de eventos (ADR-0004, ADR-0011)                                          | La vista                                                            |

**Conclusión:** la integración orgánica no crea un modo aparte. El lote **es**
una feature de ADR-0022 que nace de un mensaje. Sus subtareas recorren el método
de ADR-0021 con la ceremonia que pide su clase. La conversación de ADR-0024 pasa
a ser la entrada principal y la vista de tarea de ADR-0034 es el panel de foco.
Lo realmente nuevo son tres objetos (decisión, supuesto, invariante con
contenido), el razonador de intake y el gate como objeto. Eso es lo que llevan
los ADRs 0035 a 0041.

## 2. Estados: sin vocabulario nuevo

El diagrama del research agrega `draft`, `shaping`, `task_gates`, `batch_close`,
`merged`, `deploying` y `delivered`. El mismo research pide no agregar colores
(ADR-0006). La propuesta es mapearlos, no agregarlos:

| Estado del research                | En Keel                                                                     |
| ---------------------------------- | --------------------------------------------------------------------------- |
| `draft`, `shaping`                 | `triage` con la etapa `brief`; el check de listo es la validación del brief |
| `ready`                            | `planned`                                                                   |
| `planning`                         | Run con `purpose = plan` vivo (visual `planning`)                           |
| `running`, `waiting_human`         | Igual                                                                       |
| `needs_review`, `task_gates`       | `running` en la etapa `review`; `needs_review` al terminar                  |
| `done`                             | `done`                                                                      |
| `batch_close`                      | La tarea padre en `review`/`close` (ADR-0022 §4)                            |
| `merged`, `deploying`, `delivered` | Eventos del plan de git y del despliegue, no estados de la tarea            |

## 3. El canvas

Los frames están bien resueltos: densidad de herramienta, atajos visibles,
estados con forma y texto, y el caso de Casa Matte de punta a punta. Usan los
tokens del tema neutro (639 rellenos por variable contra 22 literales). Lo que
hay que corregir antes de implementarlos:

### Reglas que el diseño rompe

1. **USD sin `cost_kind` (ADR-0002, regla 4).** La barra de estado de los 20
   frames dice `Session · $0.84`. Debe decir si es estimado u observado:
   `$0.84 estimado`.
2. **Carriles en paralelo sin decir que es una decisión tuya (ADR-0002, regla
   5).** El frame 04 muestra dos agentes y un carril inline a la vez. Hoy
   `max_concurrent_runs` es 1 y ADR-0022 hace una subtarea a la vez. El frame
   debe mostrar el límite («3 carriles · límite 3, lo subiste tú») o el carril
   que espera lugar.
3. **El carril "inline" no tiene dueño en Keel.** La conversación corre en sólo
   lectura (ADR-0024) y toda edición pasa por un run con worktree y gate
   (ADR-0018). "Inline" debe ser una subtarea de ceremonia directa en el carril,
   no el orquestador editando.

### Datos del ejemplo que no cuadran con Keel

4. **Ids.** El frame usa `B-024`, `T-2` y `refs/keel/run-84/a`. En Keel, el lote
   sería la tarea padre (`KEEL-24`), las subtareas tienen clave `T2` (ADR-0022)
   y el worktree vive en la rama `keel/KEEL-n/<run>/root`.
5. **Los tres carriles del frame 04 repiten la misma ref (`refs/keel/run-84/a`)
   y el mismo «2 of 4 steps».** Es copia del primero.
6. **Gates.** Las seis celdas del frame 09 usan el mismo atajo `G`. Con varias
   tarjetas en pantalla, `A` también se repite (ratificar decisión y revisar
   supuesto). Hace falta un mapa de atajos por foco: el atajo vale en la tarjeta
   enfocada.
7. **"Waived" en violeta.** El violeta es la familia de `planning` en ADR-0006.
   Una dispensa no es planear; mejor neutro con su forma propia (el rombo ya la
   distingue).
8. **Tres literales del acento (`#3B6FBF`)** en vez de `$color/accent/default`.
   Los 19 restantes son la paleta de la tienda dentro del artifact: ahí sí son
   contenido.

### Decisiones abiertas que el canvas da por hechas

9. **Idioma de la UI.** El research dice que la UI arranca en inglés con claves
   i18n. Hoy la GUI mezcla español e inglés y no tiene librería de i18n. Eso es
   una dependencia y un cambio en todas las vistas: necesita su propio ADR antes
   de implementar.
10. **Varias conversaciones por proyecto.** El rail del frame sugiere threads;
    ADR-0024 tiene una sola conversación por proyecto. ADR-0035 lo abre.

## 4. El research

Es consistente y aterrizado en el caso. Ajustes:

- **Nombre del archivo.** El prompt 2 dice `docs/sdd/chat-to-orchestrate.md`; el
  archivo está en `docs/sdd/05-chat-to-orchestrate.md`.
- **El razonador necesita los mensajes reales.** El prompt 2 pide usar los
  mensajes del caso como fixtures, pero el documento sólo trae su resumen (tabla
  de §El caso real). Sin los textos literales no hay forma de medir la
  segmentación y la clasificación.
- **Estados nuevos** (§2 de esta revisión): mapear, no agregar.
- **Fuera de alcance de Keel hoy:** CodeRabbit en el paso 7 del cierre de lote.

## 5. Cómo se ve integrado en la GUI

Sin pantalla nueva en el riel: la **Conversación** (primer ítem del riel) pasa a
ser el hilo con el orquestador, con el layout de los frames:

```text
┌──┬───────────────┬──────────────────────────────────┬──────────────────┐
│R │ Hilo (angosto)│ Foco: plan · bandeja · tarea ·    │ Lote en vivo     │
│  │ tarjetas      │ fuente · artifact · cierre ·      │ (carriles, gates,│
│  │ [composer]    │ replay                            │  supuestos)      │
└──┴───────────────┴──────────────────────────────────┴──────────────────┘
```

- **El foco reusa lo que ya está:** la tarea abre `TaskFocus` (ADR-0034 §5) como
  panel; el plan reusa el árbol de la feature; la bandeja es «Te necesita» con
  pestañas.
- **El lote en vivo es lo que ya muestra la columna de trabajo de una feature:**
  carriles de subtareas (te espera, trabajando, en cola, integradas), más gates
  y supuestos.
- **Cada apertura es un lugar de la pila (ADR-0034 §4):** «atrás» regresa del
  foco al hilo, y el composer sigue a la vista con su destino («al orquestador»
  o «a T6»).
- **Desde el tablero nada cambia:** la tarjeta del lote es la de la feature, con
  su avance.

## 6. Corte de la Fase 1 (propuesta)

El mismo del research, dicho en piezas de Keel:

1. **`@keel/core/intake`:** el razonador determinista (segmentar, anclar,
   clasificar, ordenar, check de listo, perfil de calidad), con tests de tabla
   sobre los mensajes reales del caso.
2. **Daemon:** `conversation.ask` corre el razonador. Si hay intents
   ejecutables, nace el lote: una tarea padre con rama de feature y un gate de
   plan con los intents.
3. **GUI:** la tarjeta de plan en el hilo, con editar, unir, partir y diferir, y
   «Arrancar los listos».
4. **Aprobar el plan crea las subtareas** con el mecanismo de ADR-0022. La
   ceremonia sale de la clase: directa para `copy`, `ui-change` y `bugfix`;
   formal para `design-proposal`.
5. **Un carril:** una subtarea a la vez (el límite actual).
6. **Cierre de lote:** los gates diferidos son la verificación del padre
   (typecheck, lint y tests del perfil), más el changelog generado desde tareas
   e intents.

Queda fuera: decisiones, supuestos, invariantes, fuentes, artifacts, research,
Drive, deploy y carriles en paralelo.

## 7. Preguntas para el humano

Las cinco del research siguen abiertas. Además:

1. ¿Me pasas los mensajes literales de la sesión de Casa Matte (los 3 de Alan)
   para usarlos como fixtures del razonador?
2. ¿La UI cambia a inglés con i18n ahora (ADR aparte), o el orquestador nace en
   el idioma actual y el cambio de idioma va después?
3. ¿Corrijo en el canvas los puntos 1, 4, 5, 7 y 8 de §3, o prefieres hacerlo
   tú?
