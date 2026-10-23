/**
 * Cliente mínimo de `codex app-server` por stdio: JSON-RPC en NDJSON, sin el
 * campo `jsonrpc` (el esquema generado no lo pide). Graba cada línea, en ambos
 * sentidos, en captures/ (gitignored). Los nombres de métodos y campos salen
 * del esquema de `codex app-server generate-json-schema` (codex-cli 0.162.1).
 */
import { appendFileSync, mkdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import type { Subprocess } from "bun"

const here = dirname(fileURLToPath(import.meta.url))
export const capturesDir = join(here, "..", "captures")

type Json = Record<string, unknown>
type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void; method: string }
export type ServerRequestHandler = (method: string, params: Json) => Promise<unknown> | unknown

export class RpcError extends Error {
  readonly method: string
  readonly error: Json
  constructor(method: string, error: Json) {
    super(`${method}: ${JSON.stringify(error)}`)
    this.method = method
    this.error = error
  }
}

export type ClientOptions = {
  label: string
  env?: Record<string, string>
  args?: string[]
  onServerRequest?: ServerRequestHandler
}

export class AppServerClient {
  readonly proc: Subprocess<"pipe", "pipe", "pipe">
  readonly notifications: { at: number; method: string; params: Json }[] = []
  readonly serverRequests: { at: number; method: string; params: Json }[] = []
  readonly stderr: string[] = []
  readonly capture: string
  private nextId = 1
  private readonly pending = new Map<number, Pending>()
  private readonly waiters: {
    match: (m: string, p: Json) => boolean
    resolve: (p: Json) => void
  }[] = []
  private closed = false
  readonly exited: Promise<number | null>

  private readonly opts: ClientOptions

  constructor(opts: ClientOptions) {
    this.opts = opts
    mkdirSync(capturesDir, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, "-")
    this.capture = join(capturesDir, `${stamp}-${opts.label}.ndjson`)
    const env = { ...process.env, ...(opts.env ?? {}) } as Record<string, string>
    this.proc = Bun.spawn(["codex", "app-server", ...(opts.args ?? [])], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env,
    })
    this.exited = this.proc.exited.then((code) => {
      this.closed = true
      this.log("exit", { code })
      for (const p of this.pending.values()) p.reject(new Error(`app-server salió (${code})`))
      return code
    })
    void this.readStdout()
    void this.readStderr()
  }

  get pid(): number {
    return this.proc.pid
  }

  private log(dir: string, msg: unknown): void {
    appendFileSync(this.capture, `${JSON.stringify({ t: Date.now(), dir, msg })}\n`)
  }

  private send(msg: Json): void {
    this.log("out", msg)
    this.proc.stdin.write(`${JSON.stringify(msg)}\n`)
    this.proc.stdin.flush()
  }

  private async readStdout(): Promise<void> {
    const decoder = new TextDecoder()
    let buf = ""
    for await (const chunk of this.proc.stdout) {
      buf += decoder.decode(chunk, { stream: true })
      let nl = buf.indexOf("\n")
      while (nl >= 0) {
        const line = buf.slice(0, nl).trim()
        buf = buf.slice(nl + 1)
        if (line) this.onLine(line)
        nl = buf.indexOf("\n")
      }
    }
  }

  private async readStderr(): Promise<void> {
    const decoder = new TextDecoder()
    for await (const chunk of this.proc.stderr) {
      const text = decoder.decode(chunk)
      this.stderr.push(text)
      this.log("stderr", text)
    }
  }

  private onLine(line: string): void {
    let msg: Json
    try {
      msg = JSON.parse(line) as Json
    } catch {
      this.log("in-unparsed", line)
      return
    }
    this.log("in", msg)
    const id = msg.id as number | string | undefined
    const method = msg.method as string | undefined
    if (method !== undefined && id !== undefined) {
      void this.answer(id, method, (msg.params ?? {}) as Json)
      return
    }
    if (method !== undefined) {
      const params = (msg.params ?? {}) as Json
      this.notifications.push({ at: Date.now(), method, params })
      for (let i = this.waiters.length - 1; i >= 0; i--) {
        const w = this.waiters[i]
        if (w?.match(method, params)) {
          this.waiters.splice(i, 1)
          w.resolve(params)
        }
      }
      return
    }
    if (typeof id === "number") {
      const p = this.pending.get(id)
      if (!p) return
      this.pending.delete(id)
      if (msg.error) p.reject(new RpcError(p.method, msg.error as Json))
      else p.resolve(msg.result)
    }
  }

  private async answer(id: number | string, method: string, params: Json): Promise<void> {
    this.serverRequests.push({ at: Date.now(), method, params })
    const handler = this.opts.onServerRequest
    if (!handler) {
      this.send({ id, error: { code: -32601, message: `el probe no atiende ${method}` } })
      return
    }
    try {
      const result = await handler(method, params)
      if (result === undefined) {
        this.send({ id, error: { code: -32601, message: `el probe no atiende ${method}` } })
      } else {
        this.send({ id, result })
      }
    } catch (e) {
      this.send({ id, error: { code: -32603, message: String(e) } })
    }
  }

  request<T = Json>(method: string, params: Json = {}): Promise<T> {
    if (this.closed) return Promise.reject(new Error("app-server cerrado"))
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, method })
      this.send({ id, method, params })
    })
  }

  notify(method: string, params?: Json): void {
    this.send(params === undefined ? { method } : { method, params })
  }

  /** Espera una notificación que cumpla `match`, o falla tras `ms`. */
  waitFor(method: string, ms: number, match: (p: Json) => boolean = () => true): Promise<Json> {
    const seen = this.notifications.find((n) => n.method === method && match(n.params))
    if (seen) return Promise.resolve(seen.params)
    return new Promise<Json>((resolve, reject) => {
      const w = { match: (m: string, p: Json) => m === method && match(p), resolve }
      this.waiters.push(w)
      setTimeout(() => {
        const i = this.waiters.indexOf(w)
        if (i >= 0) {
          this.waiters.splice(i, 1)
          reject(new Error(`timeout esperando ${method}`))
        }
      }, ms)
    })
  }

  async initialize(experimental = false): Promise<Json> {
    const result = await this.request("initialize", {
      clientInfo: { name: "keel-spike", title: "Keel spike", version: "0.0.0" },
      capabilities: { experimentalApi: experimental },
    })
    this.notify("initialized")
    return result
  }

  methodCounts(): Record<string, number> {
    const counts: Record<string, number> = {}
    for (const n of this.notifications) counts[n.method] = (counts[n.method] ?? 0) + 1
    return counts
  }

  async close(): Promise<number | null> {
    if (!this.closed) {
      try {
        this.proc.stdin.end()
      } catch {}
      const timer = setTimeout(() => this.proc.kill("SIGKILL"), 5000)
      const code = await this.exited
      clearTimeout(timer)
      return code
    }
    return this.exited
  }
}
