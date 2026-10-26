---
name: review
description: Etapa review en Keel. Úsala para revisar de forma adversarial lo implementado y escribir el QA con su veredicto antes del cierre.
---

# Revisión

Delega en el agente `reviewer` (sólo lectura) o hazla tú sin editar nada. Se
revisa **sólo**:

- correctness;
- cada escenario de la spec, o los criterios del brief en trabajo directo;
- que el contrato congelado no cambió;
- los invariantes y convenciones del proyecto.

Nunca estilo: eso es del linter.

Keel ya corrió la verificación al entrar a esta etapa. Pide el resultado con
`verify_run` si cambió algo: devuelve sólo el delta contra el baseline (rojo
nuevo, rojo que ya estaba, arreglado).

Escribe el `qa` con `task_doc_put`:

```markdown
## Veredicto: PASS | CONCERNS | FAIL | WAIVED

## Evidencia
- Verificación: delta-verde sí/no.
- Escenarios: comprobados / cuáles no.
- Contrato: sin cambios / ADR que lo justifica.

## Hallazgos
| severidad | archivo:línea | problema | ¿bloquea? |

## Justificación
Obligatoria si es WAIVED: quién acepta la deuda y por qué.
```

- **FAIL:** vuelve a `implement` con `stage_advance`.
- **PASS, CONCERNS o WAIVED:** avanza a `close`.

Keel no deja cerrar con rojo nuevo salvo WAIVED justificado.
