# El harness de Casa Matte frente a Keel: qué ya existe y qué tiene que conducir Keel

- **Fecha:** 2026-10-26
- **Relacionados:** ADR-0006 (lifecycle), ADR-0009 (tools MCP), ADR-0013
  (recursos y secretos), ADR-0015 (git con plan), ADR-0016 (investigaciones),
  ADR-0017 (contexto), ADR-0019, ADR-0020, ADR-0021 (propuesto, a reescribir),
  SDD 04 Fase 2
- **Fuente revisada:** `~/projects/inprodi/casa-matte-monorepo`:
  - `framework/{README,method,harness,vision-cli}`
  - `changes/` y sus plantillas, `.claude/skills/{grilling,open-change}`
  - `.claude/{agents,hooks,rules}`
  - `CLAUDE.md` y `AGENTS.md`

## Por qué esta revisión

El humano no quiere aprender Keel para trabajar: quiere llegar con una tarea y
que el harness la lleve por el mejor camino (memoria `keel-guided-harness`). Ese
camino ya lo tiene escrito y probado en Casa Matte. Es una destilación de BMAD,
OpenSpec y SDD, encarnada en skills, agentes y hooks de Claude Code. Esta
revisión mapea ese método contra lo que Keel ya tiene, para que Keel lo conduzca
en lugar de reinventarlo.

## Hallazgo inmediato: Keel apaga el harness del proyecto

El adaptador de Claude lanza el SDK con `settingSources: []`
(`packages/daemon/src/adapters/claude.ts`):

- **Origen:** viene del spike, que aislaba la máquina para medir el SDK. Ningún
  ADR lo decide.
- **Efecto:** en un run de Keel, Claude no carga nada del proyecto:
  - el `CLAUDE.md` y el `AGENTS.md`;
  - las reglas por ruta de `.claude/rules`;
  - los skills `grilling`, `elicit`, `open-change`, `write-adr`, `write-sdd`;
  - los agentes `analyst`, `architect`, los engineers y el `reviewer`;
  - los hooks `check-commit`, `block-secrets`, `protect-generated` y
    `readonly-lock`.
- **Consecuencia:** el agente de KEEL-1 trabajó sin el método y sin los candados
  del repo.

## El método, en cuatro piezas

1. **Un ciclo con estados y transiciones legales.** Los estados son Draft →
   Approved → Designed → InProgress → Review → Done → Archived, y el descarte
   sale desde cualquiera en vuelo. La legalidad la decide un script
   (`change-state.sh`), no la prosa.
2. **Tres gates humanos; entre ellos el loop actúa solo.**
   - (a) el brief aprobado;
   - (b) el contrato congelado, con su hash en `.contract-lock`;
   - (c) promover a canon (ADR, SDD, roadmap), en serie.
3. **Fast-path.** Por defecto se trabaja directo. El ciclo formal se abre sólo
   si el cambio:
   - toca un contrato público o un invariante;
   - paraleliza dos engineers;
   - o es un módulo grande sin SDD.

   Lo decide el `grilling`, que además pregunta de a una cosa, con la respuesta
   recomendada, y lee el repo antes de preguntar.

4. **Roles con frontera dura.**
   - `analyst` (sólo lectura) produce el brief.
   - `architect` produce spec, contrato congelado y fronteras de archivos
     disjuntas.
   - Los engineers implementan contra el contrato, cada uno con una story
     autocontenida.
   - `reviewer` (sólo lectura, adversarial) emite PASS, CONCERNS, FAIL o WAIVED.
   - El gate de calidad es «delta-verde»: no rojo nuevo frente al baseline.

Alrededor hay memoria en tres capas (viva, canon en `docs/` y bitácora) y hooks
que hacen cumplir lo mecánico. El método se escribe agnóstico y se parametriza
por tipo de proyecto y stack (`vision-cli.md`).

## Mapa contra Keel

| Casa Matte                                                                    | Keel hoy                                                                                                      | Lo que falta                                                                                                                                                       |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `changes/<id>/STATE` con transiciones legales                                 | `lifecycle` con aristas y autoridad (ADR-0006); el tablero ya sigue al lifecycle                              | Etapas del método dentro de la tarea, con la misma legalidad en `@keel/core`                                                                                       |
| Gates (a), (b), (c)                                                           | Aprobaciones con hash e inbox (SDD 02 §9); plan de git con hash (ADR-0015)                                    | Gate de «brief aprobado» y de «contrato congelado» como aprobaciones de la tarea                                                                                   |
| `proposal`, `spec`, `design`, `tasks`, `story`, `qa-gate`                     | Notas, evidencia y artefactos por contenido (ADR-0012); investigaciones (ADR-0016)                            | Documentos de la tarea con tipo y versión; el `.contract-lock` es el hash del diseño aprobado                                                                      |
| Fast-path decidido en el grilling                                             | —                                                                                                             | Que el agente declare la ceremonia («directo» o «ciclo formal y por qué») y Keel la aplique                                                                        |
| Roles con tools acotadas                                                      | Gate de herramientas, modos por run y aislamiento (ADR-0018)                                                  | Etapas de sólo lectura por rol (lo que ADR-0021 intentó para «planear»)                                                                                            |
| `tasks.md`: una tarea, una frontera de archivos                               | Fase 2 del SDD 04: locks por globs, scheduler, lanes                                                          | Subtareas hijas con su frontera; la rama de la feature y un worktree por subtarea (decisión del humano, 2026-10-26)                                                |
| `story.md` autocontenida                                                      | Encabezado del prompt y contexto por MCP (ADR-0017)                                                           | El paquete de contexto de la subtarea: contrato, convenciones y escenarios resueltos, para gastar menos                                                            |
| Delta-verde                                                                   | SDD 04 Fase 2: «baseline delta-verde, evidencia ligada a SHA»                                                 | Capturar el baseline al congelar el diseño                                                                                                                         |
| Hooks (`check-commit`, `block-secrets`, `protect-generated`, `readonly-lock`) | Reglas `auto`/`deny` del proyecto (ADR-0019 §4); git push sólo con plan (ADR-0015); secretos fuera (ADR-0013) | Cargar los hooks del proyecto en los runs (ver el hallazgo) o expresarlos como reglas de Keel                                                                      |
| Memoria viva y canon en `docs/`                                               | Notas, research con evidencia, `context_search` y `always_read` (ADR-0017)                                    | Promover a canon al cerrar: ADR, SDD y roadmap por plan de git                                                                                                     |
| Skills del método                                                             | —                                                                                                             | Cargarlos del proyecto (`settingSources`) y que Keel traiga un playbook por defecto para proyectos sin harness                                                     |
| Pedir infraestructura                                                         | Conexiones, grants, `ssh_run` e `iac_plan`/`iac_apply` por el intermediario (ADR-0013)                        | `setup_request`: el agente pide una conexión o un plugin y la GUI abre el modal prellenado                                                                         |
| Una sesión por cambio                                                         | Cadena de runs (ADR-0019 §3)                                                                                  | Worktree desde el primer run de la tarea, para que la sesión se retome siempre; conversación del proyecto para consultas sueltas (decisión del humano, 2026-10-26) |

## Consecuencias para los ADRs

- **ADR-0021, tal como está propuesto, va en contra de esto.** Pone «planear» y
  «ejecutar» como pasos del humano. Se reescribe: las etapas las lleva el agente
  según el método, y el humano sólo ve los gates.
- **El método debe ser del proyecto, no de Keel.** Lo que Casa Matte ya tiene,
  Keel lo carga y lo hace cumplir. Un proyecto sin harness recibe un playbook
  por defecto destilado de este, parametrizable como en `vision-cli.md`.
- **Lo que hace cumplir un hook no se duplica en prosa.** Keel lo expresa como
  política del daemon (reglas, gate, ADR-0018), o carga el hook del proyecto.
