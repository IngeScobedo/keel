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
import { LineDecoder, LineWriter } from "./framing.js"

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
  decoder: LineDecoder
  writer: LineWriter
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
            decoder: new LineDecoder(),
            writer: new LineWriter(),
            subscriptions: new Map(),
            closed: false,
          }
          socket.data = state
          this.clients.add(state)
        },
        data: (socket, chunk) => {
          const state = socket.data
          for (const d of state.decoder.push(chunk)) {
            if (d.ok) void this.handleLine(state, d.line)
            else this.send(state, failure(null, framingError(d.reason, d.bytes)))
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
    state.writer.enqueue(encodeFrame(frame))
    if (state.writer.queuedBytes > MAX_QUEUED_BYTES) {
      state.writer.clear()
      state.writer.enqueue(
        encodeFrame(
          failure(null, {
            code: ErrorCode.backpressure,
            message: "cliente demasiado lento; conexión cerrada",
            retryable: true,
          }),
        ),
      )
      this.flush(state)
      state.socket.end()
      this.dropClient(state)
      return
    }
    this.flush(state)
  }

  private flush(state: ClientState): void {
    if (state.closed) return
    state.writer.flush((bytes) => state.socket.write(bytes))
  }

  /**
   * Nunca rechaza: se invoca sin `await` desde el callback del socket, y una
   * promesa rechazada ahí tumba el proceso. Todo fallo, también el de validar,
   * se convierte en una respuesta de error para ese `id`.
   */
  private async handleLine(state: ClientState, line: string): Promise<void> {
    let id: JsonRpcId | null = null
    try {
      const decoded = decodeFrame(line)
      if (!decoded.ok) {
        this.send(state, failure(decoded.id, decoded.error))
        return
      }
      const frame = decoded.frame
      if (!("method" in frame)) return // respuestas de cliente: no se esperan
      id = "id" in frame ? frame.id : null
      const v = validateParams(frame.method, frame.params)
      if (!v.ok) {
        if (id !== null) this.send(state, failure(id, v.error))
        return
      }
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
    const h = Object.hasOwn(this.opts.handlers, method) ? this.opts.handlers[method] : undefined
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
    // Un cursor por delante del último evento significa «desde ahora»: no se puede
    // saltar el futuro. Replay de lo que el cliente no vio; luego el bus.
    let last = Math.min(p.after_event_seq, cursor)
    for (const e of repo.eventsAfter(last, projectId)) {
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

function framingError(reason: "frame_too_large" | "invalid_utf8", bytes: number): RpcError {
  return reason === "frame_too_large"
    ? {
        code: ErrorCode.frameTooLarge,
        message: `frame de al menos ${bytes} bytes supera el tope; descartado hasta el siguiente salto de línea`,
        retryable: false,
      }
    : { code: ErrorCode.parseError, message: "frame con UTF-8 inválido", retryable: false }
}
