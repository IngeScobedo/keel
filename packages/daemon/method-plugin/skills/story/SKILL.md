---
name: story
description: Prepara la story autocontenida de un responsable antes de delegar la implementación en un subagente. Úsala cuando el diseño tenga más de una frontera o vayas a delegar.
---

# Story

Una story por frontera, con `task_doc_put` (kind `story`). El engineer la lee
**sólo a ella**: todo lo que necesita va resuelto dentro, para no gastar
contexto leyendo el diseño entero.

```markdown
# Story — <responsable> — <título>

## Qué construir
El alcance de esta frontera, en prosa.

## Contrato (copiado y resuelto)
Los endpoints, tipos y schemas que le tocan.

## Convenciones que aplican
Rutas del canon del proyecto, citadas.

## Fronteras (tuyas)
- `…/**`

## Escenarios de aceptación
- [ ] R1 «…»

## Hecho cuando
La verificación del proyecto sin rojo nuevo y los escenarios comprobados.
```

Delega en el agente `engineer` pasándole la story. Al volver, verifica tú: una
afirmación de «verde» de un agente no es evidencia. Corre `verify_run`.
