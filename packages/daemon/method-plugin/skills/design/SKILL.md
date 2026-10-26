---
name: design
description: Etapa design del ciclo formal en Keel. Úsala para escribir la spec con escenarios y el diseño con contrato congelado y fronteras de archivos disjuntas antes de implementar.
---

# Diseño

Dos documentos con `task_doc_put`.

**`spec`**: qué debe ser verdad, en escenarios parseables. Keel exige que cada
requisito tenga al menos un escenario y que cada escenario tenga Dado, Cuando
y Entonces.

```markdown
## Requisitos

### R1 — <nombre>
Enunciado normativo («debe» / «no debe»).

#### Escenario: <caso feliz>
- **Dado** <contexto>
- **Cuando** <acción>
- **Entonces** <resultado verificable>

#### Escenario: <borde o error>
- **Dado** …
- **Cuando** …
- **Entonces** …
```

**`design`**: el contrato que no cambia durante la implementación.

```markdown
## Contrato congelado
Endpoints, tipos, schemas y eventos que se comparten, en el idioma del stack.

## Fronteras de archivos
| responsable | archivos |
| ----------- | -------- |
| backend     | `apps/api/src/features/<x>/**` |
| frontend    | `apps/web/src/features/<x>/**` |

## Decisiones → ADR
Lo que amerite ADR en el canon del proyecto, con su porqué.
```

Keel valida que el contrato tenga contenido, que las fronteras no se solapen
y que, si se toca un invariante del proyecto, el diseño enlace su ADR.

Cuando estén, avanza con `stage_advance` a `implement`. El humano aprueba el
diseño (gate b) y Keel fija el hash del contrato: cambiarlo después reabre el
gate.

Escribe también `tasks`: una línea por frontera, cada una ligada a un
requisito (`R1`, `R2`…).
