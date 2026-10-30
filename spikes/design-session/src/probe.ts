/**
 * Spike (ADR-0044): una sesión interactiva de Claude Code, lanzada por Keel en tmux,
 * recibe un encargo pegado en su prompt, trabaja en Claude Design y su transcript dice
 * qué hizo y qué link publicó.
 *
 *   bun spikes/design-session/src/probe.ts
 *
 * Mide: tiempo hasta el prompt listo, si pide confiar en la carpeta, si pide permisos,
 * qué tools usa, el link del diseño y el tiempo total. Crea un diseño privado en la
 * cuenta del humano. Las capturas van a `captures/` (gitignored).
 */
import { randomUUID } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"

const session = `keel-spike-design-${process.pid}`
const id = randomUUID()
const cwd = mkdtempSync(join(tmpdir(), "keel-design-"))
const captures = join(import.meta.dir, "..", "captures")
mkdirSync(captures, { recursive: true })
const t0 = performance.now()
const at = () => `${Math.round(performance.now() - t0)} ms`

function tmux(...args: string[]): string {
  const r = Bun.spawnSync(["tmux", ...args], { stdout: "pipe", stderr: "pipe" })
  return r.stdout.toString()
}
const pane = () => tmux("capture-pane", "-p", "-t", session)

// Lo que Claude Code pone en el entorno de una sesión hija: sin quitarlo, la sesión
// nueva se cree hija de la que corre el spike.
const env = Object.fromEntries(
  Object.entries(process.env).filter(
    ([k]) => !/^(CLAUDECODE|CLAUDE_CODE_|CLAUDE_PID|CLAUDE_EFFORT)/.test(k),
  ),
) as Record<string, string>
const envArgs = Object.entries(env).flatMap(([k, v]) => ["-e", `${k}=${v}`])
tmux(
  "new-session",
  "-d",
  "-s",
  session,
  "-x",
  "140",
  "-y",
  "40",
  "-c",
  cwd,
  ...envArgs,
  `claude --session-id ${id} -n spike-design`,
)

const log: string[] = []
const note = (s: string) => {
  log.push(`${at()} ${s}`)
  console.log(`${at()} ${s}`)
}

async function until(pred: (screen: string) => boolean, ms: number): Promise<string | null> {
  const end = performance.now() + ms
  while (performance.now() < end) {
    const s = pane()
    if (pred(s)) return s
    await Bun.sleep(300)
  }
  return null
}

let screen = await until((s) => /trust this folder|❯ (?!.*No, exit)/.test(s), 30_000)
if (screen && /trust this folder/.test(screen)) {
  note("pide confiar en la carpeta (en Keel lo contesta el humano; aquí el spike)")
  tmux("send-keys", "-t", session, "Down")
  await Bun.sleep(300)
  tmux("send-keys", "-t", session, "Enter")
}
screen = await until((s) => /for shortcuts|auto mode|bypass|accept edits|Try "/.test(s), 30_000)
note(screen ? "prompt listo" : "el prompt no apareció")

const brief = [
  "Encargo de Keel (prueba técnica, ADR-0044).",
  "Crea en Claude Design una tarjeta de producto pequeña: foto cuadrada gris, título «Fotolibro 20×20»,",
  "precio original $1,200 tachado, precio final $960 y una etiqueta roja «-20%».",
  "Usa la herramienta Artifact con su quickstart de intent design. Mantenlo privado y mínimo.",
  "Al terminar responde en una línea con el link del diseño.",
].join("\n")
const buf = join(cwd, ".brief")
writeFileSync(buf, brief)
tmux("load-buffer", "-b", "keel", buf)
tmux("paste-buffer", "-p", "-d", "-b", "keel", "-t", session)
await Bun.sleep(500)
tmux("send-keys", "-t", session, "Enter")
note("encargo pegado")

const transcript = (): string | null => {
  const root = join(homedir(), ".claude", "projects")
  for (const d of new Bun.Glob(`*/${id}.jsonl`).scanSync(root)) return join(root, d)
  return null
}

const tools: string[] = []
const urls = new Set<string>()
let asked = 0
let done = false
let seen = 0
const deadline = performance.now() + 10 * 60_000
while (!done && performance.now() < deadline) {
  const s = pane()
  if (/Do you want to|❯ 1\. Yes/.test(s)) {
    asked++
    note("pide permiso en la terminal; el spike no contesta por el humano: se detiene")
    writeFileSync(join(captures, "permiso.txt"), s)
    break
  }
  const p = transcript()
  if (p && existsSync(p)) {
    const lines = readFileSync(p, "utf8").split("\n").filter(Boolean)
    for (const l of lines.slice(seen)) {
      const e = JSON.parse(l) as {
        type?: string
        message?: { stop_reason?: string; content?: unknown }
      }
      const content = Array.isArray(e.message?.content)
        ? (e.message.content as Record<string, unknown>[])
        : []
      for (const c of content) {
        if (c.type === "tool_use") {
          tools.push(String(c.name))
          note(`tool ${String(c.name)}`)
        }
        const text = JSON.stringify(c)
        for (const m of text.matchAll(/https:\/\/claude\.ai\/[\w/.-]+/g)) urls.add(m[0])
      }
      if (e.type === "assistant" && e.message?.stop_reason === "end_turn") done = true
    }
    seen = lines.length
  }
  await Bun.sleep(1000)
}

note(done ? "terminó su turno" : "sin terminar")
const result = { session_id: id, tools, urls: [...urls], asked_permission: asked, total: at(), log }
writeFileSync(join(captures, `run-${id}.json`), JSON.stringify(result, null, 2))
writeFileSync(join(captures, `pane-${id}.txt`), pane())
console.log(
  JSON.stringify({ tools, urls: [...urls], asked_permission: asked, total: at() }, null, 2),
)
tmux("kill-session", "-t", session)
