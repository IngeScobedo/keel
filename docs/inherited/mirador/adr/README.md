# Architecture Decision Records

Decisiones de arquitectura del proyecto. Formato: contexto → decisión →
consecuencias → alternativas consideradas. Un ADR aceptado no se edita: se
supersede con uno nuevo.

| #                                                          | Título                                                                          | Estado                                       | Criticidad |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------- | -------------------------------------------- | ---------- |
| [0001](./0001-modo-de-operacion-observador-y-runtime.md)   | Modo de operación — observador primero, runtime detrás de un adaptador          | Aceptado                                     | Alta       |
| [0002](./0002-envelope-de-eventos-y-payload-crudo.md)      | Envelope canónico y persistencia íntegra del payload crudo                      | Aceptado                                     | Alta       |
| [0003](./0003-modelo-de-correlacion.md)                    | Modelo de correlación (run / session / agent / tool_use)                        | Superseded por 0008                          | **Máxima** |
| [0004](./0004-postura-de-seguridad-y-acceso-a-datos.md)    | Postura de seguridad, acceso a datos y gates de permiso                         | Aceptado                                     | Alta       |
| [0005](./0005-stack-y-estructura-del-monorepo.md)          | Stack técnico y estructura del monorepo                                         | Aceptado (runtime superseded por 0007)       | Media      |
| [0007](./0007-runtime-bun-en-todo-el-repo.md)              | Runtime — Bun en todo el repo; Node como target de compatibilidad               | Aceptado                                     | Media      |
| [0008](./0008-modelo-de-correlacion-revisado.md)           | Modelo de correlación revisado con evidencia de fixtures                        | Aceptado (padres y runs superseded por 0010) | **Máxima** |
| [0010](./0010-arbol-de-tres-niveles-y-semantica-de-run.md) | Resolución de padres por tres canales, árbol de tres niveles y semántica de run | Aceptado                                     | **Máxima** |
| [0006](./0006-transporte-de-ingesta.md)                    | Transporte de ingesta (hook → colector)                                         | Aceptado                                     | Media      |

## Orden de lectura

Si llegas nuevo: 0001 → 0008 → 0010 → 0002. Esos cuatro son el modelo mental
completo. Los demás son consecuencias. (0003 es historia: léelo para entender
por qué 0008 dice lo que dice.)

## El invariante que atraviesa todo

Los adaptadores traducen a `AgentEvent` y nada por encima del bus sabe de dónde
vino el evento. Es lo que hace que agregar el modo runtime sea un paquete nuevo
en vez de un rewrite, y es la regla que más presión va a recibir. Cuando alguien
proponga "nomás agrego este campo del hook al envelope", la respuesta es `raw`
(ADR-002).

## Decisiones abiertas

Cosas deliberadamente **no** decididas todavía, para no decidirlas sin datos:

- **Reconstrucción de ventana de contexto.** Cómo cruzar el JSONL con los
  eventos para reportar qué sobrevivió a un compact. Necesita fixtures de Fase 1
  con compactación real.
- **Herramienta de migraciones.** Elegir una y documentarla; no importa cuál.
- **Modelo de reglas para aprobación persistente.** Postergado hasta tener datos
  de uso (ADR-004).
- **Distribución.** Si "descarga y corre" se vuelve requisito, revisar SQLite
  (ADR-002).
- **Retención y agregados.** Qué vistas materializadas valen la pena; se decide
  cuando duela una query, no antes.

## Antes de escribir código

Los fixtures de sesiones reales que pedía la Fase 1 ya existen, redactados y
commiteados en `packages/core/__fixtures__/` (ver su README; se regeneran con
`bun run fixtures:redact`). Las funciones puras de correlación en core se
escriben contra esos fixtures siguiendo ADR-008. Es el primer código del
proyecto.
