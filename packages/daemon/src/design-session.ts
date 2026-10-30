/**
 * ADR-0044: una sesión interactiva de Claude Code por tarea, en un pane de tmux, para
 * trabajar en Claude Design (la tool `Artifact` sólo existe en la sesión interactiva).
 *
 * Keel la lanza con el `claude` instalado y la configuración del humano, le pega los
 * encargos en su prompt (bracketed paste) cuando no hay un diálogo abierto, y lee sólo el
 * transcript de la sesión que lanzó (su `--session-id`) para contar qué hizo y qué
 * diseños publicó. Los diálogos (confianza en la carpeta, permisos) los contesta el
 * humano desde la GUI; Keel nunca los contesta por él.
 */
import { randomUUID } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

export type DesignSession = {
  name: string
  session_id: string
  work_item_id: string
  project_id: string
  cwd: string
  started_at: string
}

export type Waiting = "trust" | "permission" | null

type Live = DesignSession & {
  seen: number
  tools: Map<string, string>
  pending: string[]
  busy: boolean
  waiting: Waiting
  reply: string
  urls: string[]
  delivering: boolean
}

export type DesignSessionDeps = {
  /** El `claude` instalado; null si no hay. */
  claude: () => string | null
  emit: (s: DesignSession, kind: string, payload: Record<string, unknown>) => void
  /** La sesión terminó su turno: lo que respondió y los diseños que publicó en él. */
  onIdle: (s: DesignSession, reply: { text: string; urls: string[] }) => void
  /** Socket de tmux propio (pruebas); por defecto, el servidor del humano. */
  socket?: string
  /** Dónde escribe Claude Code sus transcripts; por defecto `~/.claude/projects`. */
  transcripts?: string
  intervalMs?: number
}

/** Las variables con las que Claude Code marca a sus procesos hijos (spike). */
const INHERITED = [
  "CLAUDECODE",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_CODE_MESSAGING_SOCKET",
  "CLAUDE_CODE_MESSAGING_TOKEN",
  "CLAUDE_CODE_SESSION_ATTENDED",
  "CLAUDE_CODE_EXECPATH",
  "CLAUDE_PID",
  "CLAUDE_EFFORT",
]

const TRUST = /trust this folder/i
const PERMISSION = /Do you want to (proceed|make this edit|create|allow|run)|❯ 1\. Yes/
const READY = /\? for shortcuts|shift\+tab to cycle|Try "/

export const DESIGN_COLS = 120
export const DESIGN_ROWS = 36

const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`

export function sessionName(displayId: string): string {
  return `keel-design-${displayId.replace(/[^A-Za-z0-9_-]/g, "-")}`
}

export class DesignSessions {
  private readonly live = new Map<string, Live>()
  private timer: ReturnType<typeof setInterval> | null = null
  private ticking = false
  private readonly deps: DesignSessionDeps

  constructor(deps: DesignSessionDeps) {
    this.deps = deps
  }

  claudePath(): string | null {
    return this.deps.claude()
  }

  /** Hay tmux en la máquina (Windows nativo no lo tiene). */
  available(): boolean {
    return Bun.which("tmux") !== null
  }

  private tmux(args: string[], stdin?: string): { code: number; out: string } {
    const r = Bun.spawnSync(
      ["tmux", ...(this.deps.socket ? ["-L", this.deps.socket] : []), ...args],
      {
        stdout: "pipe",
        stderr: "pipe",
        ...(stdin !== undefined ? { stdin: Buffer.from(stdin) } : {}),
      },
    )
    return { code: r.exitCode ?? 1, out: r.stdout.toString() }
  }

  private alive(name: string): boolean {
    return this.tmux(["has-session", "-t", `=${name}`]).code === 0
  }

  count(): number {
    return this.live.size
  }

  get(workItemId: string): (DesignSession & { waiting: Waiting; busy: boolean }) | null {
    const s = [...this.live.values()].find((x) => x.work_item_id === workItemId)
    return s ? { ...this.view(s), waiting: s.waiting, busy: s.busy } : null
  }

  private view(s: Live): DesignSession {
    const { name, session_id, work_item_id, project_id, cwd, started_at } = s
    return { name, session_id, work_item_id, project_id, cwd, started_at }
  }

  /** Abre la sesión de la tarea. Si ya hay una viva, la devuelve. */
  open(task: { id: string; project_id: string; display_id: string }, cwd: string): DesignSession {
    const existing = this.get(task.id)
    if (existing) return existing
    const claude = this.deps.claude()
    if (!claude) throw new Error("no encontré el binario de Claude Code (`claude`); instálalo")
    if (!this.available())
      throw new Error("las sesiones de diseño necesitan tmux, y no está instalado")
    const name = sessionName(task.display_id)
    // Una sesión vieja con el mismo nombre (de antes de reiniciar) se reemplaza.
    if (this.alive(name)) this.tmux(["kill-session", "-t", `=${name}`])
    const session_id = randomUUID()
    const unset = [
      ...new Set([
        ...INHERITED,
        ...Object.keys(process.env).filter((k) => k.startsWith("CLAUDE_CODE_")),
      ]),
    ]
    const command = [
      "env",
      ...unset.flatMap((k) => ["-u", k]),
      quote(claude),
      "--session-id",
      session_id,
      "-n",
      quote(`${task.display_id} · diseño`),
    ].join(" ")
    const r = this.tmux([
      "new-session",
      "-d",
      "-s",
      name,
      "-x",
      String(DESIGN_COLS),
      "-y",
      String(DESIGN_ROWS),
      "-c",
      cwd,
      command,
    ])
    if (r.code !== 0) throw new Error(`tmux no pudo abrir la sesión ${name}`)
    const s: DesignSession = {
      name,
      session_id,
      work_item_id: task.id,
      project_id: task.project_id,
      cwd,
      started_at: new Date().toISOString(),
    }
    this.track(s)
    this.deps.emit(s, "design.session_started", { ...s })
    return s
  }

  /** Vuelve a seguir una sesión que sobrevivió a un reinicio del daemon. */
  restore(s: DesignSession): boolean {
    if (!this.alive(s.name)) return false
    this.track(s, true)
    return true
  }

  private track(s: DesignSession, restored = false): void {
    this.live.set(s.name, {
      ...s,
      // Restaurada, lo que ya estaba en el transcript ya se contó.
      seen: restored ? this.transcriptLines(s.session_id).length : 0,
      tools: new Map(),
      pending: [],
      busy: false,
      waiting: null,
      reply: "",
      urls: [],
      delivering: false,
    })
    this.timer ??= setInterval(() => void this.tick(), this.deps.intervalMs ?? 1000)
  }

  /** Encola un encargo; se pega en el prompt en cuanto no haya diálogo ni turno en curso. */
  send(workItemId: string, text: string): "sent" | "queued" | "waiting_human" {
    const s = [...this.live.values()].find((x) => x.work_item_id === workItemId)
    if (!s) throw new Error("la tarea no tiene sesión de diseño")
    s.pending.push(text)
    void this.tick()
    return s.waiting ? "waiting_human" : s.busy || s.pending.length > 1 ? "queued" : "sent"
  }

  /** La pantalla de la sesión, con sus colores (secuencias SGR). */
  screen(workItemId: string): string | null {
    const s = [...this.live.values()].find((x) => x.work_item_id === workItemId)
    if (!s) return null
    const r = this.tmux(["capture-pane", "-e", "-p", "-t", `=${s.name}:`])
    return r.code === 0 ? r.out : null
  }

  /** Teclas del humano: nombres de tmux (Enter, Escape, Up, Down…) o texto literal. */
  keys(workItemId: string, input: { keys?: string[]; text?: string }): void {
    const s = [...this.live.values()].find((x) => x.work_item_id === workItemId)
    if (!s) throw new Error("la tarea no tiene sesión de diseño")
    if (input.text) this.tmux(["send-keys", "-t", `=${s.name}:`, "-l", input.text])
    for (const k of input.keys ?? []) this.tmux(["send-keys", "-t", `=${s.name}:`, k])
    void this.tick()
  }

  close(workItemId: string, reason: string): void {
    const s = [...this.live.values()].find((x) => x.work_item_id === workItemId)
    if (!s) return
    this.tmux(["kill-session", "-t", `=${s.name}`])
    this.forget(s, reason)
  }

  private forget(s: Live, reason: string): void {
    this.live.delete(s.name)
    this.deps.emit(this.view(s), "design.session_closed", { name: s.name, reason })
    if (this.live.size === 0 && this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.live.clear()
  }

  private transcriptLines(sessionId: string): string[] {
    const root = this.deps.transcripts ?? join(homedir(), ".claude", "projects")
    if (!existsSync(root)) return []
    for (const rel of new Bun.Glob(`*/${sessionId}.jsonl`).scanSync(root))
      return readFileSync(join(root, rel), "utf8").split("\n").filter(Boolean)
    return []
  }

  /** Una vuelta: diálogos en pantalla, lo nuevo del transcript y el siguiente encargo. */
  async tick(): Promise<void> {
    if (this.ticking) return
    this.ticking = true
    try {
      for (const s of [...this.live.values()]) {
        if (!this.alive(s.name)) {
          this.forget(s, "la sesión terminó")
          continue
        }
        this.watchScreen(s)
        this.readTranscript(s)
        if (!s.waiting && !s.busy && !s.delivering && s.pending.length) await this.deliver(s)
      }
    } finally {
      this.ticking = false
    }
  }

  private watchScreen(s: Live): void {
    const screen = this.tmux(["capture-pane", "-p", "-t", `=${s.name}:`]).out
    const waiting: Waiting = TRUST.test(screen)
      ? "trust"
      : PERMISSION.test(screen)
        ? "permission"
        : null
    if (waiting !== s.waiting) {
      s.waiting = waiting
      this.deps.emit(
        this.view(s),
        waiting ? "design.session.waiting_human" : "design.session.resumed",
        {
          name: s.name,
          ...(waiting ? { prompt: waiting } : {}),
        },
      )
    }
  }

  private async deliver(s: Live): Promise<void> {
    const screen = this.tmux(["capture-pane", "-p", "-t", `=${s.name}:`]).out
    if (!READY.test(screen)) return
    const text = s.pending.shift()
    if (text === undefined) return
    s.delivering = true
    try {
      const buffer = `keel-${s.name}`
      this.tmux(["load-buffer", "-b", buffer, "-"], text)
      // `-p`: bracketed paste; un salto de línea no manda el mensaje a medias.
      this.tmux(["paste-buffer", "-p", "-d", "-b", buffer, "-t", `=${s.name}:`])
      await Bun.sleep(400)
      this.tmux(["send-keys", "-t", `=${s.name}:`, "Enter"])
      s.busy = true
      s.reply = ""
      s.urls = []
      this.deps.emit(this.view(s), "design.delivered", { name: s.name, chars: text.length })
    } finally {
      s.delivering = false
    }
  }

  private readTranscript(s: Live): void {
    const lines = this.transcriptLines(s.session_id)
    for (const line of lines.slice(s.seen)) {
      let e: TranscriptLine
      try {
        e = JSON.parse(line) as TranscriptLine
      } catch {
        continue
      }
      this.onLine(s, e)
    }
    s.seen = lines.length
  }

  private onLine(s: Live, e: TranscriptLine): void {
    const content = Array.isArray(e.message?.content) ? e.message.content : []
    if (e.type === "assistant") {
      for (const c of content) {
        if (c.type === "text" && typeof c.text === "string" && c.text.trim()) {
          s.reply = c.text
          this.deps.emit(this.view(s), "design.session.event", {
            role: "assistant",
            text: c.text.slice(0, 2000),
          })
        }
        if (c.type === "tool_use" && typeof c.name === "string") {
          if (typeof c.id === "string") s.tools.set(c.id, c.name)
          this.deps.emit(this.view(s), "design.session.event", {
            role: "tool",
            tool: c.name,
            summary: summarize(c.input),
          })
        }
      }
      if (e.message?.stop_reason === "end_turn" && s.busy) {
        s.busy = false
        this.deps.emit(this.view(s), "design.session.idle", { name: s.name, urls: s.urls })
        this.deps.onIdle(this.view(s), { text: s.reply, urls: [...s.urls] })
      }
      return
    }
    if (e.type !== "user") return
    const result = e.toolUseResult
    const toolUse = content.find((c) => c.type === "tool_result")
    const tool =
      typeof toolUse?.tool_use_id === "string" ? s.tools.get(toolUse.tool_use_id) : undefined
    // ADR-0044 §3: el diseño es el `url` de un publish; el `type_url` es la plantilla.
    if (
      tool === "Artifact" &&
      result &&
      typeof result.url === "string" &&
      /^https:\/\/claude\.ai\//.test(result.url) &&
      (result.created_from_type === true || result.updated === true || result.created === true)
    ) {
      const first = !s.urls.includes(result.url)
      if (first) s.urls.push(result.url)
      this.deps.emit(this.view(s), "design.published", {
        url: result.url,
        title: typeof result.title === "string" ? result.title : null,
        updated: !first || result.updated === true,
      })
    }
  }
}

type TranscriptLine = {
  type?: string
  message?: {
    stop_reason?: string | null
    content?: {
      type?: string
      text?: unknown
      name?: unknown
      id?: unknown
      input?: unknown
      tool_use_id?: unknown
    }[]
  }
  toolUseResult?: {
    url?: unknown
    title?: unknown
    created_from_type?: unknown
    created?: unknown
    updated?: unknown
  }
}

/** Una línea de lo que pidió una tool: su acción, archivo o comando. */
function summarize(input: unknown): string {
  if (!input || typeof input !== "object") return ""
  const o = input as Record<string, unknown>
  const pick = ["action", "intent", "title", "file_path", "command", "url", "query"]
    .map((k) => (typeof o[k] === "string" ? `${k}: ${o[k] as string}` : null))
    .filter(Boolean)
  return pick.join(" · ").slice(0, 200)
}
