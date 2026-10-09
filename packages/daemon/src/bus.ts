/**
 * Bus en proceso: cada evento persistido en `events` se publica aquí con su
 * `event_seq`, y las suscripciones IPC lo reenvían (ADR-0005 §4). La verdad es
 * la tabla; el bus sólo evita que los suscriptores hagan polling.
 */
import type { EventNotification } from "@keel/core"

export type BusListener = (n: EventNotification) => void

export class EventBus {
  private readonly listeners = new Set<BusListener>()
  subscribe(l: BusListener): () => void {
    this.listeners.add(l)
    return () => this.listeners.delete(l)
  }
  publish(n: EventNotification): void {
    for (const l of this.listeners) {
      try {
        l(n)
      } catch {
        // un suscriptor roto no frena a los demás
      }
    }
  }
  get size(): number {
    return this.listeners.size
  }
}
