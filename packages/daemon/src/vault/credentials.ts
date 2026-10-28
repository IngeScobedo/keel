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
import { dirname, join } from "node:path"
import { ulid } from "../ids.js"
import { shQuote, sshWrapper } from "../resources/ansible.js"
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
  /** null = git (ADR-0028): la frase de la llave del humano para fetch o pull. */
  connection_id: string | null
  project_id: string
  purpose: "agent" | "human" | "git"
  ctx: ExecuteContext | null
  expires: number
  /** Valores entregados por askpass en esta sesión: se redactan de la salida. */
  served: string[]
  /**
   * El mismo valor para toda la operación: la contraseña de `ansible-vault` se pide una
   * vez aunque Ansible la lea varias (ADR-0031 §6).
   */
  reuse?: boolean
}
/** A quién se refiere una pregunta de secreto: una conexión o la llave de git. */
type PromptTarget = { project_id: string; id: string; name: string; environment: string }
type Prompt = {
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

  /**
   * ADR-0031 §2 y §6: lo que necesita `ansible-playbook` para un despliegue. Cada host
   * entra por un envoltorio de `ssh` con las opciones y el askpass de su conexión; la
   * contraseña de `ansible-vault` sale por un script con un token de esta operación.
   */
  async ansible(
    conn: ConnectionRow,
    hosts: ConnectionRow[],
    ctx: ExecuteContext,
    runDir: string,
  ): Promise<{
    ssh: Map<string, string>
    vaultPass: string | null
    env: Record<string, string>
    redact: () => string[]
    done: () => void
  }> {
    const served: string[][] = []
    const finish: (() => void)[] = []
    const ssh = new Map<string, string>()
    try {
      for (const [i, h] of hosts.entries()) {
        if (h.conn_type !== "ssh" || !h.auth_method)
          throw new BrokerError(
            "invalid",
            `${h.name} no es una conexión SSH del vault: Ansible entra sólo por conexiones con método de entrada`,
          )
        const p = await this.prepare(h, "agent", ctx)
        finish.push(p.done)
        served.push(p.redact)
        const path = join(runDir, `ssh-${i}`)
        const cfg = JSON.parse(h.config_json) as { ssh_path?: string }
        sshWrapper(path, cfg.ssh_path ?? "ssh", p.args, p.env)
        ssh.set(h.id, path)
      }
    } catch (e) {
      for (const f of finish) f()
      throw e
    }
    let vaultPass: string | null = null
    if (conn.auth_method) {
      if (conn.auth_method === "password" && conn.vault_item_id) this.requireVaultOpen()
      const { token, entry } = this.issueToken(conn, "agent", ctx)
      entry.reuse = true
      served.push(entry.served)
      finish.push(() => this.tokens.delete(token))
      vaultPass = join(runDir, "vault-pass")
      writeFileSync(
        vaultPass,
        `#!/bin/sh\nexport KEEL_ASKPASS_TOKEN=${shQuote(token)}\nexport KEEL_SOCKET=${shQuote(this.deps.humanDoor())}\nexec ${shQuote(this.deps.askpass)} ${shQuote(`Contraseña de ansible-vault (${conn.name})`)}\n`,
        { mode: 0o700 },
      )
    }
    return {
      ssh,
      vaultPass,
      env: this.baseEnv(),
      // Se lee al final: lo que askpass entregue durante la ejecución también se redacta.
      redact: () => served.flat(),
      done: () => {
        for (const f of finish) f()
      },
    }
  }

  /** La contraseña de una base de datos (ADR-0025 §3). */
  async password(conn: ConnectionRow, ctx: ExecuteContext): Promise<string | null> {
    const method = conn.auth_method as Method
    if (method === "password" && conn.vault_item_id) {
      this.requireVaultOpen()
      return this.deps.vault.use(conn.vault_item_id, "broker", (v) => v)
    }
    if (method === "ask")
      return this.askHuman(
        {
          project_id: conn.project_id,
          id: conn.id,
          name: conn.name,
          environment: conn.environment,
        },
        "password",
        "Contraseña",
        ctx,
        (v, scope, actor) => this.keep(conn, "password", v, scope, actor),
      )
    return null
  }

  /** El valor que pide `keel askpass` con su token. */
  async askpass(token: string, prompt: string): Promise<{ value: string | null; ask: boolean }> {
    const entry = this.tokens.get(token)
    if (!entry || entry.expires < Date.now())
      throw new VaultError("invalid", "token de askpass inválido o vencido")
    // Una confirmación de huella nunca la contesta Keel: la acepta el humano.
    if (/yes\/no|fingerprint/i.test(prompt)) return { value: null, ask: false }
    if (entry.connection_id === null) return this.gitAskpass(entry, prompt)
    if (entry.reuse && entry.served.length > 0)
      return { value: entry.served[0] as string, ask: false }
    const conn = this.deps.broker.find(entry.project_id, entry.connection_id)
    const what = conn.auth_method === "file" ? "passphrase" : "password"
    let value: string | null = null
    if (conn.vault_item_id && this.deps.vault.state() === "unlocked")
      value = await this.deps.vault.use(conn.vault_item_id, `askpass:${entry.purpose}`, (v) => v)
    value ??= this.session.get(`${conn.id}:${what}`) ?? null
    if (value === null && entry.purpose === "human") return { value: null, ask: true }
    if (value === null)
      value = await this.askHuman(
        {
          project_id: conn.project_id,
          id: conn.id,
          name: conn.name,
          environment: conn.environment,
        },
        what,
        prompt,
        entry.ctx,
        (v, scope, actor) => this.keep(conn, what, v, scope, actor),
      )
    entry.served.push(value)
    return { value, ask: false }
  }

  /**
   * ADR-0028: git pide la frase de la llave del humano. Keel no lee la llave: la lee
   * ssh. La frase sale de la sesión, del vault (si el humano la guardó) o del humano.
   */
  private async gitAskpass(
    entry: AskEntry,
    prompt: string,
  ): Promise<{ value: string | null; ask: boolean }> {
    const key = /passphrase for (?:key )?'([^']+)'/i.exec(prompt)?.[1]
    // Sólo frases de llaves: usuario y contraseña de un proveedor de git no pasan por Keel.
    if (!key) return { value: null, ask: false }
    const label = `ssh-key:${key}`
    let value = this.session.get(label) ?? null
    if (value === null && this.deps.vault.state() === "unlocked") {
      const id = this.deps.vault.findByLabel(label)
      if (id) value = await this.deps.vault.use(id, "askpass:git", (v) => v)
    }
    value ??= await this.askHuman(
      { project_id: entry.project_id, id: label, name: `git · ${key}`, environment: "dev" },
      "passphrase",
      prompt,
      null,
      async (v, scope, actor) => {
        if (scope === "session") this.session.set(label, v)
        if (scope !== "vault") return
        this.requireVaultOpen()
        const existing = this.deps.vault.findByLabel(label)
        if (existing) await this.deps.vault.rotate(existing, v, actor)
        else
          await this.deps.vault.put({
            project_id: null,
            kind: "passphrase",
            label,
            value: v,
            actor,
          })
      },
    )
    entry.served.push(value)
    return { value, ask: false }
  }

  /** El entorno de git para fetch y pull del humano (ADR-0028): askpass sólo para frases. */
  gitEnv(projectId: string, noAskpass: string): { env: Record<string, string>; done: () => void } {
    const token = randomBytes(24).toString("hex")
    this.tokens.set(token, {
      connection_id: null,
      project_id: projectId,
      purpose: "git",
      ctx: null,
      expires: Date.now() + 5 * 60_000,
      served: [],
    })
    return {
      env: {
        GIT_TERMINAL_PROMPT: "0",
        // Usuario y contraseña de un proveedor de git: nunca por Keel.
        GIT_ASKPASS: noAskpass,
        SSH_ASKPASS: this.deps.askpass,
        SSH_ASKPASS_REQUIRE: "force",
        DISPLAY: process.env.DISPLAY || "keel",
        KEEL_ASKPASS_TOKEN: token,
        KEEL_SOCKET: this.deps.humanDoor(),
      },
      done: () => this.tokens.delete(token),
    }
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
    if (entry.connection_id === null) return
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
    target: PromptTarget,
    what: "password" | "passphrase",
    text: string,
    ctx: ExecuteContext | null,
    keep: (value: string, scope: "once" | "session" | "vault", actor: string) => Promise<void>,
  ): Promise<string> {
    const id = ulid()
    const timeout = this.deps.timeoutMs() ?? 10 * 60_000
    const noun = what === "password" ? "contraseña" : "frase"
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.prompts.delete(id)
        this.deps.emit(target.project_id, ctx?.runId ?? null, "secret.prompt_resolved", {
          prompt_id: id,
          outcome: "expired",
        })
        reject(new BrokerError("denied", `nadie dio la ${noun} de ${target.name} a tiempo`))
      }, timeout)
      this.prompts.set(id, {
        what,
        resolve: (answer) => {
          clearTimeout(timer)
          this.prompts.delete(id)
          this.deps.emit(target.project_id, ctx?.runId ?? null, "secret.prompt_resolved", {
            prompt_id: id,
            outcome: answer ? "answered" : "cancelled",
            remember: answer?.remember ?? null,
          })
          if (!answer) {
            reject(new BrokerError("denied", `el humano no dio la ${noun} de ${target.name}`))
            return
          }
          void keep(answer.value, answer.remember, answer.actor)
            .catch(() => {})
            .finally(() => resolve(answer.value))
        },
      })
      this.deps.emit(target.project_id, ctx?.runId ?? null, "secret.prompt_requested", {
        prompt_id: id,
        connection_id: target.id,
        connection_name: target.name,
        environment: target.environment,
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
