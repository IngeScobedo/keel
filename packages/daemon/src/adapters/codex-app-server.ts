/**
 * Transporte `app_server` de Codex (ADR-0008 §1, spike del 2026-10-22): Keel
 * lanza un `codex app-server` por run y le habla JSON-RPC por stdio, una línea
 * por mensaje (el esquema generado no lleva el campo `jsonrpc`).
 *
 * Lo medido con codex-cli 0.162.1 que fija este módulo:
 * - Keel posee el proceso: conoce su pid y lo reconcilia como a Claude.
 * - `turn/interrupt` cierra el turno, pero el comando en curso sigue vivo
 *   hasta que el app-server sale. Cancelar = interrumpir y cerrar.
 * - Los errores traen `codexErrorInfo` con código (`errorCodeFromInfo`).
 * - El servidor puede pedir cosas al cliente. Keel sólo atiende aprobaciones;
 *   `account/chatgptAuthTokens/refresh` y lo desconocido reciben error
 *   (ADR-0002: Keel nunca maneja credenciales).
 */
import { type ChildProcess, spawn } from "node:child_process"
import { LineDecoder } from "../ipc/framing.js"

type Json = Record<string, unknown>
type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void; method: string }

/** Atiende una petición del servidor; devolver `undefined` responde «no soportado». */
export type ServerRequestHandler = (method: string, params: Json) => Promise<unknown> | unknown

export class AppServerError extends Error {
  readonly method: string
  readonly error: Json
  constructor(method: string, error: Json) {
    super(`${method}: ${String(error.message ?? JSON.stringify(error))}`)
    this.method = method
    this.error = error
  }
}

export type AppServerLaunch = { command: string; args: string[]; env: Record<string, string> }

export class AppServerClient {
  readonly child: ChildProcess
  readonly exited: Promise<{ code: number | null; signal: string | null }>
  private nextId = 1
  private readonly pending = new Map<number, Pending>()
  private readonly listeners: ((method: string, params: Json) => void)[] = []
  private handler: ServerRequestHandler = () => undefined
  private stderrTail = ""
  private closed = false

  constructor(launch: AppServerLaunch) {
    this.child = spawn(launch.command, launch.args, {
      env: launch.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    })
    this.exited = new Promise((resolve) => {
      this.child.once("exit", (code, signal) => {
        this.closed = true
        for (const p of this.pending.values())
          p.reject(new Error(`codex app-server salió (${code ?? signal}) durante ${p.method}`))
        this.pending.clear()
        resolve({ code, signal })
      })
      this.child.once("error", (e) => {
        this.closed = true
        for (const p of this.pending.values()) p.reject(e)
        this.pending.clear()
        resolve({ code: null, signal: null })
      })
    })
    const decoder = new LineDecoder()
    this.child.stdout?.on("data", (chunk: Buffer) => {
      for (const d of decoder.push(new Uint8Array(chunk))) if (d.ok) this.onLine(d.line)
    })
    this.child.stderr?.on("data", (b: Buffer) => {
      this.stderrTail = (this.stderrTail + b.toString("utf8")).slice(-8192)
    })
  }

  get pid(): number | undefined {
    return this.child.pid
  }

  get stderr(): string {
    return this.stderrTail
  }

  onNotification(l: (method: string, params: Json) => void): void {
    this.listeners.push(l)
  }

  onServerRequest(h: ServerRequestHandler): void {
    this.handler = h
  }

  request<T = Json>(method: string, params: Json = {}): Promise<T> {
    if (this.closed) return Promise.reject(new Error(`codex app-server cerrado (${method})`))
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, method })
      this.send({ id, method, params })
    })
  }

  notify(method: string, params?: Json): void {
    this.send(params === undefined ? { method } : { method, params })
  }

  /**
   * Cierra stdin y espera la salida; si no sale en `graceMs`, SIGKILL. Al salir
   * el app-server, sus comandos mueren con él (spike, pruebas 5 y 6).
   */
  async close(graceMs = 5_000): Promise<{ code: number | null; signal: string | null }> {
    if (!this.closed) {
      try {
        this.child.stdin?.end()
      } catch {}
      const timer = setTimeout(() => this.child.kill("SIGKILL"), graceMs)
      const out = await this.exited
      clearTimeout(timer)
      return out
    }
    return this.exited
  }

  private send(msg: Json): void {
    if (this.closed) return
    this.child.stdin?.write(`${JSON.stringify(msg)}\n`)
  }

  private onLine(line: string): void {
    let msg: Json
    try {
      msg = JSON.parse(line) as Json
    } catch {
      return
    }
    const id = msg.id as number | string | undefined
    const method = msg.method as string | undefined
    if (method !== undefined && id !== undefined) {
      void this.answer(id, method, (msg.params ?? {}) as Json)
      return
    }
    if (method !== undefined) {
      for (const l of this.listeners) l(method, (msg.params ?? {}) as Json)
      return
    }
    if (typeof id !== "number") return
    const p = this.pending.get(id)
    if (!p) return
    this.pending.delete(id)
    if (msg.error) p.reject(new AppServerError(p.method, msg.error as Json))
    else p.resolve(msg.result)
  }

  private async answer(id: number | string, method: string, params: Json): Promise<void> {
    try {
      const result = await this.handler(method, params)
      if (result === undefined)
        this.send({ id, error: { code: -32601, message: `Keel no atiende ${method}` } })
      else this.send({ id, result })
    } catch (e) {
      this.send({
        id,
        error: { code: -32603, message: e instanceof Error ? e.message : String(e) },
      })
    }
  }
}

/**
 * `codexErrorInfo` → código de `classifyRunOutcome`. Medido: sin sesión llega
 * `httpConnectionFailed { httpStatusCode: 401 }`, no `unauthorized`.
 */
export function errorCodeFromInfo(info: unknown): string | null {
  if (typeof info === "string") {
    const byName: Record<string, string> = {
      unauthorized: "authentication_failed",
      usageLimitExceeded: "rate_limit",
      rateLimitExceeded: "rate_limit",
      serverOverloaded: "overloaded",
      internalServerError: "server_error",
      badRequest: "invalid_request",
      contextWindowExceeded: "context_window_exceeded",
      sessionBudgetExceeded: "session_budget_exceeded",
      sandboxError: "sandbox_error",
      cyberPolicy: "policy_violation",
      misalignmentPolicyViolation: "policy_violation",
      tooManyDenials: "too_many_denials",
    }
    return byName[info] ?? null
  }
  if (info && typeof info === "object") {
    const [kind, detail] = Object.entries(info as Json)[0] ?? []
    const status = (detail as { httpStatusCode?: number } | undefined)?.httpStatusCode
    if (status === 401 || status === 403) return "authentication_failed"
    if (status === 429) return "rate_limit"
    if (status !== undefined && status >= 500) return "server_error"
    if (kind) return `codex_${kind}`
  }
  return null
}

/** Valor TOML para un override `-c clave=valor` (las cadenas TOML básicas escapan como JSON). */
export function tomlValue(v: unknown): string {
  if (typeof v === "string") return JSON.stringify(v)
  if (typeof v === "number" || typeof v === "boolean") return String(v)
  if (Array.isArray(v)) return `[${v.map(tomlValue).join(", ")}]`
  if (v && typeof v === "object")
    return `{ ${Object.entries(v as Json)
      .map(([k, x]) => `${JSON.stringify(k)} = ${tomlValue(x)}`)
      .join(", ")} }`
  throw new Error(`valor no representable en TOML: ${String(v)}`)
}
