/**
 * Las credenciales de las conexiones con método de entrada (ADR-0025 §3–§5): el puente
 * entre el vault, el ssh-agent de Keel, askpass y el humano. El broker las pide aquí;
 * el agente nunca las ve.
 *
 * - `password` y la frase de `file`: del vault; si no están, de lo que el humano dijo
 *   «recordar hasta cerrar Keel»; si tampoco, se le pregunta al humano.
 * - `ask`: nunca se guarda salvo que el humano lo pida al contestar.
 * - `key`: la llave del vault va al ssh-agent de Keel por la entrada estándar.
 * - `agent`: el ssh-agent del humano, tal cual.
 */
import { randomBytes } from "node:crypto"
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { ulid } from "../ids.js"
import type {
  ConnectionRow,
  Credentials,
  ExecuteContext,
  ResourceBroker,
} from "../resources/broker.js"
import { BrokerError } from "../resources/broker.js"
import { type KeelSshAgent, type SshTarget, sshOptions } from "./ssh.js"
import { type Vault, VaultError } from "./vault.js"

type Method = NonNullable<ConnectionRow["auth_method"]>
type AskEntry = {
  connection_id: string
  project_id: string
  purpose: "agent" | "human"
  ctx: ExecuteContext | null
  expires: number
  /** Valores entregados por askpass en esta sesión: se redactan de la salida. */
  served: string[]
}
type Prompt = {
  connection: ConnectionRow
  what: "password" | "passphrase"
  resolve: (
    v: { value: string; remember: "once" | "session" | "vault"; actor: string } | null,
  ) => void
}

export type CredentialsDeps = {
  vault: Vault
  agent: KeelSshAgent
  broker: ResourceBroker
  /** El `known_hosts` de Keel, en su estado privado. */
  knownHosts: string
  /** Ejecutable de `keel askpass` (un envoltorio en el estado de Keel). */
  askpass: string
  /** La puerta humana: askpass habla con el daemon por ella, con su token. */
  humanDoor: () => string
  emit: (projectId: string, runId: string | null, kind: string, payload: unknown) => void
  /** Cuánto se espera al humano; null = sin límite (ADR-0020 §3). */
  timeoutMs: () => number | null
}

export class CredentialService implements Credentials {
  private readonly deps: CredentialsDeps
  private readonly tokens = new Map<string, AskEntry>()
  private readonly prompts = new Map<string, Prompt>()
  /** «Recordar hasta cerrar Keel»: sólo en la memoria del daemon. */
  private readonly session = new Map<string, string>()
  constructor(deps: CredentialsDeps) {
    this.deps = deps
  }

  private target(conn: ConnectionRow): SshTarget {
    const c = JSON.parse(conn.config_json) as Record<string, unknown>
    return {
      host: String(c.host ?? ""),
      user: c.user ? String(c.user) : null,
      port: Number(c.port ?? 22),
      proxy_jump: c.proxy_jump ? String(c.proxy_jump) : null,
      identity_file: c.identity_file ? String(c.identity_file) : null,
    }
  }

  /** El `known_hosts` de Keel tiene la huella aceptada de la conexión. */
  private ensureKnownHost(conn: ConnectionRow): void {
    if (!conn.host_key) return
    const { line } = JSON.parse(conn.host_key) as { line: string }
    mkdirSync(dirname(this.deps.knownHosts), { recursive: true, mode: 0o700 })
    const current = existsSync(this.deps.knownHosts)
      ? readFileSync(this.deps.knownHosts, "utf8")
      : ""
    if (!current.split("\n").includes(line))
      appendFileSync(this.deps.knownHosts, `${line}\n`, { mode: 0o600 })
  }

  private baseEnv(): Record<string, string> {
    return {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: process.env.HOME ?? "",
      LANG: process.env.LANG ?? "C.UTF-8",
    }
  }

  private requireVaultOpen(): void {
    if (this.deps.vault.state() !== "unlocked")
      throw new BrokerError(
        "denied",
        "el vault de Keel está bloqueado: el humano lo abre en Conexiones (con el llavero o su frase)",
      )
  }

  private issueToken(
    conn: ConnectionRow,
    purpose: AskEntry["purpose"],
    ctx: ExecuteContext | null,
  ): {
    token: string
    entry: AskEntry
  } {
    const token = randomBytes(24).toString("hex")
    const entry: AskEntry = {
      connection_id: conn.id,
      project_id: conn.project_id,
      purpose,
      ctx,
      expires: Date.now() + 15 * 60_000,
      served: [],
    }
    this.tokens.set(token, entry)
    return { token, entry }
  }

  /** Opciones y entorno de `ssh` para una conexión, para una operación del agente o la terminal. */
  private async prepare(
    conn: ConnectionRow,
    purpose: AskEntry["purpose"],
    ctx: ExecuteContext | null,
  ): Promise<{ args: string[]; env: Record<string, string>; redact: string[]; done: () => void }> {
    const method = conn.auth_method as Method
    const t = this.target(conn)
    this.ensureKnownHost(conn)
    const env = this.baseEnv()
    const args = sshOptions(t, method, {
      knownHosts: this.deps.knownHosts,
      keelAgent: this.deps.agent.socket,
      interactive: purpose === "human",
    })
    let done = () => {}
    let redact: string[] = []
    if (method === "agent") {
      if (process.env.SSH_AUTH_SOCK) env.SSH_AUTH_SOCK = process.env.SSH_AUTH_SOCK
    } else if (method === "key") {
      this.requireVaultOpen()
      if (!conn.vault_item_id)
        throw new BrokerError("invalid", `${conn.name} no tiene llave en el vault`)
      await this.deps.vault.use(conn.vault_item_id, `ssh:${purpose}`, (pem) =>
        this.deps.agent.add(pem, 300),
      )
    } else {
      // password, ask y la frase de file: askpass con un token de esta sesión de ssh.
      if ((method === "password" || conn.vault_item_id) && conn.vault_item_id)
        this.requireVaultOpen()
      const { token, entry } = this.issueToken(conn, purpose, ctx)
      Object.assign(env, {
        SSH_ASKPASS: this.deps.askpass,
        SSH_ASKPASS_REQUIRE: "force",
        DISPLAY: process.env.DISPLAY || "keel",
        KEEL_ASKPASS_TOKEN: token,
        KEEL_SOCKET: this.deps.humanDoor(),
      })
      redact = entry.served
      // La terminal del humano dura lo que dure; una operación del agente, su ejecución.
      done = () => {
        if (purpose === "agent") this.tokens.delete(token)
      }
    }
    return { args, env, redact, done }
  }

  ssh(conn: ConnectionRow, ctx: ExecuteContext) {
    return this.prepare(conn, "agent", ctx)
  }

  /** ADR-0025 §5: lo que `keel ssh` necesita para abrir la terminal del humano. */
  async humanSession(
    conn: ConnectionRow,
  ): Promise<{ args: string[]; env: Record<string, string>; banner: string | null }> {
    if (conn.conn_type !== "ssh" || !conn.auth_method)
      throw new BrokerError("invalid", `${conn.name} no es una conexión SSH con método de entrada`)
    const p = await this.prepare(conn, "human", null)
    const t = this.target(conn)
    const dest = t.user ? `${t.user}@${t.host}` : t.host
    return {
      args: [...p.args, t.host],
      env: p.env,
      banner: conn.environment === "prod" ? `⚠  PRODUCCIÓN  ${conn.name}  (${dest})` : null,
    }
  }

  /** La contraseña de una base de datos (ADR-0025 §3). */
  async password(conn: ConnectionRow, ctx: ExecuteContext): Promise<string | null> {
    const method = conn.auth_method as Method
    if (method === "password" && conn.vault_item_id) {
      this.requireVaultOpen()
      return this.deps.vault.use(conn.vault_item_id, "broker", (v) => v)
    }
    if (method === "ask") return this.askHuman(conn, "password", "Contraseña", ctx)
    return null
  }

  /** El valor que pide `keel askpass` con su token. */
  async askpass(token: string, prompt: string): Promise<{ value: string | null; ask: boolean }> {
    const entry = this.tokens.get(token)
    if (!entry || entry.expires < Date.now())
      throw new VaultError("invalid", "token de askpass inválido o vencido")
    const conn = this.deps.broker.find(entry.project_id, entry.connection_id)
    const what = conn.auth_method === "file" ? "passphrase" : "password"
    // Una confirmación de huella nunca la contesta Keel: la acepta el humano en la conexión.
    if (/yes\/no|fingerprint/i.test(prompt)) return { value: null, ask: false }
    let value: string | null = null
    if (conn.vault_item_id && this.deps.vault.state() === "unlocked")
      value = await this.deps.vault.use(conn.vault_item_id, `askpass:${entry.purpose}`, (v) => v)
    value ??= this.session.get(`${conn.id}:${what}`) ?? null
    if (value === null && entry.purpose === "human") return { value: null, ask: true }
    if (value === null) value = await this.askHuman(conn, what, prompt, entry.ctx)
    entry.served.push(value)
    return { value, ask: false }
  }

  /** Lo que el humano escribió en su terminal, para recordarlo (ADR-0025 §4). */
  async remember(
    token: string,
    value: string,
    scope: "session" | "vault",
    actor: string,
  ): Promise<void> {
    const entry = this.tokens.get(token)
    if (!entry || entry.expires < Date.now())
      throw new VaultError("invalid", "token de askpass inválido o vencido")
    const conn = this.deps.broker.find(entry.project_id, entry.connection_id)
    await this.keep(
      conn,
      conn.auth_method === "file" ? "passphrase" : "password",
      value,
      scope,
      actor,
    )
  }

  private async keep(
    conn: ConnectionRow,
    what: "password" | "passphrase",
    value: string,
    scope: "once" | "session" | "vault",
    actor: string,
  ): Promise<void> {
    if (scope === "session") this.session.set(`${conn.id}:${what}`, value)
    if (scope !== "vault") return
    this.requireVaultOpen()
    if (conn.vault_item_id) await this.deps.vault.rotate(conn.vault_item_id, value, actor)
    else {
      const id = await this.deps.vault.put({
        project_id: conn.project_id,
        kind: what,
        label: conn.name,
        value,
        actor,
      })
      this.deps.broker.update(conn, {
        vault_item_id: id,
        ...(conn.auth_method === "ask" ? { auth_method: "password" as const } : {}),
      })
    }
  }

  /**
   * Pregunta al humano en la GUI (ADR-0025 §4, método `ask`): el evento no lleva nada
   * secreto; la respuesta llega por `secrets.prompt_answer`.
   */
  private askHuman(
    conn: ConnectionRow,
    what: "password" | "passphrase",
    text: string,
    ctx: ExecuteContext | null,
  ): Promise<string> {
    const id = ulid()
    const timeout = this.deps.timeoutMs() ?? 10 * 60_000
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.prompts.delete(id)
        this.deps.emit(conn.project_id, ctx?.runId ?? null, "secret.prompt_resolved", {
          prompt_id: id,
          outcome: "expired",
        })
        reject(
          new BrokerError(
            "denied",
            `nadie dio la ${what === "password" ? "contraseña" : "frase"} de ${conn.name} a tiempo`,
          ),
        )
      }, timeout)
      this.prompts.set(id, {
        connection: conn,
        what,
        resolve: (answer) => {
          clearTimeout(timer)
          this.prompts.delete(id)
          this.deps.emit(conn.project_id, ctx?.runId ?? null, "secret.prompt_resolved", {
            prompt_id: id,
            outcome: answer ? "answered" : "cancelled",
            remember: answer?.remember ?? null,
          })
          if (!answer) {
            reject(
              new BrokerError(
                "denied",
                `el humano no dio la ${what === "password" ? "contraseña" : "frase"} de ${conn.name}`,
              ),
            )
            return
          }
          void this.keep(conn, what, answer.value, answer.remember, answer.actor)
            .catch(() => {})
            .finally(() => resolve(answer.value))
        },
      })
      this.deps.emit(conn.project_id, ctx?.runId ?? null, "secret.prompt_requested", {
        prompt_id: id,
        connection_id: conn.id,
        connection_name: conn.name,
        environment: conn.environment,
        what,
        text,
        work_item_id: ctx?.workItemId ?? null,
      })
    })
  }

  answer(
    promptId: string,
    answer: { value: string; remember: "once" | "session" | "vault"; actor: string } | null,
  ): void {
    const p = this.prompts.get(promptId)
    if (!p) throw new VaultError("not_found", "esa pregunta ya no está abierta")
    p.resolve(answer)
  }

  /** Reescribe el `known_hosts` de Keel con las huellas aceptadas. */
  writeKnownHosts(lines: string[]): void {
    mkdirSync(dirname(this.deps.knownHosts), { recursive: true, mode: 0o700 })
    writeFileSync(this.deps.knownHosts, lines.length ? `${lines.join("\n")}\n` : "", {
      mode: 0o600,
    })
  }

  stop(): void {
    for (const p of this.prompts.values()) p.resolve(null)
    this.tokens.clear()
    this.session.clear()
    this.deps.agent.stop()
  }
}
