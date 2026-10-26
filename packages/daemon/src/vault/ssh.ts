/**
 * SSH con las credenciales de Keel (ADR-0025 §3–§4), con el `ssh` real (OpenSSH):
 *
 * - Llaves del vault: a un `ssh-agent` propio de Keel, con el socket en el estado de
 *   Keel (el sandbox lo tapa), cargadas por la entrada estándar: nunca tocan el disco.
 * - Contraseñas y frases: las entrega `keel askpass` con un token (SSH_ASKPASS_REQUIRE).
 * - Huellas: un `known_hosts` de Keel; una huella nueva la acepta el humano.
 * - Importar: los `Host` de `~/.ssh/config`, resueltos con `ssh -G`. Keel no lee llaves.
 */
import { generateKeyPairSync, randomBytes } from "node:crypto"
import { existsSync, mkdirSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join, normalize } from "node:path"

// --- llaves ed25519 en formato OpenSSH ------------------------------------------------

function sshString(b: Buffer): Buffer {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(b.length)
  return Buffer.concat([len, b])
}

/** Una llave nueva: la privada en `openssh-key-v1` sin cifrar (va al vault) y la pública. */
export function generateEd25519(comment: string): { privatePem: string; publicLine: string } {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519")
  const pub = Buffer.from(publicKey.export({ format: "jwk" }).x as string, "base64url")
  const seed = Buffer.from(privateKey.export({ format: "jwk" }).d as string, "base64url")
  const type = Buffer.from("ssh-ed25519")
  const pubBlob = Buffer.concat([sshString(type), sshString(pub)])
  const check = randomBytes(4)
  let priv = Buffer.concat([
    check,
    check,
    sshString(type),
    sshString(pub),
    sshString(Buffer.concat([seed, pub])),
    sshString(Buffer.from(comment)),
  ])
  const pad = 8 - (priv.length % 8)
  if (pad < 8)
    priv = Buffer.concat([priv, Buffer.from(Array.from({ length: pad }, (_, i) => i + 1))])
  seed.fill(0)
  const none = sshString(Buffer.from("none"))
  const one = Buffer.alloc(4)
  one.writeUInt32BE(1)
  const blob = Buffer.concat([
    Buffer.from("openssh-key-v1\0"),
    none,
    none,
    sshString(Buffer.alloc(0)),
    one,
    sshString(pubBlob),
    sshString(priv),
  ])
  priv.fill(0)
  const b64 = blob.toString("base64").replace(/.{70}/g, "$&\n")
  return {
    privatePem: `-----BEGIN OPENSSH PRIVATE KEY-----\n${b64}\n-----END OPENSSH PRIVATE KEY-----\n`,
    publicLine: `ssh-ed25519 ${pubBlob.toString("base64")} ${comment}`,
  }
}

/** La línea sugerida para `authorized_keys`: la llave sólo para un comando y una máquina. */
export function authorizedKeysLine(
  publicLine: string,
  o: { command?: string | null; from?: string | null } = {},
): string {
  const opts = [
    ...(o.command ? [`command="${o.command.replace(/"/g, '\\"')}"`] : []),
    ...(o.from ? [`from="${o.from}"`] : []),
    "no-port-forwarding",
    "no-agent-forwarding",
    "no-X11-forwarding",
  ]
  return `${opts.join(",")} ${publicLine}`
}

// --- el ssh-agent de Keel ---------------------------------------------------------------

async function spawnText(
  cmd: string[],
  o: { env?: Record<string, string>; stdin?: string } = {},
): Promise<{ code: number; out: string; err: string }> {
  const p = Bun.spawn(cmd, {
    env: o.env ?? (process.env as Record<string, string>),
    stdin: o.stdin === undefined ? "ignore" : new Blob([o.stdin]),
    stdout: "pipe",
    stderr: "pipe",
  })
  const [out, err] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
  ])
  return { code: await p.exited, out: out.trim(), err: err.trim() }
}

/**
 * Un `ssh-agent` por daemon, con su socket en el estado de Keel. Se lanza la primera
 * vez que hace falta y muere con el daemon.
 */
export class KeelSshAgent {
  private proc: ReturnType<typeof Bun.spawn> | null = null
  readonly dir: string
  readonly socket: string
  constructor(dir: string) {
    this.dir = dir
    this.socket = join(dir, "agent.sock")
  }

  private async ensure(): Promise<void> {
    if (this.proc && existsSync(this.socket)) return
    mkdirSync(this.dir, { recursive: true, mode: 0o700 })
    if (existsSync(this.socket)) Bun.spawnSync(["rm", "-f", this.socket])
    this.proc = Bun.spawn(["ssh-agent", "-D", "-a", this.socket], {
      stdout: "ignore",
      stderr: "ignore",
    })
    for (let i = 0; i < 100 && !existsSync(this.socket); i++) await Bun.sleep(10)
    if (!existsSync(this.socket)) throw new Error("no arrancó el ssh-agent de Keel")
  }

  /** Carga una llave por la entrada estándar, con caducidad. */
  async add(privatePem: string, lifetimeSeconds = 600): Promise<void> {
    await this.ensure()
    const r = await spawnText(["ssh-add", "-q", "-t", String(lifetimeSeconds), "-"], {
      env: { PATH: process.env.PATH ?? "", SSH_AUTH_SOCK: this.socket },
      stdin: privatePem,
    })
    if (r.code !== 0) throw new Error(`ssh-add no aceptó la llave: ${r.err}`)
  }

  /** Las públicas cargadas (`ssh-add -L`). */
  async loaded(): Promise<string[]> {
    await this.ensure()
    const r = await spawnText(["ssh-add", "-L"], {
      env: { PATH: process.env.PATH ?? "", SSH_AUTH_SOCK: this.socket },
    })
    return r.code === 0 ? r.out.split("\n").filter(Boolean) : []
  }

  stop(): void {
    this.proc?.kill()
    this.proc = null
  }
}

// --- importar ~/.ssh/config ---------------------------------------------------------------

export type ImportedHost = {
  alias: string
  host: string
  user: string | null
  port: number
  proxy_jump: string | null
  identity_file: string | null
  environment: "dev" | "staging" | "prod" | null
  why: string
}

/** El entorno por el prefijo del alias, como `sshx`. */
export function envFromAlias(alias: string): {
  environment: ImportedHost["environment"]
  why: string
} {
  if (/^(prod|prd)-/i.test(alias)) return { environment: "prod", why: "prefijo prod-" }
  if (/^(staging|stg)-/i.test(alias)) return { environment: "staging", why: "prefijo staging-" }
  if (/^dev-/i.test(alias)) return { environment: "dev", why: "prefijo dev-" }
  return { environment: null, why: "sin prefijo de entorno" }
}

/** Los `Host` sin comodines de la config (sin seguir `Include`). */
export function hostAliases(config: string): string[] {
  const out: string[] = []
  for (const line of config.split(/\r?\n/)) {
    const m = /^\s*Host\s+(.+?)\s*$/i.exec(line)
    if (!m) continue
    for (const a of (m[1] as string).split(/\s+/))
      if (a && !/[*?!]/.test(a) && !out.includes(a)) out.push(a)
  }
  return out
}

/**
 * Lee `~/.ssh/config` y resuelve cada alias con `ssh -G`. No es un archivo de
 * credenciales: nombres, destinos, puertos y la ruta de la llave (ADR-0025 §9).
 */
export async function importSshConfig(
  o: { home?: string; ssh?: string } = {},
): Promise<ImportedHost[]> {
  const home = o.home ?? homedir()
  const file = join(home, ".ssh", "config")
  if (!existsSync(file)) return []
  const out: ImportedHost[] = []
  for (const alias of hostAliases(readFileSync(file, "utf8"))) {
    const r = await spawnText([o.ssh ?? "ssh", "-G", "-F", file, alias])
    if (r.code !== 0) continue
    const opts = new Map<string, string[]>()
    // En Windows `ssh -G` termina las líneas con CRLF.
    for (const l of r.out.split(/\r?\n/)) {
      const [k, ...v] = l.trim().split(" ")
      if (!k) continue
      opts.set(k, [...(opts.get(k) ?? []), v.join(" ")])
    }
    const one = (k: string) => opts.get(k)?.[0] ?? null
    const identity =
      (opts.get("identityfile") ?? [])
        .map((p) => normalize(p.replace(/^~(?=[\\/])/, home)))
        .find((p) => existsSync(p)) ?? null
    const proxy = one("proxyjump")
    out.push({
      alias,
      host: one("hostname") ?? alias,
      user: one("user"),
      port: Number(one("port") ?? 22),
      proxy_jump: proxy && proxy !== "none" ? proxy : null,
      identity_file: identity,
      ...envFromAlias(alias),
    })
  }
  return out
}

// --- huellas -------------------------------------------------------------------------------

/** Las líneas de `known_hosts` del humano para ese host, para sembrar las de Keel. */
export async function knownHostLines(
  host: string,
  port: number,
  home = homedir(),
): Promise<string[]> {
  const file = join(home, ".ssh", "known_hosts")
  if (!existsSync(file)) return []
  const name = port === 22 ? host : `[${host}]:${port}`
  const r = await spawnText(["ssh-keygen", "-F", name, "-f", file])
  return r.code === 0 ? r.out.split("\n").filter((l) => l && !l.startsWith("#")) : []
}

/** Las llaves que presenta el host (`ssh-keyscan`), con su huella. */
export async function scanHostKeys(
  host: string,
  port: number,
): Promise<{ line: string; fingerprint: string; type: string }[]> {
  const r = await spawnText(["ssh-keyscan", "-T", "5", "-p", String(port), host])
  const lines = r.out.split("\n").filter((l) => l && !l.startsWith("#"))
  const out: { line: string; fingerprint: string; type: string }[] = []
  for (const line of lines) out.push({ line, ...(await fingerprint(line)) })
  return out
}

/** La huella SHA256 de una línea de `known_hosts` o de una pública. */
export async function fingerprint(line: string): Promise<{ fingerprint: string; type: string }> {
  const r = await spawnText(["ssh-keygen", "-lf", "-"], { stdin: `${line}\n` })
  const m = /^\d+\s+(\S+)\s+.*\((\S+)\)\s*$/.exec(r.out.split("\n")[0] ?? "")
  return { fingerprint: m?.[1] ?? "", type: m?.[2] ?? "" }
}

// --- los argumentos de ssh ---------------------------------------------------------------

export type SshTarget = {
  host: string
  user: string | null
  port: number
  proxy_jump: string | null
  identity_file: string | null
}

/**
 * Las opciones de `ssh` para una conexión de Keel: sin la config del usuario, con el
 * `known_hosts` de Keel y el método de entrada. El destino y el comando van aparte.
 */
export function sshOptions(
  t: SshTarget,
  method: "agent" | "file" | "key" | "password" | "ask",
  o: { knownHosts: string; keelAgent: string; interactive: boolean },
): string[] {
  const opts: string[] = [
    "-F",
    "none",
    "-o",
    `UserKnownHostsFile=${o.knownHosts}`,
    "-o",
    "StrictHostKeyChecking=yes",
    "-o",
    "GlobalKnownHostsFile=/dev/null",
    "-p",
    String(t.port),
  ]
  if (t.user) opts.push("-l", t.user)
  if (t.proxy_jump) opts.push("-J", t.proxy_jump)
  if (method === "key") opts.push("-o", `IdentityAgent=${o.keelAgent}`, "-o", "IdentitiesOnly=no")
  if (method === "file" && t.identity_file)
    opts.push("-i", t.identity_file, "-o", "IdentitiesOnly=yes", "-o", "IdentityAgent=none")
  if (method === "password" || method === "ask")
    opts.push(
      "-o",
      "PubkeyAuthentication=no",
      "-o",
      "PreferredAuthentications=password,keyboard-interactive",
      "-o",
      "IdentityAgent=none",
    )
  // Sin terminal (operaciones del agente) nada se pregunta salvo por askpass.
  if (!o.interactive && (method === "agent" || method === "key")) opts.push("-o", "BatchMode=yes")
  if (!o.interactive) opts.push("-o", "ConnectTimeout=15", "-T")
  return opts
}
