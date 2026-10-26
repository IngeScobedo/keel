/**
 * Puente de las pruebas e2e hacia un daemon real (SQLite, git y socket reales;
 * proveedores dobles). El shell de Tauri se sustituye por un puente en el
 * proceso de Playwright que abre el mismo socket y reenvía las mismas tramas
 * que `src-tauri/src/transport.rs`; la GUI no nota la diferencia.
 */
import { type ChildProcess, spawn } from "node:child_process"
import { createConnection, type Socket } from "node:net"
import { join } from "node:path"
import { createInterface } from "node:readline"
import type { Page } from "@playwright/test"

const FIXTURE = join(import.meta.dirname, "..", "..", "daemon", "test", "fixtures", "e2e-daemon.ts")

export type Daemon = { proc: ChildProcess; socket: string; project_id: string; other_repo: string }
export async function bootDaemon(env: Record<string, string> = {}): Promise<Daemon> {
  const proc = spawn("bun", [FIXTURE], {
    stdio: ["pipe", "pipe", "inherit"],
    env: { ...process.env, ...env },
  })
  const line = await new Promise<string>((resolve, reject) => {
    const rl = createInterface({ input: proc.stdout as NodeJS.ReadableStream })
    rl.once("line", resolve)
    proc.once("exit", (code) => reject(new Error(`el daemon salió con ${code}`)))
  })
  return {
    proc,
    ...(JSON.parse(line) as { socket: string; project_id: string; other_repo: string }),
  }
}

/** Cliente NDJSON mínimo: el mismo que usa el shell nativo, sin lógica. */
export class Line {
  private buf = ""
  private waiting = new Map<string, (m: Record<string, unknown>) => void>()
  readonly sock: Socket
  constructor(sock: Socket, onNotification: (m: unknown) => void) {
    this.sock = sock
    sock.setEncoding("utf8")
    sock.on("data", (chunk: string) => {
      this.buf += chunk
      for (let i = this.buf.indexOf("\n"); i >= 0; i = this.buf.indexOf("\n")) {
        const raw = this.buf.slice(0, i)
        this.buf = this.buf.slice(i + 1)
        if (!raw.trim()) continue
        const m = JSON.parse(raw) as Record<string, unknown>
        const id = m.id as string | undefined
        if (id !== undefined && this.waiting.has(id)) {
          this.waiting.get(id)?.(m)
          this.waiting.delete(id)
        } else onNotification(m)
      }
    })
  }
  static open(path: string, onNotification: (m: unknown) => void = () => {}) {
    return new Promise<Line>((resolve, reject) => {
      const sock = createConnection(path, () => resolve(new Line(sock, onNotification)))
      sock.once("error", reject)
    })
  }
  send(frame: { id: string }) {
    const p = new Promise<Record<string, unknown>>((r) => this.waiting.set(frame.id, r))
    this.sock.write(`${JSON.stringify(frame)}\n`)
    return p
  }
  async call(method: string, params: Record<string, unknown> = {}) {
    const m = await this.send({
      jsonrpc: "2.0",
      keel_protocol: 1,
      id: crypto.randomUUID(),
      method,
      params,
    } as { id: string })
    if (m.error) throw new Error((m.error as { message: string }).message)
    return m.result as Record<string, unknown>
  }
}
export const meta = () => ({
  request_id: crypto.randomUUID(),
  idempotency_key: crypto.randomUUID(),
})

/** Sustituye `__TAURI_INTERNALS__` por un puente hacia el socket real. */
export async function nativeShell(page: Page, daemon: Daemon) {
  let line: Line | null = null
  await page.exposeFunction(
    "__keelNative",
    async (command: string, args: { path?: string; frame?: { id: string } }) => {
      if (command === "ipc_default_path") return daemon.socket
      if (command === "daemon_ensure") return "running"
      if (command === "ipc_connect") {
        line?.sock.destroy()
        line = await Line.open(args.path as string, (frame) => {
          void page.evaluate(
            (f) => (window as unknown as { __keelPush(f: unknown): void }).__keelPush(f),
            frame,
          )
        })
        return null
      }
      if (command === "ipc_disconnect") {
        line?.sock.destroy()
        line = null
        return null
      }
      if (command === "ipc_request") {
        if (!line) throw new Error("Daemon no conectado")
        return line.send(args.frame as { id: string })
      }
      throw new Error(`comando desconocido ${command}`)
    },
  )
  await page.addInitScript(() => {
    const callbacks = new Map<number, (event: unknown) => void>()
    let handler = 0
    let next = 0
    const native = window as unknown as { __keelNative(c: string, a: unknown): Promise<unknown> }
    Object.assign(window, {
      isTauri: true,
      __keelPush(frame: unknown) {
        callbacks.get(handler)?.({ payload: frame })
      },
      __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener() {} },
      __TAURI_INTERNALS__: {
        transformCallback(callback: (event: unknown) => void) {
          const id = ++next
          callbacks.set(id, callback)
          return id
        },
        async invoke(command: string, args: Record<string, unknown>) {
          if (command === "plugin:event|listen") {
            handler = Number(args.handler)
            return 1
          }
          if (command === "plugin:event|unlisten") return undefined
          return native.__keelNative(command, args)
        },
      },
    })
  })
}
