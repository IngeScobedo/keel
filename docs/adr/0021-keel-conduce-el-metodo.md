# ADR-0021: Keel conduce el método: etapas con gates, documentos de la tarea y una conversación por tarea

- **Estado:** Propuesto
- **Fecha:** 2026-10-26
- **Criticidad:** Máxima
- **Relacionados:**
  - ADR-0006 (lifecycle)
  - ADR-0012 (artefactos)
  - ADR-0013 (recursos)
  - ADR-0015 (git con plan)
  - ADR-0017 (contexto)
  - ADR-0018 (aislamiento)
  - ADR-0019 §3–§4: este ADR lo supersede en los modos de un run que no ejecuta.
  - ADR-0020 §7
  - Revisión `docs/reviews/2026-10-26-harness-casa-matte-y-keel.md`
- **Historia:** la primera versión de este ADR (mismo día) ponía «planear» y
  «ejecutar» como pasos del humano. El humano la descartó antes de aceptarla:
  «lo que no quiero es que tengas que aprender a usar keel».

## Contexto

El humano construyó en Casa Matte (`~/projects/inprodi/casa-matte-monorepo`) un
harness para desarrollar con agentes, con la intención explícita de que
terminara siendo Keel. Es una destilación de BMAD, OpenSpec y SDD, encarnada en
skills, agentes y hooks de Claude Code:

- **Un ciclo con transiciones legales.** Draft → Approved → Designed →
  InProgress → Review → Done → Archived, decidido por un script y no por la
  prosa.
- **Tres gates humanos.** El brief aprobado, el contrato congelado (con su hash)
  y la promoción al canon. Entre gates el loop actúa solo.
- **Fast-path.** El ciclo formal se abre sólo si el cambio toca un contrato o
  invariante, paraleliza dos engineers o es un módulo grande sin SDD. Lo demás
  es trabajo directo. Lo decide un `grilling` que pregunta una cosa a la vez,
  con su recomendación, y lee el repo antes de preguntar.
- **Roles con frontera dura.**
  - `analyst` (sólo lectura) produce el brief.
  - `architect` produce spec, contrato y fronteras de archivos disjuntas.
  - Los engineers trabajan con una story autocontenida.
  - `reviewer` (sólo lectura) emite PASS, CONCERNS, FAIL o WAIVED.
- **Verde es «delta-verde».** No rojo nuevo frente al baseline.

Lo que pasó al usarlo con Keel el 2026-10-26, en KEEL-1:

- El adaptador de Claude lanza el SDK con `settingSources: []`, herencia del
  spike. El agente no cargó ni el `CLAUDE.md`, ni las reglas, skills, agentes o
  hooks del repo: trabajó sin el método y sin sus candados.
- El humano tuvo que elegir «Planear» o «Ejecutar». Cuatro runs de planeación
  terminaron editando la raíz del repo, en `main`, sin worktree. La tarea nunca
  avanzó.

Lo que pide el humano:

- Abrir cualquier proyecto y trabajar como en Casa Matte, con los mismos gates y
  resultados, sin rehacer docs, skills ni hooks en cada repo.
- Si el proyecto trae su propia metodología, respetarla.
- Que el agente sepa que está en Keel y lleve la tarea.
- Que cada tarea gaste lo mínimo.

## Decisión

### 1. El método vive en Keel

El ciclo, los gates, el fast-path y los roles son de Keel, destilados del método
de Casa Matte (`framework/method`). Un proyecto no necesita copiar nada para
tenerlos.

- La legalidad de las etapas es código puro en `@keel/core`, como lo era
  `change-state.sh`.
- Los roles y procedimientos (`grilling`, `elicit`, brief, diseño, story,
  revisión) los aporta Keel al agente, sin escribir archivos en el repo. Con
  Claude van como agentes y skills de un plugin que Keel pasa al SDK; con Codex,
  como instrucciones del turno. El mecanismo exacto se mide en un spike antes de
  implementarlo.
- Lo que Casa Matte hace cumplir con hooks, Keel lo hace cumplir en el daemon:
  - `check-commit` y git push → plan de git (ADR-0015);
  - `block-secrets` → ADR-0013 y reglas `deny` de lectura;
  - `protect-generated` → reglas `deny` por ruta;
  - `readonly-lock` → las etapas de sólo lectura.

### 2. Etapas de la tarea

| Etapa       | Rol       | Qué produce                                                                 | Escribe en el repo | Gate de salida                              |
| ----------- | --------- | --------------------------------------------------------------------------- | ------------------ | ------------------------------------------- |
| `brief`     | analyst   | brief: problema, alcance, fuera de alcance, restricciones, criterios        | no                 | (a) humano, sólo en el ciclo formal         |
| `design`    | architect | spec con escenarios, contrato congelado, fronteras, ADR o SDD si hace falta | no                 | (b) humano; el hash del diseño queda fijado |
| `implement` | engineer  | código contra el contrato; la story de cada frontera                        | sí, en su worktree | delta-verde                                 |
| `review`    | reviewer  | veredicto PASS, CONCERNS, FAIL o WAIVED con evidencia                       | no                 | FAIL vuelve a `implement`                   |
| `close`     | Keel      | plan de git: commit, merge, PR y la promoción a canon (ADR, SDD, roadmap)   | por plan           | (c) humano, en serie entre tareas           |

**Fast-path.**

- Al terminar el `brief`, el agente declara la ceremonia: «directo» o «ciclo
  formal», y por qué, con los disparadores del método.
- Directo salta (a) y (b): `brief` → `implement` → `review` → `close`.
- Formal recorre todo.
- El humano ve la decisión y la puede cambiar.

**Lifecycle.** ADR-0006 no cambia; las etapas lo mueven.

- `brief` y `design` ocurren en `triage`.
- Aprobar el diseño, o declarar trabajo directo, lleva la tarea a `planned`.
- `implement` es `running`.
- `review` es `needs_review`.
- Cerrar es `done`.

El tablero ya sigue al lifecycle.

**Avance.**

- El agente avanza la etapa con una tool de Keel (`stage_advance`) y Keel valida
  la transición y su gate.
- Las etapas sin gate avanzan solas.
- Ninguna etapa la elige el humano a mano, aunque puede devolverla.

### 3. Una tarea, una conversación

- **Worktree:** la tarea tiene su worktree desde el primer run. Su rama sigue la
  convención de la rama de feature del proyecto (§5).
- **Sesión:** todos los runs de la tarea trabajan ahí, así que la sesión del
  proveedor se retoma siempre (`resumeOf`) y la tarea es un solo chat.
- **Sólo lectura:** `brief`, `design` y `review` no escriben en el repo:
  - El gate de Keel niega ediciones y comandos que no son de sólo lectura, sin
    preguntar al humano.
  - Claude corre en modo `plan` del SDK; Codex, en sandbox `read-only`.
  - Esto reemplaza los modos `ask` y `plan` de ADR-0019 §4 para runs que no
    implementan.
- **Desaparecen** los botones «Planear» y «Ejecutar». La tarea tiene un solo
  «Trabajar», o simplemente se le escribe.

### 4. Documentos de la tarea

`brief`, `spec`, `design`, `tasks`, `story` y `qa` son documentos de la tarea en
Keel:

- Versionados, con hash y autor (ADR-0012).
- Visibles en la GUI.
- Legibles y escribibles por cualquier agente del proyecto con tools de Keel
  (`task_doc_get`, `task_doc_put`).
- No ensucian el repo mientras la tarea está en vuelo.

**Contrato congelado.** Es el hash del `design` aprobado en el gate (b).

- Cambiarlo durante `implement` reabre el gate.
- Al entrar a `implement`, Keel captura el baseline del comando de verificación
  del proyecto. El `review` compara contra él.

**Cierre.** El gate (c) aprueba un plan de git que lleva al repo lo durable:

- ADR y SDD nuevos o enmendados, el roadmap y la nota de cierre, en las rutas y
  el formato del proyecto.
- Se cierra una tarea a la vez, para numerar los ADR contra el `HEAD` ya
  integrado.

### 5. El proyecto

**El perfil del proyecto.** Al abrirlo por primera vez, un run de sólo lectura
detecta, y el humano confirma:

- el stack;
- el comando de verificación (lint, typecheck, test y build);
- las ramas protegidas y la convención de ramas y commits;
- las rutas generadas;
- dónde vive su canon (ADR, SDD, roadmap);
- las convenciones que aplican.

Es el `init` de `vision-cli.md`, sin generar archivos. Keel lo guarda y lo pasa
a cada rol; se corrige cuando cambie.

**El harness del proyecto.** Si el proyecto trae `.claude/` o `AGENTS.md`, Keel
lo carga en sus runs de Claude (`settingSources: ["project"]`): su `CLAUDE.md`,
reglas, skills, agentes y hooks.

- Donde se solapa con el método de Keel, manda el proyecto en el **cómo**
  (convenciones, formato de sus docs, sus skills) y Keel en el **cuándo**
  (etapas, gates, aislamiento).
- Un permiso que el proyecto auto-aprueba no puede saltarse el gate de Keel. Si
  el SDK no deja anular `permissions.allow`, se mide en el spike y se decide
  aquí antes de aceptar.

La configuración personal del usuario (`~/.claude`) no se carga.

### 6. Costo

- Cada rol recibe sólo lo de su etapa: el paquete de contexto, no el historial
  entero.
  - El engineer, su story autocontenida.
  - El reviewer, el diseño, el diff y el baseline.
- Notas, research y documentos de una tarea los reutiliza cualquier agente del
  proyecto (ADR-0017).
- La tarea tiene presupuesto propio con los límites bajos de ADR-0002 regla 5.

### 7. Lo que va en otros ADRs

- **Tarea padre y subtareas.** Rama de la feature y un worktree por subtarea con
  su frontera (decisión del humano, 2026-10-26), sobre el scheduler y los locks
  de la Fase 2.
- **El agente pide configuración** (`setup_request`): la GUI abre el modal de
  conexión o plugin ya prellenado.
- **Conversación del proyecto** de sólo lectura para consultas sueltas, desde la
  que el agente crea tareas (decisión del humano, 2026-10-26).

## Criterios de aceptación

- **Fast-path:** una tarea nueva en un proyecto sin `.claude/` se trabaja
  escribiéndole, sin elegir pasos. El agente hace el brief con grilling y
  declara la ceremonia. En trabajo directo, el código queda en el worktree de la
  tarea, se revisa contra el baseline y se cierra con un plan de git aprobado.
- **Ciclo formal:** un cambio que toca un contrato pide el gate (a) y luego el
  (b). Editar el diseño aprobado durante `implement` reabre el (b).
- **Sólo lectura:** en `brief`, `design` y `review`, un `Edit` o un `touch` se
  niegan sin preguntar, y `git status` del worktree queda limpio.
- **Una conversación:** todos los runs de una tarea comparten worktree y sesión;
  el agente recuerda la etapa anterior.
- **Harness del proyecto:** en Casa Matte, un run de Keel carga su `CLAUDE.md`,
  usa su `grilling` y su hook `check-commit` bloquea un commit a `main`.
- **Cierre:** promueve un ADR al canon del proyecto con su numeración y formato.

## Consecuencias

- Keel deja de ser neutral sobre cómo se trabaja: es opinionado por decisión del
  humano. Un proyecto que no quiera ceremonia la evita con el fast-path, no
  apagando Keel.
- Mientras se implementan las etapas se conservan «Planear» y «Ejecutar»; se
  retiran cuando las etapas cubran los criterios.
- La autoría del método se cita: BMAD, OpenSpec, `grill-me` de Matt Pocock y la
  destilación de Casa Matte.
- Cargar el harness del proyecto añade el riesgo de los hooks del repo, que
  corren con los permisos del proceso del agente. Dentro del sandbox de ADR-0018
  quedan acotados al worktree.

## Alternativas consideradas

- **Pasos explícitos del humano** (la primera versión de este ADR). El humano la
  descartó: obliga a aprender Keel.
- **Método sólo del proyecto (`.claude/`).** Cada repo tendría que copiar el
  harness, que es lo que el humano quiere evitar.
- **Método sólo de Keel, ignorando el del proyecto.** Pisaría metodologías que
  el proyecto ya tiene.
- **Documentos en el repo durante el vuelo (`changes/<id>/`).** Es fiel a Casa
  Matte, pero ata Keel a una estructura de carpetas y ensucia el diff. El humano
  eligió que vivan en Keel y se promuevan al cerrar.
