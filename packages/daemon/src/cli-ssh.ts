/**
 * La terminal del humano sobre una conexión de Keel (ADR-0025 §5), como `sshx`:
 *
 *   keel ssh <conexión>   abre `ssh` con lo que tenga el vault y marca el entorno
 *   keel ssh              lista las conexiones SSH del proyecto
 *   keel askpass <prompt> lo ejecuta `ssh` (SSH_ASKPASS) para pedirle a Keel la
 *                         contraseña o la frase con su token; si Keel no la tiene, la
 *                         pide en la terminal y ofrece recordarla.
 *
 * Ninguno de los dos guarda nada: hablan con el daemon por la puerta humana.
 */
import { spawn, spawnSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { writeFileSync } from "node:fs"
import { IpcClient } from "./ipc/client.js"
import { defaultEndpoint } from "./ipc/endpoint.js"

const meta = () => ({ request_id: randomUUID(), idempotency_key: randomUUID() })

function tty(text: string): void {
  try {
    writeFileSync("/dev/tty", text)
  } catch {
    process.stderr.write(text)
  }
}

/** Una línea de la terminal, sin eco si es secreta. */
function readTty(prompt: string, hidden: boolean): string {
  tty(prompt)
  const script = hidden
    ? `stty -echo < /dev/tty; IFS= read -r l < /dev/tty; s=$?; stty echo < /dev/tty; printf '\\n' > /dev/tty; printf '%s' "$l"; exit $s`
    : `IFS= read -r l < /dev/tty; printf '%s' "$l"`
  const r = spawnSync("sh", ["-c", script], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  })
  return r.status === 0 ? r.stdout : ""
}

export async function askpassMain(prompt: string): Promise<number> {
  const token = process.env.KEEL_ASKPASS_TOKEN
  const socket = process.env.KEEL_SOCKET
  if (!token || !socket) return 1
  const c = await IpcClient.connect(socket)
  try {
    const r = (await c.call("secrets.askpass", { token, prompt })) as {
      value: string | null
      ask: boolean
    }
    if (r.value !== null) {
      process.stdout.write(`${r.value}\n`)
      return 0
    }
    if (!r.ask) return 1
    const value = readTty(prompt.trim() ? `${prompt.trim()} ` : "Contraseña: ", true)
    if (!value) return 1
    const keep = readTty(
      "¿Recordarla? [Enter] no · s: hasta cerrar Keel · v: guardar en el vault: ",
      false,
    )
      .trim()
      .toLowerCase()
    if (keep === "s" || keep === "v")
      await c
        .call("secrets.remember", {
          ...meta(),
          token,
          value,
          scope: keep === "v" ? "vault" : "session",
        })
        .catch((e: Error) => tty(`Keel no pudo guardarla: ${e.message}\n`))
    process.stdout.write(`${value}\n`)
    return 0
  } finally {
    c.close()
  }
}

export async function sshMain(
  name: string | undefined,
  socket = defaultEndpoint(),
): Promise<number> {
  const c = await IpcClient.connect(socket)
  if (!name) {
    const r = (await c.call("connections.list", {})) as {
      connections: {
        name: string
        type: string
        environment: string
        config: Record<string, unknown>
        auth_method?: string | null
      }[]
    }
    c.close()
    for (const x of r.connections.filter((x) => x.type === "ssh"))
      console.log(
        `${x.environment.padEnd(8)} ${x.name.padEnd(24)} ${String(x.config.user ? `${x.config.user}@` : "")}${String(x.config.host ?? "")}  ${x.auth_method ?? "ref"}`,
      )
    return 0
  }
  let s: {
    args: string[]
    env: Record<string, string>
    banner: string | null
    connection: { environment: string; name: string }
  }
  try {
    s = (await c.call("connections.ssh_session", { connection: name })) as typeof s
  } catch (e) {
    console.error(`keel ssh: ${e instanceof Error ? e.message : String(e)}`)
    c.close()
    return 1
  }
  c.close()
  const pane = process.env.TMUX_PANE
  const env = s.connection.environment
  const tmux = (...a: string[]) => spawnSync("tmux", a, { stdio: "ignore" })
  if (pane) {
    tmux("set", "-p", "-t", pane, "@ssh_env", env)
    tmux("set", "-p", "-t", pane, "@ssh_host", s.connection.name)
    if (env === "prod") {
      tmux("set", "-p", "-t", pane, "window-style", "bg=#2a1218")
      tmux("set", "-p", "-t", pane, "window-active-style", "bg=#2a1218")
    }
  }
  if (s.banner) {
    process.stdout.write(`\x1b]2;⚠ PROD ${s.connection.name}\x07`)
    process.stdout.write(`\n\x1b[1;97;41m ${s.banner} \x1b[0m\n\n`)
  } else process.stdout.write(`\x1b]2;${env} ${s.connection.name}\x07`)
  const child = spawn("ssh", s.args, {
    env: { ...(process.env as Record<string, string>), ...s.env },
    stdio: "inherit",
  })
  const code = await new Promise<number>((resolve) => child.on("close", (c) => resolve(c ?? 1)))
  if (pane) {
    for (const k of ["@ssh_env", "@ssh_host", "window-style", "window-active-style"])
      tmux("set", "-pu", "-t", pane, k)
  }
  return code
}
