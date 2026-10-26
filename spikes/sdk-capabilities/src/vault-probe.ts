/**
 * Spike de ADR-0025: lo que tiene que ser cierto antes de implementar el vault y el broker.
 *
 *   1. Frontera: dentro de bubblewrap, con el estado de Keel, `$XDG_RUNTIME_DIR` y `~/.ssh`
 *      tapados, la shell no alcanza el bus de D-Bus (el llavero), ni `~/.ssh`, ni el
 *      ssh-agent del humano; la puerta de agentes sigue conectando. Se compara con el
 *      sandbox de hoy (ADR-0018), que sólo tapa el estado y la carpeta del socket humano.
 *   2. ssh-agent propio: una llave ed25519 generada en memoria entra al agente de Keel con
 *      `ssh-add -` sin tocar el disco.
 *   3. askpass: `ssh-add` de una llave con frase recibe la frase de un programa de Keel
 *      (SSH_ASKPASS_REQUIRE=force) con un token de un solo uso.
 *   4. Llavero: si el Secret Service responde fuera del sandbox y si hay `secret-tool`.
 *   5. Cifrado: AES-256-GCM con una DEK por secreto envuelta por la KEK, con WebCrypto.
 *
 *   bun spikes/sdk-capabilities/src/vault-probe.ts
 */
import { generateKeyPairSync, randomBytes } from "node:crypto"
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"

/** Copia de `bwrapArgs` de packages/daemon/src/sandbox.ts (ADR-0018 §3), para no cruzar paquetes. */
type SandboxSpec = { writable: string[]; hidden: string[]; reopened: string[] }
function bwrapArgs(spec: SandboxSpec): string[] {
  const bind = (p: string) => (existsSync(p) ? ["--bind", p, p] : [])
  return [
    "--ro-bind",
    "/",
    "/",
    "--dev",
    "/dev",
    "--proc",
    "/proc",
    "--tmpfs",
    "/tmp",
    ...spec.hidden.flatMap((p) => ["--tmpfs", p]),
    ...spec.writable.flatMap(bind),
    ...spec.reopened.flatMap(bind),
    "--unshare-pid",
    "--die-with-parent",
    "--",
  ]
}
const bwrapPath = () => Bun.which("bwrap")

const out: Record<string, unknown> = {}
const say = (k: string, v: unknown) => {
  out[k] = v
  console.log(`${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`)
}

function sh(cmd: string[], opts: { env?: Record<string, string>; stdin?: string } = {}) {
  const r = Bun.spawnSync(cmd, {
    env: opts.env ?? (process.env as Record<string, string>),
    stdin: opts.stdin === undefined ? "ignore" : Buffer.from(opts.stdin),
    stdout: "pipe",
    stderr: "pipe",
    timeout: 20_000,
  })
  return { code: r.exitCode, out: r.stdout.toString().trim(), err: r.stderr.toString().trim() }
}

const runtime = process.env.XDG_RUNTIME_DIR ?? `/run/user/${process.getuid?.()}`
const sshDir = join(homedir(), ".ssh")
const work = mkdtempSync(join(tmpdir(), "keel-vault-spike-"))

// --- 1. Frontera ---------------------------------------------------------------------
const bwrap = bwrapPath()
if (!bwrap) throw new Error("sin bubblewrap")
const doorDir = join(runtime, `keel-spike-${process.pid}`)
Bun.spawnSync(["mkdir", "-p", doorDir])
const door = join(doorDir, "agent.sock")
const server = Bun.listen({
  unix: door,
  socket: {
    data() {},
    open(s) {
      s.end()
    },
  },
})
const state = join(work, "state")
Bun.spawnSync(["mkdir", "-p", state])

const probe = [
  "bash",
  "-c",
  [
    `gdbus call --session --dest org.freedesktop.DBus --object-path /org/freedesktop/DBus --method org.freedesktop.DBus.ListNames >/dev/null 2>&1 && echo bus=si || echo bus=no`,
    `gdbus introspect --session --dest org.freedesktop.secrets --object-path /org/freedesktop/secrets >/dev/null 2>&1 && echo llavero=si || echo llavero=no`,
    `[ -n "$(ls -A ${sshDir} 2>/dev/null)" ] && echo ssh_dir=si || echo ssh_dir=no`,
    `SSH_AUTH_SOCK=${process.env.SSH_AUTH_SOCK ?? "/nada"} ssh-add -l >/dev/null 2>&1; [ $? -ne 2 ] && echo agente_humano=si || echo agente_humano=no`,
    `${process.execPath} -e 'try{await Bun.connect({unix:"${door}",socket:{data(){}}});console.log("puerta_agentes=si")}catch{console.log("puerta_agentes=no")}process.exit(0)'`,
    `ls -A ${state} >/dev/null 2>&1 && [ -z "$(ls -A ${state})" ] && echo estado=tapado || echo estado=visible`,
  ].join("; "),
]
/** Asíncrono: el servidor de askpass vive en este mismo proceso y `spawnSync` lo bloquearía. */
async function shAsync(cmd: string[], env: Record<string, string>) {
  const p = Bun.spawn(cmd, { env, stdin: "ignore", stdout: "pipe", stderr: "pipe" })
  const [o, e] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()])
  return { code: await p.exited, out: o.trim(), err: e.trim() }
}
const parse = (s: string) =>
  Object.fromEntries(s.split("\n").map((l) => l.split("=") as [string, string]))

const today: SandboxSpec = { writable: [], hidden: [state, doorDir], reopened: [door] }
const proposed: SandboxSpec = {
  writable: [],
  hidden: [state, runtime, sshDir],
  reopened: [door],
}
writeFileSync(join(state, "vault.sqlite"), "x")
const envAgent = { ...(process.env as Record<string, string>) }
delete envAgent.SSH_AUTH_SOCK
delete envAgent.DBUS_SESSION_BUS_ADDRESS

say("fuera_del_sandbox", parse(sh(probe).out))
say("sandbox_de_hoy", parse(sh([bwrap, ...bwrapArgs(today), ...probe]).out))
say(
  "sandbox_propuesto",
  parse(sh([bwrap, ...bwrapArgs(proposed), ...probe], { env: envAgent }).out),
)
server.stop(true)
rmSync(doorDir, { recursive: true, force: true })

// --- 2. ssh-agent de Keel con una llave en memoria ----------------------------------------
function sshString(b: Buffer): Buffer {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(b.length)
  return Buffer.concat([len, b])
}
/** Llave privada ed25519 en el formato `openssh-key-v1`, sin cifrar (va por stdin a ssh-add). */
function opensshEd25519(comment: string): { privatePem: string; publicLine: string } {
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
  const b64 = blob.toString("base64").replace(/.{70}/g, "$&\n")
  return {
    privatePem: `-----BEGIN OPENSSH PRIVATE KEY-----\n${b64}\n-----END OPENSSH PRIVATE KEY-----\n`,
    publicLine: `ssh-ed25519 ${pubBlob.toString("base64")} ${comment}`,
  }
}

const agentDir = join(work, "agent")
Bun.spawnSync(["mkdir", "-p", agentDir])
const agentSock = join(agentDir, "agent.sock")
const agent = Bun.spawn(["ssh-agent", "-D", "-a", agentSock], {
  stdout: "ignore",
  stderr: "ignore",
})
for (let i = 0; i < 50 && !existsSync(agentSock); i++) await Bun.sleep(20)
const key = opensshEd25519("keel/spike/deploy")
const agentEnv = { PATH: process.env.PATH ?? "", SSH_AUTH_SOCK: agentSock }
const added = sh(["ssh-add", "-t", "60", "-"], { env: agentEnv, stdin: key.privatePem })
const listed = sh(["ssh-add", "-L"], { env: agentEnv })
say("llave_en_memoria", {
  ssh_add: added.code === 0 ? "ok" : added.err,
  publica_coincide: listed.out
    .split("\n")
    .some((l) => l.split(" ")[1] === key.publicLine.split(" ")[1]),
  archivos_en_su_carpeta: readdirSync(agentDir),
})

// --- 3. askpass con token de un solo uso ---------------------------------------------------
const keyFile = join(work, "id_frase")
const phrase = "frase del spike 123"
sh(["ssh-keygen", "-q", "-t", "ed25519", "-N", phrase, "-C", "spike", "-f", keyFile])
const token = randomBytes(16).toString("hex")
const askDir = join(work, "ask")
Bun.spawnSync(["mkdir", "-p", askDir])
const askSock = join(askDir, "askpass.sock")
const prompts: string[] = []
let used = false
const askServer = Bun.listen({
  unix: askSock,
  socket: {
    data(s, d) {
      const [tok, prompt] = d.toString().split("\n")
      prompts.push(prompt ?? "")
      if (tok === token && !used) {
        used = true
        s.write(phrase)
      }
      s.end()
    },
  },
})
const askScript = join(askDir, "keel-askpass")
writeFileSync(
  askScript,
  `#!${process.execPath}\n` +
    `const s=await Bun.connect({unix:${JSON.stringify(askSock)},socket:{data(_s,d){process.stdout.write(d.toString()+"\\n")},close(){process.exit(0)}}});` +
    `s.write(process.env.KEEL_ASKPASS_TOKEN+"\\n"+(process.argv[2]??""))\n`,
  { mode: 0o700 },
)
const askEnv = {
  ...agentEnv,
  SSH_ASKPASS: askScript,
  SSH_ASKPASS_REQUIRE: "force",
  KEEL_ASKPASS_TOKEN: token,
  DISPLAY: "",
}
const viaAsk = await shAsync(["ssh-add", keyFile], askEnv)
const second = sh(["ssh-add", "-d", keyFile], { env: agentEnv })
const reuse = await shAsync(["ssh-add", keyFile], askEnv)
say("askpass", {
  primera: viaAsk.code === 0 ? "ok" : viaAsk.err,
  prompt: prompts[0],
  token_reusado: reuse.code === 0 ? "aceptado (mal)" : "rechazado",
  borrar: second.code === 0 ? "ok" : second.err,
})
askServer.stop(true)
agent.kill()

// --- 4. Llavero ------------------------------------------------------------------------------
say("llavero", {
  secret_service:
    sh([
      "gdbus",
      "introspect",
      "--session",
      "--dest",
      "org.freedesktop.secrets",
      "--object-path",
      "/org/freedesktop/secrets",
    ]).code === 0
      ? "responde"
      : "no responde",
  secret_tool: Bun.which("secret-tool") ?? "no instalado",
})

// --- 5. Cifrado ------------------------------------------------------------------------------
const kek = await crypto.subtle.generateKey({ name: "AES-KW", length: 256 }, true, [
  "wrapKey",
  "unwrapKey",
])
const dek = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, [
  "encrypt",
  "decrypt",
])
const nonce = crypto.getRandomValues(new Uint8Array(12))
const secret = "postgres://api:centinela-7f3@db/x"
const ct = await crypto.subtle.encrypt(
  { name: "AES-GCM", iv: nonce },
  dek,
  new TextEncoder().encode(secret),
)
const wrapped = await crypto.subtle.wrapKey("raw", dek, kek, "AES-KW")
const dek2 = await crypto.subtle.unwrapKey("raw", wrapped, kek, "AES-KW", "AES-GCM", false, [
  "decrypt",
])
const back = new TextDecoder().decode(
  await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, dek2, ct),
)
say("cifrado", {
  ida_y_vuelta: back === secret,
  dek_envuelta_bytes: wrapped.byteLength,
  claro_en_cifrado: Buffer.from(ct).includes(Buffer.from("centinela")),
})

rmSync(work, { recursive: true, force: true })
await Bun.write(
  join(
    import.meta.dir,
    "..",
    "captures",
    `vault-probe-${new Date().toISOString().slice(0, 10)}.json`,
  ),
  JSON.stringify(out, null, 2),
)
