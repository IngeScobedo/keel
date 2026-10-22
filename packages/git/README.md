# @keel/git

Worktrees aislados por run, captura y rescate de cambios y reconciliación tras
un crash. Es una librería de Keel sin decisiones de producto (ADR-0007): no abre
el store ni emite eventos de Keel, y corre en Node ≥ 22 sin Bun. Sirve a
cualquier harness que ponga agentes a trabajar en paralelo sobre un mismo repo.

## El estado vive en git

No hace falta una base de datos para saber qué worktrees son de un run:

| Qué                            | Dónde                                         |
| ------------------------------ | --------------------------------------------- |
| Run con worktree y su base SHA | `refs/keel/runs/<run_id>`                     |
| Rama de trabajo                | `keel/<run_id>`                               |
| Metadatos (dueño, fecha, ruta) | `<git-dir del worktree>/keel.json`            |
| Cambios rescatados             | `refs/keel/rescue/<run_id>/<marca de tiempo>` |

El ref del run se escribe antes de crear el worktree y se borra después de
quitarlo. Un crash en medio deja un ref huérfano, que `reconcile()` ve; nunca
deja un worktree que nadie reconoce.

El `runId` puede ser jerárquico, con segmentos separados por `/`. Por ejemplo,
`KEEL-7/run-1/root` produce la rama `keel/KEEL-7/run-1/root`, el esquema
`keel/<work-item>/<run>/<lane>` del SDD 02. Un id no puede ser prefijo de otro
por segmentos (`a` y `a/b`): git lo rechaza y la librería devuelve `conflict`.

## API

```ts
import { createWorktree, openRepo, reconcile, removeWorktree } from "@keel/git";

const repo = await openRepo("/ruta/al/repo");
const wt = await createWorktree(repo, {
  runId: "run-42",
  path: "/abs/wt/run-42",
});
// … el agente trabaja en wt.path …
const all = await reconcile(repo); // active | missing | orphan_ref | unregistered
await removeWorktree(repo, "run-42"); // rescata cambios sin commit antes de borrar
```

- `openRepo(path, { retry? })`: resuelve la raíz y el `.git` común.
- `createWorktree(repo, { runId, path, base?, owner? })`: crea la rama desde
  `base` (por defecto `HEAD`). Falla con `conflict` si el run ya existe.
- `reconcile(repo)`: estado de todos los worktrees de Keel leído sólo de git. No
  modifica nada.
- `captureChanges(path, baseSha)`: commits por encima de la base y archivos sin
  commit.
- `preserveChanges(repo, { runId, path })`: commit de rescate con un índice
  temporal; no toca el índice ni la rama del worktree.
- `removeWorktree(repo, runId)`: rescata, quita el worktree y el ref, y conserva
  la rama si tiene trabajo. Es idempotente.
- `withRepoLock(commonDir, fn)`: la misma cola que usan las operaciones
  internas, para quien orquesta otras escrituras sobre el repo.

## Errores y concurrencia

Todo fallo es un `GitError` con `kind`: `locked`, `conflict`,
`invalid_argument`, `not_a_repository` o `failed`. Las escrituras sobre el
`.git` común se serializan por repositorio dentro del proceso. Ante un lock de
otro proceso se reintenta con backoff acotado (`DEFAULT_RETRY`) y, si sigue ahí,
se devuelve `locked`. El archivo de lock nunca se borra: es de otro.

## Tests

`bun test` corre contra repositorios git reales en directorios temporales,
incluidos los casos de crash, lock ajeno y creación en paralelo. CI importa el
paquete con Node para que la regla de runtime se cumpla sola.
