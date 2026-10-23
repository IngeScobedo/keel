/**
 * Outbox transaccional (SDD 02 §2, SDD 03 `outbox`).
 *
 * Un efecto que debe ocurrir si y sólo si una transacción confirma (despachar
 * un run, liberar un worktree) se encola en `outbox` dentro de esa misma
 * transacción. Después del commit, y otra vez al arrancar el daemon, `drain()`
 * entrega lo pendiente. La entrega es **al menos una vez**: si el proceso cae
 * entre el efecto y la marca de entregado, el mensaje se repite, así que cada
 * handler es idempotente y deduplica por la clave estable del mensaje.
 *
 * Los tipos sin handler registrado se quedan pendientes, sin entregar: los
 * triggers del Contract Hub ya encolan `contract_*` y su consumidor llega en la
 * Fase 3. Marcarlos entregados sin consumirlos sería perderlos.
 */
import type { OutboxRow, Repo } from "./store/repo.js"

export type OutboxMessage = Omit<OutboxRow, "payload_json"> & { payload: unknown }
export type OutboxHandler = (msg: OutboxMessage) => Promise<void> | void

export class Outbox {
  private readonly repo: Repo
  private readonly handlers = new Map<string, OutboxHandler>()
  private draining: Promise<number> | null = null
  private again = false

  constructor(repo: Repo) {
    this.repo = repo
  }

  /** Registra el consumidor de un tipo. Debe ser idempotente: la entrega es al menos una vez. */
  on(eventType: string, handler: OutboxHandler): void {
    this.handlers.set(eventType, handler)
  }

  /**
   * Entrega todo lo pendiente con handler, en orden. Un handler que falla deja
   * su mensaje pendiente (con `attempts` incrementado) y no frena a los demás.
   * Llamadas concurrentes se coalescen en una pasada más.
   */
  drain(): Promise<number> {
    if (this.draining) {
      this.again = true
      return this.draining
    }
    const run = async (): Promise<number> => {
      let delivered = 0
      do {
        this.again = false
        for (const row of this.repo.pendingOutbox([...this.handlers.keys()])) {
          const handler = this.handlers.get(row.event_type)
          if (!handler) continue
          this.repo.markOutboxAttempt(row.id)
          try {
            await handler(toMessage(row))
            this.repo.markOutboxDelivered(row.id)
            delivered++
          } catch (e) {
            console.error(`keel: outbox ${row.dedupe_key} falló; queda pendiente`, e)
          }
        }
      } while (this.again)
      return delivered
    }
    this.draining = run().finally(() => {
      this.draining = null
    })
    return this.draining
  }
}

function toMessage(row: OutboxRow): OutboxMessage {
  const { payload_json, ...rest } = row
  return { ...rest, payload: JSON.parse(payload_json) as unknown }
}
