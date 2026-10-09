/**
 * Servidor IPC (ADR-0005): JSON-RPC 2.0 en NDJSON sobre socket Unix, un frame
 * por línea, suscripciones con cursor y backpressure por cliente.
 *
 * Identidad: viene de la conexión. Bun no expone las credenciales del peer del
 * socket Unix, así que la frontera hoy es el modo 0600 del socket en un
 * directorio 0700 del usuario (ADR-0005 §1 y §7). `actor_id` = usuario del
 * proceso del daemon hasta que exista algo mejor; queda anotado.
 */
import { chmodSync, existsSync, mkdirSync, unlinkSync } from "node:fs"
import { userInfo } from "node:os"
import { dirname } from "node:path"
import {
  decodeFrame,
  ErrorCode,
  type EventNotification,
  encodeFrame,
  type Frame,
  failure,
  type JsonRpcId,
  type MethodName,
  notification,
  type RpcError,
  success,
  validateParams,
} from "@keel/core"
import type { Socket } from "bun"
import type { EventBus } from "../bus.js"
import type { Repo } from "../store/repo.js"

export type Actor = { actor_id: string; kind: "human" | "system" }
export type HandlerContext = { actor: Actor; client: ClientState }
export type Handler = (params: unknown, ctx: HandlerContext) => Promise<unknown> | unknown
export type Handlers = Partial<Record<MethodName, Handler>>

export class RpcFailure extends Error {
  readonly rpc: RpcError
  constructor(rpc: RpcError) {
    super(rpc.message)
    this.rpc = rpc
  }
}

export type ClientState = {
  id: number
  socket: Socket<ClientState>
  buffer: string
  queue: string[]
  queuedBytes: number
  subscriptions: Map<string, { project_id: string | null; unsubscribe: () => void }>
  closed: boolean
}

export const MAX_QUEUED_BYTES = 32 * 1024 * 1024

export type IpcServerOptions = {
  socketPath: string
  repo: Repo
  bus: EventBus
  handlers: Handlers
  actorId?: string
}

export class IpcServer {
  private server: ReturnType<typeof Bun.listen<ClientState>> | null = null
  private nextClient = 1
  readonly clients = new Set<ClientState>()
  readonly actor: Actor

  private readonly opts: IpcServerOptions
  constructor(opts: IpcServerOptions) {
    this.opts = opts
    this.actor = { actor_id: opts.actorId ?? `user:${userInfo().username}`, kind: "human" }
  }

  get path(): string {
    return this.opts.socketPath
  }

  start(): void {
    const path = this.opts.socketPath
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    if (existsSync(path)) unlinkSync(path)
    this.server = Bun.listen<ClientState>({
      unix: path,
      socket: {
        open: (socket) => {
          const state: ClientState = {
            id: this.nextClient++,
            socket,
            buffer: "",
            queue: [],
            queuedBytes: 0,
            subscriptions: new Map(),
            closed: false,
          }
          socket.data = state
          this.clients.add(state)
        },
        data: (socket, chunk) => {
          const state = socket.data
          state.buffer += chunk.toString()
          let nl = state.buffer.indexOf("\n")
          while (nl >= 0) {
            const line = state.buffer.slice(0, nl)
            state.buffer = state.buffer.slice(nl + 1)
            if (line.trim().length > 0) void this.handleLine(state, line)
            nl = state.buffer.indexOf("\n")
          }
        },
        drain: (socket) => this.flush(socket.data),
        close: (socket) => this.dropClient(socket.data),
        error: (socket) => this.dropClient(socket.data),
      },
    })
    chmodSync(path, 0o600)
  }

  stop(): void {
    for (const c of [...this.clients]) {
      this.dropClient(c)
      c.socket.end()
    }
    this.server?.stop(true)
    this.server = null
    if (existsSync(this.opts.socketPath)) unlinkSync(this.opts.socketPath)
  }

  private dropClient(state: ClientState): void {
    if (state.closed) return
    state.closed = true
    for (const s of state.subscriptions.values()) s.unsubscribe()
    state.subscriptions.clear()
    this.clients.delete(state)
  }

  /** Escritura con cola: si el socket no drena, acumula hasta el tope y luego corta (backpressure, ADR-0005 §4). */
  send(state: ClientState, frame: Frame): void {
    if (state.closed) return
    const line = `${encodeFrame(frame)}\n`
    state.queue.push(line)
    state.queuedBytes += line.length
    if (state.queuedBytes > MAX_QUEUED_BYTES) {
      state.queue = [
        `${encodeFrame(failure(null, { code: ErrorCode.backpressure, message: "cliente demasiado lento; conexión cerrada", retryable: true }))}\n`,
      ]
      this.flush(state)
      state.socket.end()
      this.dropClient(state)
      return
    }
    this.flush(state)
  }

  private flush(state: ClientState): void {
    while (state.queue.length > 0 && !state.closed) {
      const line = state.queue[0] as string
      const written = state.socket.write(line)
      if (written < line.length) {
        state.queue[0] = line.slice(Math.max(0, written))
        state.queuedBytes -= Math.max(0, written)
        return
      }
      state.queue.shift()
      state.queuedBytes -= line.length
    }
  }

  private async handleLine(state: ClientState, line: string): Promise<void> {
    const decoded = decodeFrame(line)
    if (!decoded.ok) {
      this.send(state, failure(decoded.id, decoded.error))
      return
    }
    const frame = decoded.frame
    if (!("method" in frame)) return // respuestas de cliente: no se esperan
    const id: JsonRpcId | null = "id" in frame ? frame.id : null
    const v = validateParams(frame.method, frame.params)
    if (!v.ok) {
      if (id !== null) this.send(state, failure(id, v.error))
      return
    }
    try {
      const result = await this.dispatch(v.method, v.params, state)
      if (id !== null) this.send(state, success(id, result))
    } catch (e) {
      const err: RpcError =
        e instanceof RpcFailure
          ? e.rpc
          : {
              code: ErrorCode.internal,
              message: e instanceof Error ? e.message : String(e),
              retryable: false,
            }
      if (id !== null) this.send(state, failure(id, err))
    }
  }

  private async dispatch(
    method: MethodName,
    params: unknown,
    state: ClientState,
  ): Promise<unknown> {
    const ctx: HandlerContext = { actor: this.actor, client: state }
    if (method === "events.subscribe")
      return this.subscribe(params as { project_id?: string; after_event_seq: number }, state)
    if (method === "events.unsubscribe") {
      const { subscription_id } = params as { subscription_id: string }
      state.subscriptions.get(subscription_id)?.unsubscribe()
      state.subscriptions.delete(subscription_id)
      return { ok: true as const }
    }
    const h = this.opts.handlers[method]
    if (!h)
      throw new RpcFailure({
        code: ErrorCode.methodNotFound,
        message: `método sin implementar en este daemon: ${method}`,
        retryable: false,
      })
    return h(params, ctx)
  }

  /** Snapshot + replay desde el cursor + stream en vivo (ADR-0005 §4). */
  private subscribe(p: { project_id?: string; after_event_seq: number }, state: ClientState) {
    const repo = this.opts.repo
    const subscriptionId = `sub-${state.id}-${state.subscriptions.size + 1}`
    const projectId = p.project_id ?? null
    const workItems = projectId
      ? repo.listWorkItems(projectId).map((w) => repo.workItemView(w))
      : []
    const runs = projectId ? repo.listRuns(projectId).map((r) => repo.runView(r)) : []
    const cursor = repo.lastEventSeq()
    // Replay de lo que el cliente no vio; luego el bus. Lo que se publique entre el
    // replay y la suscripción se repone por `event_seq` en el cliente (dedupe por seq).
    let last = p.after_event_seq
    for (const e of repo.eventsAfter(p.after_event_seq, projectId)) {
      this.send(state, notification("events.event", this.toNotification(e)))
      last = e.event_seq
    }
    const unsubscribe = this.opts.bus.subscribe((n) => {
      if (projectId && n.project_id !== projectId) return
      if (n.event_seq <= last) return
      last = n.event_seq
      this.send(state, notification("events.event", n))
    })
    state.subscriptions.set(subscriptionId, { project_id: projectId, unsubscribe })
    return { subscription_id: subscriptionId, cursor, snapshot: { work_items: workItems, runs } }
  }

  toNotification(e: {
    event_seq: number
    kind: string
    project_id: string
    run_id: string | null
    received_at: string
    payload_json: string
  }): EventNotification {
    let payload: unknown
    try {
      payload = JSON.parse(e.payload_json)
    } catch {
      payload = e.payload_json
    }
    return {
      event_seq: e.event_seq,
      kind: e.kind,
      project_id: e.project_id,
      run_id: e.run_id,
      received_at: e.received_at,
      payload,
    }
  }
}
