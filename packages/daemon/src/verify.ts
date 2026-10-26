/**
 * Verificación del proyecto (ADR-0021 §4): Keel corre los comandos del perfil
 * en el worktree de la tarea y devuelve un resultado corto por comando. El
 * agente no gasta turnos ni contexto en correrlos y leer la salida entera: la
 * salida completa queda como artefacto y el delta contra el baseline lo
 * calcula `verifyDelta` de `@keel/core`.
 */
import { spawn } from "node:child_process"
import { type ProjectProfile, redact, type VerifyResult } from "@keel/core"

/** Líneas finales que ve el agente; lo demás, en el artefacto. */
const TAIL_LINES = 30
/** Lo que se guarda de la salida de un comando: suficiente para diagnosticar. */
const MAX_OUTPUT = 2 * 1024 * 1024
const DEFAULT_TIMEOUT_MS = 15 * 60_000

export type VerifyDeps = {
  /** Guarda la salida completa y devuelve su referencia. */
  store: (text: string) => string
  env?: Record<string, string | undefined>
}

export async function runVerify(
  cwd: string,
  checks: ProjectProfile["verify"],
  deps: VerifyDeps,
): Promise<VerifyResult[]> {
  const out: VerifyResult[] = []
  for (const c of checks) out.push(await runOne(cwd, c, deps))
  return out
}

function runOne(
  cwd: string,
  c: ProjectProfile["verify"][number],
  deps: VerifyDeps,
): Promise<VerifyResult> {
  const started = Date.now()
  return new Promise((resolve) => {
    const shell = process.platform === "win32" ? "cmd.exe" : "sh"
    const args = process.platform === "win32" ? ["/d", "/s", "/c", c.command] : ["-c", c.command]
    const child = spawn(shell, args, {
      cwd,
      env: { ...(deps.env ?? process.env), CI: "1", FORCE_COLOR: "0" } as NodeJS.ProcessEnv,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      detached: process.platform !== "win32",
    })
    let output = ""
    const take = (b: Buffer) => {
      if (output.length < MAX_OUTPUT) output += b.toString("utf8")
    }
    child.stdout?.on("data", take)
    child.stderr?.on("data", take)
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      // Al grupo entero: un `bun run` deja hijos que seguirían corriendo.
      try {
        if (child.pid && process.platform !== "win32") process.kill(-child.pid, "SIGKILL")
        else child.kill("SIGKILL")
      } catch {
        child.kill("SIGKILL")
      }
    }, c.timeout_ms ?? DEFAULT_TIMEOUT_MS)
    let done = false
    // `error` y `close` pueden llegar los dos: se contesta una vez.
    const finish = (code: number | null, error?: string) => {
      if (done) return
      done = true
      clearTimeout(timer)
      const text = (redact({ t: stripAnsi(output) }).value as { t: string }).t
      const note = timedOut
        ? `\n[keel] se cortó al vencer ${c.timeout_ms ?? DEFAULT_TIMEOUT_MS} ms`
        : ""
      const full = `$ ${c.command}\n${text}${error ? `\n[keel] ${error}` : ""}${note}`
      resolve({
        name: c.name,
        command: c.command,
        ok: code === 0 && !timedOut && !error,
        exit_code: code,
        duration_ms: Date.now() - started,
        tail: tail(full, TAIL_LINES),
        output_ref: text.trim() ? deps.store(full) : null,
      })
    }
    child.on("error", (e) => finish(null, e.message))
    child.on("close", (code) => finish(code))
  })
}

function tail(text: string, lines: number): string {
  const all = text.replace(/\s+$/, "").split("\n")
  return all.length > lines
    ? `… ${all.length - lines} líneas antes\n${all.slice(-lines).join("\n")}`
    : all.join("\n")
}

function stripAnsi(s: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: quitar códigos de color de la salida
  return s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "")
}
