/**
 * Cliente mínimo del protocolo (ADR-0005) para la CLI y los tests: NDJSON por
 * socket Unix, promesas por `id`, notificaciones por callback.
 */
import {
  decodeFrame,
  type EventNotification,
  encodeFrame,
  type Frame,
  type JsonRpcId,
  type MethodName,
  request,
} from "@keel/core"
import type { Socket } from "bun"

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void }

export class IpcClient {
  private socket: Socket<undefined> | null = null
  private buffer = ""
  private nextId = 1
  private readonly pending = new Map<JsonRpcId, Pending>()
  private readonly listeners = new Set<(method: string, params: unknown) => void>()
  private closed = false

  static async connect(path: string): Promise<IpcClient> {
    const c = new IpcClient()
    c.socket = await Bun.connect<undefined>({
      unix: path,
      socket: {
        data: (_s, chunk) => c.onData(chunk.toString()),
        close: () => c.onClose(),
        error: (_s, e) => c.onClose(e),
      },
    })
    return c
  }

  onNotification(l: (method: string, params: unknown) => void): () => void {
    this.listeners.add(l)
    return () => this.listeners.delete(l)
  }

  onEvent(l: (n: EventNotification) => void): () => void {
    return this.onNotification((m, p) => {
      if (m === "events.event") l(p as EventNotification)
    })
  }

  call<T = unknown>(method: MethodName, params: unknown): Promise<T> {
    if (!this.socket || this.closed) return Promise.reject(new Error("socket cerrado"))
    const id = this.nextId++
    const frame = request(id, method, params)
    const p = new Promise<T>((resolve, reject) =>
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject }),
    )
    this.socket.write(`${encodeFrame(frame)}\n`)
    return p
  }

  /** Manda una línea cruda (para probar errores de protocolo). */
  raw(line: string): void {
    this.socket?.write(`${line}\n`)
  }

  close(): void {
    this.closed = true
    this.socket?.end()
  }

  private onData(text: string): void {
    this.buffer += text
    let nl = this.buffer.indexOf("\n")
    while (nl >= 0) {
      const line = this.buffer.slice(0, nl)
      this.buffer = this.buffer.slice(nl + 1)
      if (line.trim()) this.onFrame(line)
      nl = this.buffer.indexOf("\n")
    }
  }

  private onFrame(line: string): void {
    const d = decodeFrame(line)
    if (!d.ok) {
      for (const l of this.listeners) l("protocol.error", d.error)
      return
    }
    const f: Frame = d.frame
    if ("method" in f) {
      for (const l of this.listeners) l(f.method, f.params)
      return
    }
    if (f.id === null) {
      for (const l of this.listeners) l("protocol.error", "error" in f ? f.error : null)
      return
    }
    const p = this.pending.get(f.id)
    if (!p) return
    this.pending.delete(f.id)
    if ("error" in f) p.reject(Object.assign(new Error(f.error.message), { rpc: f.error }))
    else p.resolve(f.result)
  }

  private onClose(e?: Error): void {
    this.closed = true
    for (const p of this.pending.values()) p.reject(e ?? new Error("conexión cerrada"))
    this.pending.clear()
  }
}
