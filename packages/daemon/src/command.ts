/**
 * Unidad de trabajo del daemon (ADR-0005 §3, SDD 03 `command_receipts`).
 *
 * Los cambios de dominio y sus eventos se escriben en una sola transacción
 * SQLite. Lo que sale del proceso (publicar en el bus, despachar un run) se
 * encola y sólo corre después del commit. En un comando del protocolo el
 * recibo de idempotencia entra en la misma transacción: si algo falla antes
 * del commit, no hay efectos ni recibo, y reintentar con la misma key rehace
 * la mutación una sola vez.
 */
import type { Database } from "bun:sqlite"
import { ErrorCode } from "@keel/core"
import type { EventBus } from "./bus.js"
import { ulid } from "./ids.js"
import { RpcFailure } from "./ipc/server.js"
import type { Repo } from "./store/repo.js"

export type UnitOfWork = {
  readonly actorId: string
  readonly projectId: string
  /** Añade un evento del daemon dentro de la transacción; se publica tras el commit. */
  emit(kind: string, runId: string | null, payload: unknown): void
  /** Efecto fuera de la base que sólo debe ocurrir si la transacción confirma. Se pierde si el proceso cae. */
  afterCommit(effect: () => void): void
  /**
   * Efecto durable: se guarda en `outbox` dentro de la transacción y se entrega
   * tras el commit o, si el proceso cae, al arrancar (outbox.ts).
   */
  enqueue(eventType: string, aggregateId: string, dedupeKey: string, payload: unknown): void
}

export type UnitOfWorkDeps = {
  db: Database
  repo: Repo
  bus: EventBus
  /** Si se da, se drena tras confirmar una transacción que encoló mensajes. */
  outbox?: { drain(): Promise<number> }
}
export type UnitOfWorkScope = { projectId: string; actorId: string }

/** Corre `fn` en una transacción `IMMEDIATE` y, si confirma, sus efectos en orden. */
export function runUnitOfWork<T>(
  deps: UnitOfWorkDeps,
  scope: UnitOfWorkScope,
  fn: (uow: UnitOfWork) => T,
): T {
  const { db, repo, bus } = deps
  const effects: (() => void)[] = []
  let enqueued = false
  const uow: UnitOfWork = {
    actorId: scope.actorId,
    projectId: scope.projectId,
    emit(kind, runId, payload) {
      const e = repo.appendEvent({
        project_id: scope.projectId,
        run_id: runId,
        source: "daemon",
        source_event_key: `${kind}:${ulid()}`,
        fidelity: "full",
        adapter_version: "daemon/0",
        kind,
        occurred_at: null,
        payload_json: JSON.stringify(payload),
      })
      if (e)
        effects.push(() =>
          bus.publish({
            event_seq: e.event_seq,
            kind,
            project_id: e.project_id,
            run_id: runId,
            received_at: e.received_at,
            payload,
          }),
        )
    },
    afterCommit(effect) {
      effects.push(effect)
    },
    enqueue(eventType, aggregateId, dedupeKey, payload) {
      repo.enqueueOutbox({
        project_id: scope.projectId,
        event_type: eventType,
        aggregate_id: aggregateId,
        dedupe_key: dedupeKey,
        payload,
      })
      enqueued = true
    },
  }
  const result = db.transaction(() => fn(uow)).immediate()
  if (enqueued && deps.outbox) {
    const outbox = deps.outbox
    effects.push(() => void outbox.drain())
  }
  for (const effect of effects) {
    try {
      effect()
    } catch (e) {
      // El cambio ya es durable; un efecto roto no lo deshace ni frena a los demás.
      console.error("keel: efecto posterior al commit falló", e)
    }
  }
  return result
}

export type CommandRequest = UnitOfWorkScope & { idempotencyKey: string; requestHash: string }

/**
 * Comando idempotente del protocolo. Con recibo y mismo hash devuelve el
 * resultado guardado sin volver a ejecutar ni repetir efectos; con otro hash
 * es `idempotencyMismatch`.
 */
export function runCommand<T>(
  deps: UnitOfWorkDeps,
  req: CommandRequest,
  fn: (uow: UnitOfWork) => T,
): T {
  return runUnitOfWork(deps, req, (uow) => {
    const receipt = deps.repo.getReceipt(req.projectId, req.actorId, req.idempotencyKey)
    if (receipt) {
      if (receipt.request_hash !== req.requestHash)
        throw new RpcFailure({
          code: ErrorCode.idempotencyMismatch,
          message: "idempotency_key reutilizada con otra request",
          retryable: false,
        })
      return JSON.parse(receipt.result_json) as T
    }
    const result = fn(uow)
    deps.repo.putReceipt(req.projectId, req.actorId, req.idempotencyKey, req.requestHash, result)
    return result
  })
}
