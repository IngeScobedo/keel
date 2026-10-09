/**
 * tmux en control mode (`tmux -C`) como host de terminales (ADR-0003 §1.3).
 * Crea una sesión por run, lee salida estructurada (%output), envía input,
 * redimensiona, desconecta el cliente de control y reconecta recuperando el
 * scrollback. Servidor aislado con -L para no tocar el tmux del usuario.
 *
 *   bun src/tmux-probe.ts
 */
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { capturesDir, now } from "./capture.js"

const SOCK = "keel-probe"
const SESSION = "keel-run-probe1"
const sh = (args: string[]) => {
  const r = Bun.spawnSync(["tmux", "-L", SOCK, ...args])
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

type Ctl = {
  proc: ReturnType<typeof Bun.spawn>
  lines: string[]
  send: (cmd: string) => void
  close: () => void
}
function controlClient(): Ctl {
  const proc = Bun.spawn(["tmux", "-L", SOCK, "-C", "attach-session", "-t", SESSION], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  })
  const lines: string[] = []
  ;(async () => {
    const reader = proc.stdout.getReader()
    const dec = new TextDecoder()
    let buf = ""
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      buf += dec.decode(value)
      const parts = buf.split("\n")
      buf = parts.pop() ?? ""
      lines.push(...parts)
    }
  })()
  return {
    proc,
    lines,
    send: (cmd) => {
      proc.stdin.write(`${cmd}\n`)
      proc.stdin.flush()
    },
    close: () => {
      try {
        proc.stdin.end()
      } catch {}
      proc.kill()
    },
  }
}
const decodeOutput = (lines: string[]) =>
  lines
    .filter((l) => l.startsWith("%output "))
    .map((l) =>
      l
        .replace(/^%output %\d+ /, "")
        .replace(/\\(\d{3})/g, (_, o) => String.fromCharCode(Number.parseInt(o, 8))),
    )
    .join("")

const report: Record<string, unknown> = { tmux_version: sh(["-V"]).out.trim() }
sh(["kill-server"])
const create = sh(["new-session", "-d", "-s", SESSION, "-x", "80", "-y", "24", "-c", process.cwd()])
report.create = { code: create.code, err: create.err.trim() }

const c1 = controlClient()
await sleep(400)
c1.send(
  `send-keys -t ${SESSION} 'echo keel-probe-one; printf "cols=%s lines=%s\\n" $(tput cols) $(tput lines)' Enter`,
)
await sleep(800)
const outAfterInput = decodeOutput(c1.lines)
report.input_echoed = outAfterInput.includes("keel-probe-one")
report.size_initial = outAfterInput.match(/cols=\d+ lines=\d+/)?.[0] ?? null
c1.send(`refresh-client -C 120x40`)
c1.send(`resize-window -t ${SESSION} -x 120 -y 40`)
await sleep(400)
c1.send(`send-keys -t ${SESSION} 'printf "cols=%s lines=%s\\n" $(tput cols) $(tput lines)' Enter`)
await sleep(800)
const sizes = decodeOutput(c1.lines).match(/cols=\d+ lines=\d+/g) ?? []
report.size_after_resize = sizes[sizes.length - 1] ?? null
report.control_protocol_sample = c1.lines
  .filter((l) => l.startsWith("%"))
  .slice(0, 8)
  .map((l) => l.slice(0, 80))
report.notifications_seen = [
  ...new Set(c1.lines.map((l) => l.split(" ")[0]).filter((w) => w?.startsWith("%"))),
]
c1.close()
await sleep(300)
report.session_alive_after_client_close = sh(["has-session", "-t", SESSION]).code === 0

const c2 = controlClient()
await sleep(400)
const cap = sh(["capture-pane", "-p", "-S", "-200", "-t", SESSION])
report.reconnect = {
  client2_ok: c2.proc.pid > 0,
  scrollback_has_first_echo: cap.out.includes("keel-probe-one"),
  scrollback_lines: cap.out.split("\n").length,
}
c2.send(`send-keys -t ${SESSION} 'echo keel-probe-two' Enter`)
await sleep(800)
report.reconnect_receives_output = decodeOutput(c2.lines).includes("keel-probe-two")
c2.close()
sh(["kill-server"])
report.server_killed = sh(["has-session", "-t", SESSION]).code !== 0
report.ran_at = now()
mkdirSync(capturesDir, { recursive: true })
writeFileSync(join(capturesDir, "report-tmux.json"), `${JSON.stringify(report, null, 2)}\n`)
console.log(JSON.stringify(report, null, 2))
