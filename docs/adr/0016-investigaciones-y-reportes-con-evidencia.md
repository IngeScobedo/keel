# ADR-0016: Investigaciones y reportes con evidencia

- **Estado:** Propuesto
- **Fecha:** 2026-10-22
- **Criticidad:** Alta
- **Relacionados:** ADR-0006 (estados), ADR-0009 (actor agente), ADR-0011,
  ADR-0012 (evidencia y gráficas), ADR-0013 (sensibilidad de producción), SDD 01
  §3 («cierre humano»), SDD 02 §5 (Shared Research Hub)

## Contexto

El caso que motiva esto es una auditoría: faltaban 30 mil pesos y se le pidió a
Claude que buscara pistas. Salen dos productos distintos:

- La sesión observada en vivo: consultas, resultados e hipótesis (ADR-0011).
- Un documento que se conserva y se comparte, con las mismas gráficas, y donde
  cada afirmación apunta a su evidencia.

Convertir el chat en Markdown no da lo segundo. Un análisis de IA no prueba por
sí mismo que faltó dinero ni quién fue responsable, así que el documento debe
separar hechos verificados, observaciones e hipótesis.

El esquema ya tiene `work_items.kind = 'research'` y el Shared Research Hub
(`shared_researches`, FTS5 y vectores). Ese hub es para reutilizar
investigaciones de código entre agentes, con leases y snapshot.

## Decisión

1. **Una investigación es una tarea de tipo `research`.** Tiene la misma vida,
   tablero y gates que cualquier tarea (ADR-0006). Su pregunta es la descripción
   de la tarea.
2. **Afirmaciones tipadas con estado.** Hipótesis, hallazgos y conclusiones son
   registros vinculados a la tarea. Cada uno tiene un estado: `hypothesis`,
   `observed`, `verified` o `refuted`.
   - Un hallazgo cita evidencia (ADR-0012). Sin evidencia queda como
     `unsupported` y la UI lo marca.
   - Sólo un actor humano pasa una afirmación a `verified` o `refuted`. Un
     agente puede proponerlo, no decidirlo (mismo criterio que el cierre
     humano).
3. **Los agentes escriben por el puente** (ADR-0009): `research.hypothesis.add`,
   `research.finding.add` (con ids de evidencia) y
   `research.conclusion.propose`. Cada registro guarda actor y run.
4. **El reporte es una versión inmutable.** Se genera desde los registros, no
   desde el chat. Es Markdown con referencias `keel:evidence/<id>` y
   `keel:chart/<id>`, y cada versión tiene hash. Al mostrarlo, las referencias
   se resuelven a los mismos artefactos que se vieron en vivo, sin regenerar
   gráficas. Una versión nueva no borra la anterior.
5. **Exportar.** A Markdown o HTML con las gráficas ya renderizadas (ADR-0012
   §5). El PDF llega después.
   - Cada hallazgo exportado lleva su procedencia: consulta, momento, actor y
     hash.
   - La evidencia `restricted` (producción) sólo se incluye si el humano la
     elige al exportar.
6. **Relación con el Shared Research Hub.** No lo reemplaza. Una investigación
   puede publicar al hub un resumen saneado para que otros agentes la
   reutilicen, con las reglas de SDD 02 §5 (snapshot, frescura, leases).

## Criterios de aceptación

- Un reporte generado dos veces desde los mismos registros tiene el mismo hash.
- Una gráfica del reporte y la de la vista en vivo apuntan al mismo artefacto.
- Un agente no puede marcar una afirmación como `verified`.
- Un hallazgo sin evidencia aparece como `unsupported` en el reporte.

## Consecuencias

- Migración: tablas `research_claims_items` (afirmaciones con estado y vínculos)
  y `research_reports` (versiones con hash). El nombre `research_claims` ya lo
  usan los leases del hub.
- La GUI necesita una vista de investigación y un lector de reportes. La TUI
  muestra el reporte como texto con referencias.

## Alternativas consideradas

- **Exportar el chat como documento.** Mezcla razonamiento, ruido y hechos sin
  procedencia.
- **Un documento libre editado por el agente.** No distingue verificado de
  supuesto ni ata cada afirmación a su evidencia.
- **Usar el Shared Research Hub para todo.** Está pensado para reutilizar
  investigación de código con snapshot y leases, no para auditorías.
