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
  AGENT_METHODS,
  type AgentScope,
  decodeFrame,
  ErrorCode,
  type EventNotification,
  encodeFrame,
  type Frame,
  failure,
  type JsonRpcId,
  METHOD_SCOPE,
  type MethodName,
  notification,
  PENDING_METHODS,
  type RpcError,
  success,
  UNBOUND_METHODS,
  validateParams,
} from "@keel/core"
import type { Socket } from "bun"
import type { EventBus } from "../bus.js"
import type { Repo } from "../store/repo.js"
import { isNamedPipe } from "./endpoint.js"
import { LineDecoder, LineWriter } from "./framing.js"

/**
 * Quién habla por una conexión. Por defecto, el usuario local (ADR-0005 §7).
 * `session.bind_agent` la convierte en `agent` hasta que se cierra (ADR-0009 §2).
 */
export type Actor =
  | { actor_id: string; kind: "human" | "system" }
  | {
      actor_id: string
      kind: "agent"
      /** null para una sesión externa emparejada (ADR-0009 §4). */
      run_id: string | null
      project_id: string
      /** La tarea vinculada; una sesión externa puede no tener. */
      work_item_id: string | null
      scopes: readonly AgentScope[]
      pairing_id: string | null
    }
  /** Pidió `session.pair` y espera al humano: sólo `PENDING_METHODS`. */
  | { actor_id: string; kind: "pending"; pairing_id: string }
  /** Entró por la puerta de agentes y no se ha vinculado: sólo `UNBOUND_METHODS` (ADR-0018 §2). */
  | { actor_id: string; kind: "unbound" }
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
  /** Fijado por `session.bind_agent`; sin él, la conexión es del actor del servidor. */
  actor?: Actor
  /** Proyecto abierto por el humano en esta conexión (ADR-0019 §2). */
  project_id?: string
}

export const MAX_QUEUED_BYTES = 32 * 1024 * 1024
export const REPLAY_PAGE_SIZE = 1000

export type IpcServerOptions = {
  socketPath: string
  repo: Repo
  bus: EventBus
  handlers: Handlers
  actorId?: string
  /** Al cerrarse una conexión (p. ej., para cerrar su emparejamiento). */
  onClose?: (state: ClientState) => void
  /**
   * `agent`: la puerta de agentes (ADR-0018 §2). Ninguna conexión que entra por
   * ella es humana, ni siquiera antes de vincularse.
   */
  door?: "human" | "agent"
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
    const pipe = isNamedPipe(path)
    if (!pipe) {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
      if (existsSync(path)) unlinkSync(path)
    }
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
          if (this.opts.door === "agent")
            state.actor = { actor_id: `agent-door:${state.id}`, kind: "unbound" }
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
    // En POSIX la frontera es el modo del socket; un Named Pipe no es un archivo (endpoint.ts).
    if (!pipe) chmodSync(path, 0o600)
  }

  stop(): void {
    for (const c of [...this.clients]) {
      this.dropClient(c)
      c.socket.end()
    }
    this.server?.stop(true)
    this.server = null
    if (!isNamedPipe(this.opts.socketPath) && existsSync(this.opts.socketPath))
      unlinkSync(this.opts.socketPath)
  }

  private dropClient(state: ClientState): void {
    if (state.closed) return
    state.closed = true
    for (const s of state.subscriptions.values()) s.unsubscribe()
    state.subscriptions.clear()
    this.clients.delete(state)
    try {
      this.opts.onClose?.(state)
    } catch (e) {
      console.error("keel: onClose de una conexión falló", e)
    }
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
      // La autoridad va antes que la validación: a un agente no se le describe lo que no puede usar.
      this.authorize(frame.method, state)
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
    const ctx: HandlerContext = { actor: state.actor ?? this.actor, client: state }
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

  /**
   * Un actor `agent` sólo usa `AGENT_METHODS` y lo que sus scopes permiten
   * (ADR-0009 §5); uno `pending`, sólo `PENDING_METHODS`. El resto se
   * comprueba en cada handler, recurso por recurso.
   */
  private authorize(method: string, state: ClientState): void {
    const actor = state.actor
    const deny = (message: string) => {
      throw new RpcFailure({ code: ErrorCode.unauthorized, message, retryable: false })
    }
    if (actor?.kind === "unbound" && !(UNBOUND_METHODS as readonly string[]).includes(method))
      deny(`la puerta de agentes sólo admite vincularse o emparejarse; no ${method} (ADR-0018 §2)`)
    if (actor?.kind === "pending" && !(PENDING_METHODS as readonly string[]).includes(method))
      deny(`la sesión espera la aprobación del humano; no puede usar ${method} (ADR-0009 §4)`)
    if (actor?.kind !== "agent") return
    if (!(AGENT_METHODS as readonly string[]).includes(method))
      deny(`un agente no puede usar ${method} (ADR-0009 §5)`)
    const scope = METHOD_SCOPE[method as MethodName]
    if (scope && !actor.scopes.includes(scope))
      deny(`la sesión no tiene el scope ${scope} para ${method}`)
  }

  /** Notificación a una sola conexión (p. ej., `session.paired`). */
  notifyClient(state: ClientState, method: string, params: unknown): void {
    if (!state.closed) this.send(state, notification(method, params))
  }

  /** Snapshot + replay desde el cursor + stream en vivo (ADR-0005 §4). */
  private subscribe(p: { project_id?: string; after_event_seq: number }, state: ClientState) {
    const repo = this.opts.repo
    const subscriptionId = `sub-${state.id}-${state.subscriptions.size + 1}`
    const projectId = p.project_id ?? null
    // ADR-0012 §8: un cursor anterior a una purga no recibe una historia con huecos.
    const floor = repo.purgeFloor(projectId)
    if (floor > 0 && p.after_event_seq < floor)
      throw new RpcFailure({
        code: ErrorCode.cursorExpired,
        message: `cursor_expired: la historia anterior a ${floor} se purgó; resincroniza desde un snapshot`,
        retryable: true,
        details: { min_cursor: floor },
      })
    const workItems = projectId
      ? repo.listWorkItems(projectId).map((w) => repo.workItemView(w))
      : []
    const runs = projectId ? repo.listRuns(projectId).map((r) => repo.runView(r)) : []
    // Tras una purga que lo borró todo, el cursor no retrocede por debajo de ella.
    const cursor = Math.max(repo.lastEventSeq(), floor)
    // Un cursor por delante del último evento significa «desde ahora»: no se puede
    // saltar el futuro. Replay paginado de lo que el cliente no vio, hasta el cursor
    // capturado; luego el bus. Todo es síncrono, así que ningún evento se publica
    // entre el final del replay y el alta en el bus.
    let last = Math.min(p.after_event_seq, cursor)
    while (!state.closed) {
      const page = repo.eventsAfter(last, projectId, REPLAY_PAGE_SIZE, cursor)
      for (const e of page) this.send(state, notification("events.event", this.toNotification(e)))
      if (page.length < REPLAY_PAGE_SIZE) break
      last = (page.at(-1) as (typeof page)[number]).event_seq
    }
    last = cursor
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
