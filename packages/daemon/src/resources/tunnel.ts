/**
 * Túneles SSH hacia una base (ADR-0033): Keel los abre con las opciones de una conexión
 * SSH del vault, nunca con la config del humano. Con `ControlMaster` el reenvío quedaba en
 * su proceso maestro y el puerto seguía abierto al terminar (medido, spikes/db-tunnel).
 *
 * Un túnel vive lo que su uso: se reusa si llega otra consulta en menos de `IDLE_MS` y se
 * cierra solo después. El puerto es aleatorio y sólo en 127.0.0.1.
 */
import { type ChildProcess, spawn } from "node:child_process"
import { connect, createServer } from "node:net"

export const IDLE_MS = 60_000
const OPEN_TIMEOUT_MS = 20_000

export type TunnelTarget = { host: string; port: number }
export type SshPrep = { args: string[]; env: Record<string, string>; ssh: string }

type Entry = {
  port: number
  proc: ChildProcess
  users: number
  timer: ReturnType<typeof setTimeout> | null
  opened_ms: number
}

export class TunnelError extends Error {}

function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const s = createServer()
    s.once("error", fail)
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port
      s.close(() => done(port))
    })
  })
}

function listening(port: number): Promise<boolean> {
  return new Promise((done) => {
    const c = connect(port, "127.0.0.1")
    c.once("connect", () => {
      c.destroy()
      done(true)
    })
    c.once("error", () => done(false))
  })
}

/** Las opciones de la conexión, sin lo que sólo sirve para un comando interactivo. */
export function tunnelArgs(args: string[], local: number, target: TunnelTarget): string[] {
  const keep: string[] = []
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string
    if (a === "-T") continue
    keep.push(a)
  }
  return [
    ...keep,
    "-o",
    "ControlMaster=no",
    "-o",
    "ControlPath=none",
    "-o",
    "ExitOnForwardFailure=yes",
    "-o",
    "ServerAliveInterval=15",
    "-N",
    "-L",
    `127.0.0.1:${local}:${target.host}:${target.port}`,
  ]
}

export class TunnelPool {
  private readonly open = new Map<string, Entry>()
  private readonly pending = new Map<string, Promise<Entry>>()

  /**
   * Un puerto local hacia `target` por la conexión SSH. `key` agrupa lo que puede
   * compartir el túnel (el run y la conexión). Devuelve el puerto y cuánto costó abrirlo
   * (0 si se reusó); `release` lo deja vivo `IDLE_MS` por si llega otra consulta.
   */
  async acquire(
    key: string,
    host: string,
    target: TunnelTarget,
    prepare: () => Promise<SshPrep & { done: () => void }>,
  ): Promise<{ port: number; opened_ms: number; release: () => void }> {
    let e = this.open.get(key)
    let opened = 0
    if (!e || e.proc.exitCode !== null || e.proc.signalCode !== null) {
      if (e) this.close(key)
      let p = this.pending.get(key)
      if (!p) {
        p = this.start(host, target, prepare).finally(() => this.pending.delete(key))
        this.pending.set(key, p)
      }
      e = await p
      this.open.set(key, e)
      opened = e.opened_ms
      e.proc.once("exit", () => {
        if (this.open.get(key) === e) this.open.delete(key)
      })
    }
    const entry = e
    if (entry.timer) clearTimeout(entry.timer)
    entry.timer = null
    entry.users++
    let released = false
    return {
      port: entry.port,
      opened_ms: opened,
      release: () => {
        if (released) return
        released = true
        entry.users--
        if (entry.users > 0) return
        entry.timer = setTimeout(() => this.close(key), IDLE_MS)
        entry.timer.unref?.()
      },
    }
  }

  private async start(
    host: string,
    target: TunnelTarget,
    prepare: () => Promise<SshPrep & { done: () => void }>,
  ): Promise<Entry> {
    const started = performance.now()
    const port = await freePort()
    const prep = await prepare()
    try {
      const proc = spawn(prep.ssh, [...tunnelArgs(prep.args, port, target), host], {
        env: prep.env,
        stdio: ["ignore", "ignore", "pipe"],
      })
      let err = ""
      proc.stderr?.on("data", (d: Buffer) => {
        if (err.length < 4000) err += d.toString("utf8")
      })
      const deadline = Date.now() + OPEN_TIMEOUT_MS
      for (;;) {
        if (proc.exitCode !== null || proc.signalCode !== null)
          throw new TunnelError(
            /Host key verification failed|host key is known/i.test(err)
              ? `la huella del servidor no está aceptada en Keel: ${err.trim().split("\n").pop()}`
              : `el túnel no abrió: ${err.trim().split("\n").slice(-2).join(" · ") || `ssh salió con ${proc.exitCode}`}`,
          )
        if (await listening(port)) break
        if (Date.now() > deadline) {
          proc.kill("SIGTERM")
          throw new TunnelError("el túnel no abrió en 20 s")
        }
        await Bun.sleep(100)
      }
      return {
        port,
        proc,
        users: 0,
        timer: null,
        opened_ms: Math.round(performance.now() - started),
      }
    } finally {
      // askpass sólo hace falta para entrar: el token no vive más que la apertura.
      prep.done()
    }
  }

  close(key: string): void {
    const e = this.open.get(key)
    if (!e) return
    this.open.delete(key)
    if (e.timer) clearTimeout(e.timer)
    if (e.proc.exitCode === null && e.proc.signalCode === null) e.proc.kill("SIGTERM")
  }

  /** Al terminar un run o el daemon: nada queda abierto. */
  closeWhere(match: (key: string) => boolean): void {
    for (const k of [...this.open.keys()]) if (match(k)) this.close(k)
  }

  size(): number {
    return this.open.size
  }
}
