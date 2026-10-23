import {
  ErrorResponse,
  type EventNotification,
  EventNotification as EventSchema,
  type MethodName,
  Methods,
  Notification,
  request,
  SuccessResponse,
} from "@keel/core"
import { invoke, isTauri } from "@tauri-apps/api/core"
import { listen, type UnlistenFn } from "@tauri-apps/api/event"

export interface Wire {
  connect(path: string): Promise<void>
  exchange(frame: unknown): Promise<unknown>
  onEvent(handler: (raw: unknown) => void): Promise<() => void>
  disconnect(): Promise<void>
}

/** Sólo el shell nativo abre el socket (ADR-0003/0005). Sin servidor HTTP auxiliar. */
export class NativeWire implements Wire {
  async connect(path: string) {
    await invoke("ipc_connect", { path })
  }
  exchange(frame: unknown) {
    return invoke<unknown>("ipc_request", { frame })
  }
  async onEvent(handler: (raw: unknown) => void) {
    const unsubscribe: UnlistenFn = await listen("keel://notification", (event) =>
      handler(event.payload),
    )
    return unsubscribe
  }
  async disconnect() {
    await invoke("ipc_disconnect")
  }
}

export const hasNativeShell = () => isTauri()

/** Arranca el daemon si nadie escucha en `path` (ADR-0019 §1): `running` o `started`. */
export function ensureDaemon(path: string): Promise<string> {
  return invoke<string>("daemon_ensure", { path })
}

/** Ruta del daemon por defecto, la misma que usa el daemon; sólo el shell nativo la conoce. */
export function defaultSocketPath(): Promise<string> {
  return invoke<string>("ipc_default_path")
}
export class KeelClient {
  private readonly wire: Wire
  constructor(wire: Wire) {
    this.wire = wire
  }
  connect(path: string) {
    return this.wire.connect(path)
  }
  disconnect() {
    return this.wire.disconnect()
  }
  async call<M extends MethodName>(
    method: M,
    params: unknown,
  ): Promise<ReturnType<(typeof Methods)[M]["result"]["parse"]>> {
    const checked = Methods[method].params.parse(params)
    const outgoing = request(crypto.randomUUID(), method, checked)
    const raw = await this.wire.exchange(outgoing)
    const failure = ErrorResponse.safeParse(raw)
    // El error lleva el código y los detalles del daemon (p. ej., `cursor_expired`).
    if (failure.success)
      throw Object.assign(new Error(failure.data.error.message), { rpc: failure.data.error })
    const result = SuccessResponse.parse(raw)
    if (result.id !== outgoing.id) throw new Error("Respuesta IPC sin correlación con la solicitud")
    return Methods[method].result.parse(result.result) as ReturnType<
      (typeof Methods)[M]["result"]["parse"]
    >
  }
  subscribe(handler: (event: EventNotification) => void) {
    return this.wire.onEvent((raw) => {
      const frame = Notification.safeParse(raw)
      if (!frame.success || frame.data.method !== "events.event") return
      const parsed = EventSchema.safeParse(frame.data.params)
      if (parsed.success) handler(parsed.data)
    })
  }
}
export function mutationMeta(revision?: number) {
  return {
    request_id: crypto.randomUUID(),
    idempotency_key: crypto.randomUUID(),
    ...(revision === undefined ? {} : { expected_revision: revision }),
  }
}
