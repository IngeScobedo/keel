# ADR-0017: Contexto para agentes: tarea vinculada, recursos MCP y búsqueda

- **Estado:** Aceptado (2026-10-23)
- **Fecha:** 2026-10-22
- **Criticidad:** Media
- **Relacionados:** ADR-0004 §5 (FTS5 siempre, `sqlite-vec` opcional), ADR-0009
  (vínculo de sesión), ADR-0011 §8 (lo restringido no entra a búsqueda),
  ADR-0016, SDD 02 §4–§5, SDD 04 §3 (riesgo del embedding local)

## Contexto

Un agente lanzado en un workspace, por Keel o abierto a mano, debería poder
preguntar qué tarea tiene, qué contexto hay, qué se investigó antes y qué notas
dejó otro agente. El humano lo llama «contextos y RAG».

El SDD ya define la resolución de contexto (`.keel/project.toml`, `always_read`
y `shared_dirs`) y el Research Hub con FTS5 y vectores de 384 dimensiones. El
embedder local todavía no se evalúa: SDD 04 lo lista como riesgo (licencia,
tamaño, calidad en español e inglés, latencia).

## Decisión

1. **El contexto se pide, no se empuja.** El prompt de un run de Keel lleva sólo
   un encabezado corto: tarea, id y vínculos. El resto lo pide el agente por el
   puente de ADR-0009, con estos recursos MCP:
   - `keel://task/current`, resuelto desde el vínculo del run o del
     emparejamiento. Nunca se supone que hay una sola tarea activa.
   - `keel://task/<id>`, con descripción, notas, dependencias, evidencia y
     estado.
   - `keel://project/context`, con los documentos de `always_read` y la lista de
     ADRs.
   - `keel://research/<id>`.
2. **Búsqueda con `context.search(query, scope)`.**
   - FTS5 sobre tareas, notas, investigaciones y metadatos de evidencia,
     siempre.
   - Vectores sólo cuando el embedder esté evaluado (SDD 04) y `sqlite-vec`
     cargado. Entonces se fusionan rankings como en SDD 02 §5.
   - La respuesta dice el modo (`lexical` o `hybrid`) para que nadie suponga
     búsqueda semántica sin ella.
3. **Permisos antes de rankear.** Se filtra por proyecto vinculado y scopes (SDD
   02 §5, paso 2). Lo `restricted` no se indexa ni se devuelve, salvo que el
   vínculo lo conceda explícitamente.
4. **Respuestas acotadas.** Los resultados traen fragmentos y referencias
   (`artifact:`, `keel://`), no documentos enteros. El agente pide el detalle
   que necesita. Así un contexto grande no se come la ventana del modelo.
5. **Sin almacén de memoria aparte.** La continuidad entre agentes y sesiones
   son las notas, los handoffs (ADR-0009), las investigaciones (ADR-0016) y los
   documentos versionados del repo. Son las tres capas de memoria de SDD 02 §7.

## Criterios de aceptación

- Un agente externo emparejado obtiene su tarea por `keel://task/current`, y uno
  sin vínculo no obtiene ninguna.
- `context.search` sin `sqlite-vec` responde en modo `lexical` y lo dice.
- Un resultado `restricted` no aparece aunque coincida el texto.

## Consecuencias

- El índice FTS se amplía de investigaciones a tareas, notas y evidencia.
- La evaluación del embedder sigue siendo condición para el modo híbrido.
- Los recursos MCP son contrato público y se versionan con el puente.

## Alternativas consideradas

- **Meter todo el contexto en el prompt.** Caro, desactualizado al momento y sin
  control de permisos por pedido.
- **Embeddings ya, sin evaluar.** Contradice «medir, no asumir» y el riesgo
  abierto del SDD 04.
- **Una base vectorial externa.** ADR-0004 decide SQLite local con `sqlite-vec`.
