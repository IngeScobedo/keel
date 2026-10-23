# ADR-0012: Artefactos, evidencias y retención

- **Estado:** Propuesto
- **Fecha:** 2026-10-22
- **Criticidad:** Alta
- **Relacionados:** ADR-0004 §3 y §6 (umbral de 256 KiB, retención explícita),
  ADR-0005 §2 (frames de 8 MiB), ADR-0011, ADR-0013, ADR-0016, SDD 03 §5

## Contexto

Un resultado SQL de miles de filas, una captura de Playwright, un diff o un
reporte no caben en un evento ni deben repetirse en cada uno. ADR-0004 §3 pide
que lo que pase de 256 KiB vaya como artefacto con hash, tamaño y vista previa.
Hoy `payload.ts` produce la vista previa, pero `body_ref` apunta al propio
evento (`event:<id>#/...`): no existe un almacén de artefactos.

La tabla `evidence` existe (`kind`, `artifact_ref`, `sha256`, `metadata_json`),
pero exige `run_id`, así que el humano no puede adjuntar evidencia propia. Queda
pendiente qué pasa con un cursor de suscripción cuando se borran eventos viejos.

## Decisión

1. **Almacén direccionado por contenido.** Los bytes viven fuera de SQLite, en
   `$XDG_STATE_HOME/keel/artifacts/sha256/<2>/<62>` (en Windows bajo
   `%LOCALAPPDATA%\keel`). Son inmutables y se escriben a un temporal y luego se
   renombran. La tabla `artifacts` guarda `sha256`, `size`, `media_type`,
   `sensitivity` y fecha. El mismo contenido se guarda una sola vez.
2. **Referencias estables.** Un evento, una evidencia o un reporte apuntan con
   `artifact:sha256:<hex>`. Un payload de más de 256 KiB se guarda como
   artefacto y el evento conserva la vista previa de `payload.ts`, con
   `body_ref` hacia el artefacto. Así se cumple ADR-0004 §3.
3. **Evidencia = artefacto + vínculo + procedencia.**
   - **Vínculo:** tarea, run o cambio, uno o varios.
   - **Tipo:** `sql_result`, `screenshot`, `diff`, `test_report`, `chart`,
     `document`, `log`.
   - **Procedencia:** actor, eventos de origen, herramienta o conexión, momento
     de captura y hash de la entrada (por ejemplo, consulta más parámetros).
     Cuando la fuente lo da, también el id de transacción o el snapshot.
   - **Append-only:** una corrección es otra evidencia que apunta a la que
     reemplaza.
   - **Autores:** `run_id` pasa a ser opcional para que el humano adjunte la
     suya.
4. **Datos tabulares con forma propia.** Un resultado de tabla se guarda como
   `application/vnd.keel.table+json`: columnas con tipo, filas,
   `row_count_total` y `truncated`. La captura tiene un tope configurable. Si se
   corta, se marca: nunca en silencio.
5. **Gráficas como especificación más datos.** Una gráfica es una especificación
   Vega-Lite que referencia el artefacto de datos. Para exportar, se guarda
   además el render (SVG o PNG) como otro artefacto. El visualizador nunca es
   dueño de los datos: si desaparece, los datos siguen.
6. **Integridad.** El hash se verifica al leer y al restaurar un respaldo. Un
   artefacto que no coincide se marca y no se muestra como válido.
7. **Retención explícita** (ADR-0004 §6).
   - Nada se borra solo. Purgar es un comando del humano por proyecto,
     antigüedad o tipo.
   - La evidencia vinculada a una tarea se conserva salvo que la purga la
     nombre.
   - Los artefactos sin referencias se recolectan después de la purga.
8. **`cursor_expired`.** Si una suscripción pide un cursor más viejo que el
   evento más antiguo que queda, el daemon responde el error `cursor_expired`
   con el cursor mínimo disponible, y el cliente se resincroniza desde un
   snapshot. Nunca se entrega una historia con huecos como si fuera completa.
9. **Lectura por partes.** Como los frames son de 8 MiB como máximo (ADR-0005
   §2), `artifacts.read` entrega por rango (`offset` y `length`) y el cliente
   verifica el hash al final.

## Criterios de aceptación

- Un payload de 1 MiB queda como artefacto; el evento tiene vista previa válida
  y el hash coincide.
- Guardar dos veces el mismo contenido deja un solo archivo.
- Un respaldo restaurado verifica todos los hashes.
- Un cursor anterior a una purga recibe `cursor_expired` con el mínimo.

## Consecuencias

- Migración: tabla `artifacts`; `evidence` gana `work_item_id`, `run_id`
  opcional, `supersedes_id` y `provenance_json`.
- `backup.ts` incluye el directorio de artefactos en el manifiesto con sus
  hashes.
- Protocolo: `artifacts.read`, `evidence.attach` (también como tool de agente
  por ADR-0009, que copia un archivo del worktree al almacén) y el código de
  error `cursor_expired`.

## Alternativas consideradas

- **Blobs dentro de SQLite.** Hace crecer la base y vuelve lentos los respaldos
  y el `VACUUM INTO`.
- **Almacenamiento de objetos externo.** Keel es local primero; el almacén puede
  cambiar de backend detrás de la misma referencia.
- **Truncar los resultados grandes.** Viola ADR-0004 §3 y destruye evidencia.
