---
name: brief
description: Cierra la etapa brief de una tarea de Keel. Úsala cuando el pedido ya esté claro (tras grilling) para escribir el brief con task_doc_put y declarar la ceremonia con stage_advance.
---

# Brief

Escribe el documento `brief` con `task_doc_put` (kind `brief`). Keel lo valida:
las cuatro secciones deben tener contenido.

```markdown
# Brief — <título>

## Problema
Qué duele y para quién. Evidencia del repo si la hay.

## Alcance
Qué se va a hacer.

## Fuera de alcance
Qué no entra; corta el scope creep.

## Criterios de aceptación
- Lo que debe ser verdad al terminar, verificable.

## Restricciones
Invariantes, convenciones y ADRs que aplican. Marca `[INFERIDO — confirmar]`
lo que dedujiste sin confirmación.
```

Luego avanza con `stage_advance`:

- `to: "implement", ceremony: "direct"` para trabajo directo;
- `to: "design", ceremony: "formal"` para el ciclo formal. El humano aprueba el
  brief (gate a) antes de diseñar.

Pon en `reason` por qué elegiste esa ceremonia, en una frase. Si Keel rechaza el
paso, te dice qué falta: corrígelo y vuelve a intentar, sin rehacer lo demás.
