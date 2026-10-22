/**
 * Serialización por repositorio (ADR-0007 §5). Todos los worktrees de un repo
 * comparten object store, refs y `.git/worktrees`; `worktree add/remove/prune`,
 * `update-ref` y `gc` compiten por los mismos locks. Dentro del proceso, las
 * operaciones que escriben en el `.git` común pasan por una cola por
 * repositorio. Entre procesos no hay cola posible: ahí se reintenta ante el
 * lock (exec.ts) y quien orquesta varios procesos usa `withRepoLock` en el suyo.
 */

const queues = new Map<string, Promise<unknown>>()

/**
 * Corre `fn` cuando terminen las operaciones anteriores sobre el mismo `.git`
 * común (la clave es el `git-common-dir` absoluto). Un fallo no rompe la cola.
 */
export function withRepoLock<T>(commonDir: string, fn: () => Promise<T>): Promise<T> {
  const previous = queues.get(commonDir) ?? Promise.resolve()
  const run = previous.then(fn, fn)
  const tail = run.catch(() => undefined)
  queues.set(commonDir, tail)
  void tail.then(() => {
    if (queues.get(commonDir) === tail) queues.delete(commonDir)
  })
  return run
}
