# ADR-0043: PRs, promociones entre ramas y GitHub Actions, vivos dentro de Keel

- **Estado:** Propuesto
- **Fecha:** 2026-10-30
- **Criticidad:** Alta
- **Relacionados:**
  - ADR-0015 (plan de git aprobado; la PR con el `gh` del usuario; «el merge a
    la rama principal es una decisión humana»): este ADR le da superficie a esa
    decisión y la extiende a las promociones.
  - ADR-0002 (Keel no implementa login ni guarda credenciales de terceros).
  - ADR-0038 (gates como objetos; `deploy-approval`), ADR-0026 (producción
    pregunta), ADR-0031 §5 (la ejecución se ve en vivo como tarjeta).
  - ADR-0021 §5 (el perfil del proyecto: ramas protegidas y prefijos), ADR-0011
    (eventos semánticos), ADR-0012 (evidencia), ADR-0020 (tarjetas del chat),
    ADR-0007 (librerías que crecen dentro del daemon).
  - Spike `spikes/github-flow` (cifras de este ADR).

## Contexto

El humano (2026-10-30), con el repo de zero-reports abierto en Keel:

> que lo de git sea interactivo y visualmente correcto […] no solo como el card
> que diga que hizo push de un PR; que si hay modo me lo muestre dentro de Keel
> y pueda mergear, hacer squash and merge igual que en GitHub […] al mergear a
> stage se ejecutan las GitHub Actions de CI/CD para DigitalOcean, build de
> Docker, etc., que también quisiera verlo en Keel; luego de tenerlo en stage,
> en otro gate o confirmación, se mergea a main.

Lo que hace ese repo, medido en el spike:

- Las ramas cortas (`feat|fix|…/<contexto>-<resumen>`) salen de `development` y
  vuelven por PR, con merge commit (26 de 28 merges). El review es obligatorio y
  el repo debe estar en verde.
- `development → stage` y `stage → main` son **promociones**: merges sin PR con
  mensaje fijo (`chore(release): promueve development a stage`; 15 y 8 en la
  historia).
- Un push a `stage` dispara `Deploy · stage` (build y push de la imagen y
  rollout en DigitalOcean; mediana 536 s). Un push a `main` dispara
  `Deploy · prod` (promueve la imagen sin rebuild y hace el rollout; 259 s).
  `CI` corre en cada PR (90 s) y en cada push a `main` (97 s).
- La API de protección de ramas responde 403: el repo es privado sin GitHub Pro.
  GitHub no le dice a Keel qué ramas protege.
- La convención prohíbe `Co-Authored-By` de agentes en los commits, igual que en
  Casa Matte.

Hoy Keel crea la PR al cerrar una tarea (ADR-0015) y la muestra como una tarjeta
que dice «creó la PR #n». Lo demás pasa en GitHub:

- ver sus checks y su review;
- mergearla;
- promover;
- seguir el deploy.

## Decisión

### 1. GitHub a través del `gh` del humano

- Keel habla con GitHub sólo por el `gh` instalado y autenticado del humano
  (`gh api`, `gh pr`, `gh run`, con salida JSON). No hay OAuth, token propio ni
  GitHub App (ADR-0002).
- Si `gh` falta o no tiene sesión, la GUI lo dice con el comando para
  arreglarlo. Lo de git local sigue funcionando.
- El adaptador vive en el daemon (`github/`), con APIs de Node, hasta que tenga
  un segundo consumidor (ADR-0007).
- Cada lectura cuesta de 1 a 1.6 s (spike). Keel sigue lo que está vivo y no
  barre el repo.

### 2. El flujo de ramas es del proyecto, detectado y confirmado

El perfil del proyecto (ADR-0021 §5) gana `flow`:

```toml
[git.flow]
work_base = "development"        # de dónde salen las ramas cortas y adónde van sus PR
pr_merge_method = "merge"        # merge | squash | rebase: lo que la tarjeta ofrece primero

[[git.flow.promotions]]
from = "development"
to = "stage"
message = "chore(release): promueve development a stage"
environment = "staging"           # el workflow que dispara despliega aquí

[[git.flow.promotions]]
from = "stage"
to = "main"
message = "chore(release): promueve stage a main"
environment = "prod"
requires = ["Deploy · stage"]     # verde para el commit que se promueve

[git.conventions]
co_authored_by = false            # Keel no agrega Co-Authored-By a sus commits
```

- **Keel lo detecta sin ejecutar nada:**
  - los disparadores `push: branches` de `.github/workflows`;
  - los mensajes de la historia: `Merge pull request #n` y `promueve X a Y`;
  - el método de merge de las PR;
  - la rama por defecto.
- El humano lo revisa y lo confirma en Ajustes del proyecto, como el alta de
  Terraform. `.keel/project.toml` lo puede fijar en el repo.
- Las ramas `work_base` y los `to` de cada promoción son ramas protegidas para
  el agente (ADR-0015 §4).

### 3. La PR es un objeto vivo en Keel

- Toda PR que Keel abrió, o que el humano trae por número, se ve en la tarea y
  en el chat como **tarjeta de PR**:
  - estado, base ← cabeza y si es _mergeable_;
  - review requerido y su decisión;
  - checks con su avance;
  - archivos con `+`/`−`;
  - enlace a GitHub.
- Se refresca cada 5 s mientras algún check corre y cada 60 s si no. Cuando está
  mergeada o cerrada, deja de seguirse.
- **Acciones**, como en GitHub y sólo las que el repo permite:
  - **Merge**, con el método a elegir: _merge commit_, _squash and merge_ o
    _rebase and merge_. El primero que se ofrece es `pr_merge_method`. En
    squash, el título y el cuerpo se pueden editar.
  - Borrar la rama al mergear.
  - Volver a correr los checks fallidos.
  - Cerrar la PR.
- **Mergear es del humano** (ADR-0015 §4). El botón ejecuta
  `gh pr merge --match-head-commit <sha que viste>`: si la cabeza cambió después
  de verla, GitHub lo rechaza y la tarjeta se actualiza.
- **El agente** puede leer la PR y proponer el merge (`pr_merge_request`). Eso
  queda como pendiente para el humano; nunca mergea.

### 4. La promoción es un plan con gate

- **«Promover development → stage»** muestra antes de nada:
  - las PR y los commits que entran (`stage..development`);
  - los checks de la cabeza de `development`;
  - el workflow que va a disparar.
- **Al aprobar**, el daemon:
  1. revalida las dos cabezas del plan; si alguna se movió, el plan caduca;
  2. hace el merge `--no-ff` con el mensaje del proyecto, en un worktree de Keel
     de la rama destino, sin tocar el checkout del humano;
  3. hace el push.

  No hay _force push_. Ninguna promoción se hace con `git.propose` del agente:
  es una operación sólo humana.

- **Un merge con conflictos no se resuelve a ciegas.** El plan falla con los
  archivos en conflicto y ofrece abrir una tarea para resolverlos.
- **La promoción a un `environment = "prod"`** es un gate `deploy-approval`
  (ADR-0038):
  - exige verdes los `requires` para el commit que se promueve;
  - se confirma como producción (ADR-0026).

### 5. GitHub Actions en vivo

- **Qué sigue Keel.** Después de un push, un merge o una promoción hecha desde
  Keel, sigue los runs del commit (`gh run list --commit <sha>`). El humano
  también puede seguir uno a mano.
- **La tarjeta de pipeline.** Workflow → jobs → pasos, con el paso en curso y su
  reloj, el tiempo de cada paso y la duración típica del workflow como
  referencia («stage suele tardar 9 min»).
  - El log de un paso llega al terminar o al fallar. La API no lo entrega
    mientras corre (spike).
  - Si falla: el paso, las últimas líneas del log (`--log-failed`), «Volver a
    correr» y «Crear tarea de fix».
- **Eventos semánticos** (ADR-0011), con cobertura `polled`:
  - `github.pr.updated`, `github.pr.merged`;
  - `git.promotion.completed`;
  - `ci.run.started`, `ci.run.step`, `ci.run.completed`.

  Llegan al chat donde se originó la acción y a la vista de entregas.

### 6. Dónde se ve

- **En el chat** (ADR-0020), donde pasó: la tarjeta de PR, la de promoción y la
  de pipeline, interactivas y en vivo.
- **Entregas, por proyecto.** Una columna por rama del flujo
  (`development → stage → main`) con:
  - lo que entró y aún no se promovió;
  - el último deploy de cada entorno y su estado;
  - las PR abiertas hacia `work_base`;
  - el botón de la siguiente promoción, con su gate y el «todavía no, y por qué»
    arriba (ADR-0038).
- El diseño nace en el canvas antes que en la GUI.

### 7. Convenciones del repo

- Los commits que Keel crea siguen `git.conventions` del perfil: sin
  `Co-Authored-By` si el proyecto lo prohíbe.
- La rama que se empuja para la PR sigue el prefijo del perfil
  (`feat/<contexto>-<resumen>`), aunque el worktree local use `keel/…`.

## Criterios de aceptación

- Sin `gh` autenticado, la tarjeta de PR explica cómo arreglarlo y el commit y
  el push siguen funcionando.
- **Mergear:** se hace desde la tarjeta con _squash and merge_, con el título
  editado. Si alguien empujó a la PR después de verla, el merge se rechaza y la
  tarjeta muestra la nueva cabeza.
- **Promover a stage:**
  - lista las PR que entran;
  - si `development` se movió entre el plan y la aprobación, caduca;
  - al hacerse, la tarjeta de `Deploy · stage` aparece sola y avanza paso a paso
    hasta su conclusión.
- La promoción a `main` no se ofrece mientras `Deploy · stage` del commit no
  esté verde, y dice por qué.
- Un deploy fallido muestra el paso y el final de su log, y ofrece volver a
  correr o crear una tarea.
- En zero-reports, el flujo detectado es `development → stage → main` con los
  mensajes de la historia, sin escribir nada a mano.

## Consecuencias

- El perfil del proyecto gana `flow` y `conventions`.
- **Seguir runs consume llamadas:** a 5 s, 720 por hora por run activo, contra
  5000 por hora del límite autenticado.
  - Si quedan menos de 500, Keel deja de seguir lo que nadie está viendo.
  - El intervalo es configurable.
- No hay webhooks: el daemon es local y no tiene una URL pública. Si un día la
  tiene, los webhooks reemplazan el polling sin cambiar las tarjetas.
- Las promociones usan un worktree de Keel por rama destino. Lo que el humano
  tenga sin commit en su checkout no se toca.
- GitLab y otros quedan fuera: mismo contrato de tarjetas, otro adaptador.

## Alternativas consideradas

- **Abrir GitHub en el navegador.** Es lo de hoy: el hilo se pierde y Keel no
  sabe qué pasó después.
- **Un token propio o una GitHub App.** Keel tendría que guardar credenciales e
  implementar login (ADR-0002).
- **Promover con PR (`development → stage`).** El repo no lo hace así: sus
  promociones son merges, y una PR de promoción sin review sería ceremonia sin
  control. Un proyecto que sí las quiera puede declarar `via = "pr"` en su
  promoción.
- **Webhooks a través de un túnel.** Es una URL pública hacia la máquina del
  humano para ahorrar llamadas; no compensa a esta escala.
