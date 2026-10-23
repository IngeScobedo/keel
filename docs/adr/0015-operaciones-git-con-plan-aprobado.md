# ADR-0015: Operaciones de git del agente con plan aprobado y verificado

- **Estado:** Propuesto
- **Fecha:** 2026-10-22
- **Criticidad:** Alta
- **Relacionados:** ADR-0002 (Keel no maneja credenciales de terceros), ADR-0009
  (puente MCP y autoridad), ADR-0010 (tools de `@keel/git`), ADR-0011, ADR-0012,
  ADR-0014 (nivel 3), SDD 02 «Git y lanes», SDD 02 §9

## Contexto

Hoy, cuando un agente pregunta «¿hago commit y push?», el humano aprueba un
comando de `Bash`: aprueba un texto, no el efecto. No ve el contenido del
commit, a qué rama va el push, desde qué worktree ni qué PR se crea. SDD 02 §9
ya dice que cambiar el comando, el destino o el hash del diff invalida un grant.

`@keel/git` ya crea worktrees por run en ramas `keel/<…>`, captura cambios y
guarda refs de rescate. ADR-0010 añade tools para inicializar repos y vincular.
Faltan commit, push y PR.

## Decisión

1. **Tools de lectura sin aprobación:** `git.status` y `git.diff` del worktree
   del run.
2. **`git.propose` crea un plan, no ejecuta.** El plan contiene:
   - Repositorio, worktree y rama de origen.
   - `expected_head_sha` y el hash del contenido a confirmar (índice más
     archivos).
   - La lista de operaciones: `commit` (mensaje y rutas), `push` (remoto y rama)
     y `pr.create` (base, título y cuerpo).

   El plan entra a `approval_requests` con su hash. La GUI lo muestra como
   tarjeta: archivos con `+`/`-`, mensaje, rama y remoto de destino, PR y
   worktree.

3. **Al aprobar, el daemon ejecuta y revalida en cada paso.** El HEAD, el hash
   del contenido y el destino deben seguir siendo los del plan. Si algo cambió,
   la aprobación caduca y hace falta otro plan. Lo ejecuta el daemon con
   `@keel/git`, no el shell del agente.
4. **Límites fijos.**
   - Nunca `force push` por esta vía.
   - Sólo se empuja a la rama del run o a la que el plan nombre, y nunca a una
     rama protegida del proyecto (la rama por defecto lo es siempre).
   - El merge a la rama principal no es de esta tool: es una decisión humana.
5. **La PR se crea con el `gh` del usuario.** Keel no guarda tokens de GitHub
   (mismo criterio que ADR-0002). Si `gh auth status` falla, el plan se puede
   aprobar sin el paso de PR y la UI explica qué falta.
6. **Eventos y evidencia.** Las operaciones emiten eventos semánticos con
   cobertura `instrumented` (ADR-0011):
   - `git.plan.proposed`, `git.plan.approved` y `git.plan.expired`.
   - `git.commit.created`, con sha, archivos y estadísticas.
   - `git.push.completed`, con remoto, ref y sha anterior y nuevo.
   - `git.pull_request.created`, con url y número.

   Todos apuntan a tarea, run, worktree y repositorio. El diff aprobado queda
   como evidencia (ADR-0012).

7. **Git por shell.** Este ADR no lo prohíbe, pero:
   - El perfil por defecto deniega `git push` en `Bash` y sugiere `git.propose`.
     Es una comodidad, no una frontera.
   - Al cerrar el run, Keel compara refs y registra los commits que no pasaron
     por la tool como eventos `inferred`.
   - En Codex, con la red apagada (ADR-0008), un push por shell falla.

## Criterios de aceptación

- Aprobar un plan y luego modificar un archivo del worktree hace caducar la
  aprobación antes del commit.
- Un plan que apunta a la rama por defecto se rechaza al proponerse.
- La tarjeta muestra los mismos archivos y hashes que el commit creado.
- Sin `gh` autenticado, el commit y el push funcionan, y la PR se informa como
  pendiente con la causa.

## Consecuencias

- `@keel/git` gana `commit`, `push` y la verificación del plan. La PR vive en un
  adaptador de `gh` aparte (GitHub es una integración, no el núcleo de git).
- El proyecto declara sus ramas protegidas en su configuración.
- La tarjeta de plan es el primer visualizador de nivel 3 (ADR-0014).

## Alternativas consideradas

- **Aprobar el comando de `Bash`.** Es lo de hoy: se aprueba texto, no efecto.
- **Dejar que el agente empuje con las credenciales del usuario.** Sin plan, sin
  revalidación y sin evidencia.
- **Reconstruir la intención leyendo la salida del shell.** Frágil, y no
  recupera la secuencia causal.
