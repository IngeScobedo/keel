/**
 * Intermediario de recursos (ADR-0013): el agente recibe operaciones, no
 * credenciales. El daemon resuelve el secreto sólo al ejecutar, ejecuta con
 * él, borra su valor literal de la salida, guarda el resultado como evidencia
 * con su procedencia y emite el evento semántico instrumentado. La política es
 * por conexión, operación y entorno; en producción las escrituras nunca son
 * `auto` y lo que se produce es `restricted`.
 */
import type { Database } from "bun:sqlite"
import { spawn, spawnSync } from "node:child_process"
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { isAbsolute, join, relative, resolve } from "node:path"
import {
  CONNECTION_OPERATIONS,
  type ConnectionType,
  classifySshCommand,
  type SshRisk,
  sshProgramsCovered,
  WRITE_OPERATIONS,
} from "@keel/core"
import { SQL } from "bun"
import type { ArtifactStore, Sensitivity } from "../artifacts.js"
import { canonicalJson, sha256Hex, ulid } from "../ids.js"
import { tableFromText } from "../semantic.js"
import {
  AnsibleError,
  type AnsibleEvent,
  type AnsibleHost,
  ansibleEnv,
  ansibleSpec,
  deployDigest,
  playbookArgs,
  playbookDir,
  prepareRunDir,
  runPlaybook,
  secretLeaves,
  summarize,
  vaultFiles,
} from "./ansible.js"
import { redactKnownPatterns, redactSecrets, resolveSecret } from "./secrets.js"
import {
  changesFromShow,
  countsOf,
  liveEvent,
  outputsOf,
  planSummary,
  TerraformError,
  type TfDetails,
  terraform,
} from "./terraform.js"
import { TunnelError, TunnelPool } from "./tunnel.js"

export type ConnectionRow = {
  id: string
  project_id: string
  name: string
  conn_type: string
  config_json: string
  secret_ref: string | null
  secret_ref_ro: string | null
  environment: "dev" | "staging" | "prod"
  guarantees_json: string
  created_at: string | null
  archived_at: string | null
  /** ADR-0025 §3: null = la referencia de ADR-0013. */
  auth_method?: "agent" | "file" | "key" | "password" | "ask" | null
  vault_item_id?: string | null
  /** JSON `{line, fingerprint, type}` de la huella aceptada. */
  host_key?: string | null
  tags_json?: string
}

export type Policy = "auto" | "ask" | "deny"

/**
 * Lo que el broker pide al daemon para una conexión con método de entrada (ADR-0025):
 * el broker decide y ejecuta, el daemon tiene el vault, el ssh-agent y askpass.
 */
export type Credentials = {
  ssh(
    conn: ConnectionRow,
    ctx: ExecuteContext,
  ): Promise<{ args: string[]; env: Record<string, string>; redact: string[]; done: () => void }>
  password(conn: ConnectionRow, ctx: ExecuteContext): Promise<string | null>
  /** ADR-0031: los `ssh` de cada host y el script de la contraseña de `ansible-vault`. */
  ansible?(
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
  }>
}

/** ADR-0031 §3: el checkout desde el que se despliega, al día y limpio. */
export type DeployBase = {
  root: string
  commit: string | null
  upstream: string | null
  behind: number
  /** Cambios sin commit en la carpeta del playbook (los ignorados por git no cuentan). */
  dirty: string[]
  error: string | null
}

export type ExecuteContext = {
  projectId: string
  runId: string | null
  workItemId: string | null
  actor: { id: string; kind: string }
}

export type BrokerResult = {
  operation: string
  summary: string
  columns?: string[]
  rows?: unknown[][]
  row_count?: number
  truncated?: boolean
  output?: string
  exit_code?: number | null
  plan_sha256?: string
  /** Resumen estructurado y corto para el agente y la tarjeta (ADR-0031 §5). */
  details?: unknown
  evidence_id: string | null
  result_ref: string | null
}

export type BrokerDeps = {
  db: Database
  artifacts: ArtifactStore
  /** Evento del daemon (fuente `daemon`): los semánticos nacen instrumentados. */
  emit: (projectId: string, runId: string | null, kind: string, payload: unknown) => void
  addEvidence: (e: {
    project_id: string
    work_item_id: string | null
    run_id: string | null
    kind: string
    title: string
    artifact_ref: string
    sha256: string
    metadata: unknown
    provenance: unknown
    created_by: string
  }) => string
  /** Pregunta al humano y espera; sólo para agentes con run. */
  ask: (
    ctx: ExecuteContext,
    operation: { tool: string; input: unknown },
  ) => Promise<"approved" | "denied" | "expired">
  /** Carpeta privada de Keel donde viven los planes de Terraform (llevan variables). */
  plansDir: string
  env?: Record<string, string | undefined>
  /** ADR-0025: credenciales del vault para las conexiones con método. */
  credentials?: Credentials
  /** ADR-0031 §3: el checkout del proyecto y si está al día; `dir` relativo a él. */
  deployBase?: (projectId: string, dir: string) => Promise<DeployBase>
  /** La carpeta del proyecto: una carpeta de Terraform relativa se resuelve contra ella. */
  projectRoot?: (projectId: string) => string
}

/** Cómo se nombra cada clase de comando ante el agente y el humano (ADR-0032 §3). */
export const RISK_LABEL = {
  read: "lectura",
  service: "servicio",
  destructive: "destructivo",
} as const

export class BrokerError extends Error {
  readonly code: "not_found" | "invalid" | "denied" | "failed"
  constructor(code: BrokerError["code"], message: string) {
    super(message)
    this.code = code
  }
}

/** Filas que vuelven al agente; el resultado entero queda como artefacto. */
export const AGENT_ROWS = 200
export const STATEMENT_TIMEOUT_MS = 15_000

const DEFAULT_GUARANTEES: Record<ConnectionType, string> = {
  postgres:
    "Lecturas en una transacción READ ONLY con statement_timeout y tope de filas; si hay credencial de sólo lectura, se usa.",
  sqlite: "Las lecturas abren el archivo en modo sólo lectura (mode=ro): la base rechaza escribir.",
  ssh: "En producción cada comando pregunta (salvo que quites la pregunta asumiendo el riesgo) y la salida se redacta; la garantía real es un usuario restringido o un comando forzado en el servidor.",
  terraform: "apply sólo ejecuta el archivo de plan aprobado, atado a su hash.",
  ansible:
    "El despliegue sólo corre lo que se revisó en el check: mismo commit, mismos archivos y mismos hosts. Entra por las conexiones SSH del vault con su huella.",
}

export class ResourceBroker {
  private readonly deps: BrokerDeps
  /** ADR-0033: los túneles SSH hacia las bases, abiertos por uso. */
  readonly tunnels = new TunnelPool()
  /** Checks y despliegues en curso, para poder cancelarlos (por `run_key`). */
  private readonly running = new Map<string, AbortController>()

  /** Cancela un check o un despliegue de Ansible en curso. */
  cancel(runKey: string): boolean {
    const c = this.running.get(runKey)
    if (!c) return false
    c.abort()
    return true
  }
  constructor(deps: BrokerDeps) {
    this.deps = deps
  }

  /** Al apagar el daemon: ningún túnel queda abierto. */
  close(): void {
    this.tunnels.closeWhere(() => true)
  }

  /**
   * ADR-0033 §2: la base detrás de una conexión SSH. Devuelve la config con el puerto
   * local del túnel en lugar del host y el puerto que ve el servidor.
   */
  private async viaTunnel(
    ctx: ExecuteContext,
    conn: ConnectionRow,
    config: Record<string, unknown>,
  ): Promise<{
    config: Record<string, unknown>
    opened_ms: number
    release: () => void
    redact: () => string[]
  } | null> {
    const via = typeof config.via === "string" && config.via ? config.via : null
    if (!via) return null
    const creds = this.deps.credentials
    if (!creds) throw new BrokerError("failed", "este daemon no tiene credenciales para túneles")
    const ssh = this.find(ctx.projectId, via)
    if (ssh.conn_type !== "ssh" || !ssh.auth_method)
      throw new BrokerError("invalid", `${via} no es una conexión SSH del vault`)
    const sshCfg = JSON.parse(ssh.config_json) as Record<string, unknown>
    let served: string[] = []
    try {
      const t = await this.tunnels.acquire(
        `${ctx.runId ?? "human"}:${conn.id}`,
        String(sshCfg.host ?? ""),
        { host: String(config.host ?? "127.0.0.1"), port: Number(config.port ?? 5432) },
        async () => {
          const prep = await creds.ssh(ssh, ctx)
          served = prep.redact
          return { ...prep, ssh: String(sshCfg.ssh_path ?? "ssh") }
        },
      )
      return {
        config: { ...config, host: "127.0.0.1", port: t.port },
        opened_ms: t.opened_ms,
        release: t.release,
        redact: () => served,
      }
    } catch (e) {
      if (e instanceof TunnelError)
        throw new BrokerError("failed", `${via}: ${redactSecrets(e.message, served)}`)
      throw e
    }
  }

  /**
   * ADR-0033 §3: «Probar conexión». Por el mismo camino que una consulta (túnel incluido),
   * en una transacción de sólo lectura y con la credencial con que lee el agente.
   */
  async test(
    ctx: ExecuteContext,
    nameOrId: string,
  ): Promise<{
    ok: boolean
    user: string | null
    database: string | null
    version: string | null
    read_only: boolean | null
    ro_credential: boolean
    tunnel_ms: number | null
    db_ms: number | null
    via: string | null
    error: string | null
  }> {
    const conn = this.find(ctx.projectId, nameOrId)
    if (conn.conn_type !== "postgres" && conn.conn_type !== "sqlite")
      throw new BrokerError("invalid", "por ahora se prueban las bases (PostgreSQL y SQLite)")
    const config = JSON.parse(conn.config_json) as Record<string, unknown>
    const roCredential = conn.secret_ref_ro !== null || Boolean(config.user_ro)
    const out = {
      ok: false,
      user: null as string | null,
      database: null as string | null,
      version: null as string | null,
      read_only: null as boolean | null,
      ro_credential: roCredential,
      tunnel_ms: null as number | null,
      db_ms: null as number | null,
      via: typeof config.via === "string" ? config.via : null,
      error: null as string | null,
    }
    const secrets: string[] = []
    let tunnel: Awaited<ReturnType<ResourceBroker["viaTunnel"]>> = null
    try {
      if (conn.conn_type === "sqlite") {
        const started = performance.now()
        const db = new SQL(`sqlite://${String(config.path ?? "")}?mode=ro`)
        try {
          const [v] = (await db.unsafe("select sqlite_version() as v")) as { v: string }[]
          out.version = `SQLite ${v?.v ?? "?"}`
          out.database = String(config.path ?? "")
          out.read_only = true
        } finally {
          await db.close()
        }
        out.db_ms = Math.round(performance.now() - started)
        out.ok = true
        return out
      }
      const managed = Boolean(conn.auth_method) && Boolean(this.deps.credentials)
      const ref = conn.secret_ref_ro ?? conn.secret_ref
      const secret = managed
        ? await (this.deps.credentials as Credentials).password(conn, ctx)
        : ref
          ? resolveSecret(ref, this.deps.env ?? process.env)
          : null
      if (secret) secrets.push(secret)
      tunnel = await this.viaTunnel(ctx, conn, config)
      if (tunnel) out.tunnel_ms = tunnel.opened_ms
      const cfg = tunnel?.config ?? config
      const started = performance.now()
      const db = new SQL({
        hostname: String(cfg.host ?? "localhost"),
        port: Number(cfg.port ?? 5432),
        database: String(cfg.database ?? ""),
        username: String(cfg.user_ro || cfg.user || ""),
        ...(secret ? { password: secret } : {}),
        max: 1,
        connectionTimeout: 15,
      })
      try {
        const row = (await db.begin(async (tx) => {
          await tx.unsafe("SET TRANSACTION READ ONLY")
          const [r] = (await tx.unsafe(
            "select current_user as u, current_database() as d, version() as v, current_setting('transaction_read_only') as ro",
          )) as { u: string; d: string; v: string; ro: string }[]
          return r
        })) as { u: string; d: string; v: string; ro: string } | undefined
        out.user = row?.u ?? null
        out.database = row?.d ?? null
        out.version = row?.v ? (row.v.split(" on ")[0] ?? row.v) : null
        out.read_only = row ? row.ro === "on" : null
      } finally {
        await db.close()
      }
      out.db_ms = Math.round(performance.now() - started)
      out.ok = true
    } catch (e) {
      const all = [...secrets, ...(tunnel?.redact() ?? [])]
      out.error = redactKnownPatterns(
        redactSecrets(e instanceof Error ? e.message : String(e), all),
      )
    } finally {
      tunnel?.release()
    }
    return out
  }

  // --- conexiones y permisos ---------------------------------------------------------
  connections(projectId: string): ConnectionRow[] {
    return this.deps.db
      .query<ConnectionRow, [string]>(
        "SELECT * FROM connections WHERE project_id = ? AND archived_at IS NULL ORDER BY name",
      )
      .all(projectId)
  }

  find(projectId: string, nameOrId: string): ConnectionRow {
    const c = this.connections(projectId).find((x) => x.id === nameOrId || x.name === nameOrId)
    if (!c) throw new BrokerError("not_found", `la conexión ${nameOrId} no existe en este proyecto`)
    return c
  }

  add(p: {
    project_id: string
    name: string
    type: ConnectionType
    environment: "dev" | "staging" | "prod"
    config: Record<string, unknown>
    secret_ref?: string | undefined
    secret_ref_ro?: string | undefined
    server_guarantee?: string | undefined
    auth_method?: ConnectionRow["auth_method"] | undefined
    vault_item_id?: string | null | undefined
    tags?: string[] | undefined
    host_key?: string | null | undefined
  }): ConnectionRow {
    // ADR-0033 §1: una base por túnel va por una conexión SSH del proyecto, y no es menos
    // sensible que el servidor por el que pasa.
    if (p.type === "postgres" && typeof p.config.via === "string" && p.config.via) {
      const ssh = this.find(p.project_id, p.config.via)
      if (ssh.conn_type !== "ssh")
        throw new BrokerError("invalid", `${p.config.via} no es una conexión SSH`)
      const rank = { dev: 0, staging: 1, prod: 2 } as const
      if (rank[ssh.environment] > rank[p.environment])
        throw new BrokerError(
          "invalid",
          `la base pasa por ${ssh.name} (${ssh.environment}): su entorno no puede ser ${p.environment}`,
        )
    }
    // ADR-0031: cada host del playbook va a una conexión SSH del vault, y el destino es
    // tan sensible como la más sensible de ellas.
    if (p.type === "ansible") {
      try {
        const spec = ansibleSpec(p.config)
        const rank = { dev: 0, staging: 1, prod: 2 } as const
        let env: ConnectionRow["environment"] = "dev"
        for (const c of Object.values(spec.hosts)) {
          const h = this.find(p.project_id, c)
          if (h.conn_type !== "ssh") throw new BrokerError("invalid", `${c} no es una conexión SSH`)
          if (rank[h.environment] > rank[env]) env = h.environment
        }
        if (rank[env] > rank[p.environment])
          throw new BrokerError(
            "invalid",
            `el destino despliega a una conexión ${env}: su entorno no puede ser ${p.environment}`,
          )
      } catch (e) {
        if (e instanceof AnsibleError) throw new BrokerError("invalid", e.message)
        throw e
      }
    }
    // La configuración no lleva secretos: si trae algo con forma de contraseña, se rechaza.
    for (const k of Object.keys(p.config))
      if (/pass|secret|token|key/i.test(k) && typeof p.config[k] === "string")
        throw new BrokerError(
          "invalid",
          `«${k}» parece un secreto: usa secret_ref (env:, keychain:, op://, vault:)`,
        )
    const id = ulid()
    this.deps.db
      .query(
        `INSERT INTO connections(id, project_id, name, conn_type, config_json, secret_ref, secret_ref_ro,
           environment, guarantees_json, created_at, auth_method, vault_item_id, tags_json, host_key)
         VALUES (?,?,?,?,?,?,?,?,?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), ?,?,?,?)`,
      )
      .run(
        id,
        p.project_id,
        p.name,
        p.type,
        JSON.stringify(p.config),
        p.secret_ref ?? null,
        p.secret_ref_ro ?? null,
        p.environment,
        JSON.stringify({ server: p.server_guarantee ?? null, keel: DEFAULT_GUARANTEES[p.type] }),
        p.auth_method ?? null,
        p.vault_item_id ?? null,
        JSON.stringify(p.tags ?? []),
        p.host_key ?? null,
      )
    return this.find(p.project_id, id)
  }

  /** ADR-0025: cambia lo que no es la identidad de la conexión. */
  update(
    conn: ConnectionRow,
    patch: Partial<{
      environment: ConnectionRow["environment"]
      auth_method: ConnectionRow["auth_method"]
      vault_item_id: string | null
      host_key: string | null
      tags: string[]
      config: Record<string, unknown>
      server_guarantee: string | null
    }>,
  ): ConnectionRow {
    const sets: string[] = []
    const args: (string | null)[] = []
    const col = (k: string, v: string | null) => {
      sets.push(`${k} = ?`)
      args.push(v)
    }
    if (patch.environment) col("environment", patch.environment)
    if (patch.auth_method !== undefined) col("auth_method", patch.auth_method ?? null)
    if (patch.vault_item_id !== undefined) col("vault_item_id", patch.vault_item_id)
    if (patch.host_key !== undefined) col("host_key", patch.host_key)
    if (patch.tags) col("tags_json", JSON.stringify(patch.tags))
    if (patch.config) col("config_json", JSON.stringify(patch.config))
    if (patch.server_guarantee !== undefined) {
      const g = JSON.parse(conn.guarantees_json) as { server: string | null; keel: string }
      col("guarantees_json", JSON.stringify({ ...g, server: patch.server_guarantee }))
    }
    if (sets.length)
      this.deps.db
        .query(`UPDATE connections SET ${sets.join(", ")} WHERE id = ?`)
        .run(...args, conn.id)
    return this.find(conn.project_id, conn.id)
  }

  archive(projectId: string, id: string): void {
    this.find(projectId, id)
    this.deps.db
      .query(
        "UPDATE connections SET archived_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?",
      )
      .run(id)
  }

  /** Nuevo permiso para la operación; el anterior queda revocado. */
  setGrant(
    conn: ConnectionRow,
    operation: string,
    policy: Policy,
    actor: string,
    expiresAt: string | null,
    o: {
      riskConfirm?: string | undefined
      workItemId?: string | undefined
      /** ADR-0032 §2: aprobado desde un comando; el grant cubre sólo su clase y programas. */
      sshRisk?: SshRisk | undefined
    } = {},
  ): { risk_accepted: boolean } {
    this.assertOperation(conn, operation)
    if (o.sshRisk?.class === "destructive")
      throw new BrokerError(
        "invalid",
        "un comando destructivo se aprueba cada vez: ningún permiso lo cubre (ADR-0032)",
      )
    // ADR-0026: en producción ejecutar pregunta; quitar la pregunta exige escribir el
    // nombre de la conexión, y queda a nombre del humano.
    const risky =
      policy === "auto" &&
      conn.environment === "prod" &&
      (WRITE_OPERATIONS as readonly string[]).includes(operation)
    if (risky && o.riskConfirm !== conn.name)
      throw new BrokerError(
        "invalid",
        `en producción ${operation} pregunta cada vez; para quitar la pregunta escribe el nombre de la conexión (${conn.name}) y asume el riesgo (ADR-0026)`,
      )
    const db = this.deps.db
    // Un permiso de tarea no revoca el del proyecto; uno del proyecto reemplaza al anterior.
    // Uno acotado a una clase de comando tampoco: es un permiso más angosto, al lado.
    if (!o.workItemId && !o.sshRisk)
      db.query(
        "UPDATE permission_grants SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE connection_id = ? AND operation = ? AND revoked_at IS NULL AND json_extract(scope_json, '$.work_item_id') IS NULL",
      ).run(conn.id, operation)
    db.query(
      `INSERT INTO permission_grants(id, project_id, connection_id, policy, scope_json, granted_by, expires_at, operation, risk_accepted_at)
       VALUES (?,?,?,?,?,?,?,?, CASE WHEN ? THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now') ELSE NULL END)`,
    ).run(
      ulid(),
      conn.project_id,
      conn.id,
      policy,
      JSON.stringify({
        operation,
        environment: conn.environment,
        ...(o.workItemId ? { work_item_id: o.workItemId } : {}),
        ...(o.sshRisk ? { ssh: { class: o.sshRisk.class, programs: o.sshRisk.programs } } : {}),
      }),
      actor,
      expiresAt,
      operation,
      risky ? 1 : 0,
    )
    return { risk_accepted: risky }
  }

  /**
   * La política vigente: sin grant se pregunta. En prod ejecutar pregunta, salvo que el
   * humano haya quitado la pregunta asumiendo el riesgo (ADR-0026). Un permiso de la
   * tarea («esta tarea», ADR-0025 §7) vale sólo para ella y caduca.
   *
   * Con la clase de un comando SSH (ADR-0032 §2): lo destructivo pregunta siempre; una
   * lectura fuera de prod no pregunta, y en prod sólo si la conexión lo tiene encendido;
   * un grant aprobado desde un comando cubre sólo su clase y sus programas.
   */
  policy(
    conn: ConnectionRow,
    operation: string,
    workItemId: string | null = null,
    risk: SshRisk | null = null,
  ): { policy: Policy; effective: Policy; risk_accepted_at: string | null } {
    const now = new Date().toISOString()
    type Row = { policy: string; risk_accepted_at: string | null; scope_json: string }
    const rows = (scoped: boolean) =>
      this.deps.db
        .query<Row, [string, string, string, string]>(
          `SELECT policy, risk_accepted_at, scope_json FROM permission_grants WHERE connection_id = ? AND operation = ? AND revoked_at IS NULL
             AND (expires_at IS NULL OR expires_at > ?)
             AND ${scoped ? "json_extract(scope_json, '$.work_item_id') = ?" : "(json_extract(scope_json, '$.work_item_id') IS NULL AND ? IS NOT NULL)"}
           ORDER BY rowid DESC LIMIT 50`,
        )
        .all(conn.id, operation, now, scoped ? (workItemId as string) : "x")
    // Un grant acotado a comandos sólo vale para un comando que cubre.
    const applies = (r: Row) => {
      const ssh = (JSON.parse(r.scope_json) as { ssh?: { class: string; programs: string[] } }).ssh
      if (!ssh) return true
      if (!risk) return false
      return ssh.class === "read" ? risk.class === "read" : sshProgramsCovered(ssh.programs, risk)
    }
    const g =
      (workItemId ? rows(true).find(applies) : undefined) ?? rows(false).find(applies) ?? null
    const policy = (g?.policy === "dry_run_then_ask" ? "ask" : (g?.policy ?? "ask")) as Policy
    const forced =
      policy === "auto" &&
      conn.environment === "prod" &&
      (WRITE_OPERATIONS as readonly string[]).includes(operation) &&
      !g?.risk_accepted_at
    let effective: Policy = forced ? "ask" : policy
    if (risk && effective !== "deny") {
      if (risk.class === "destructive") effective = "ask"
      else if (risk.class === "read") {
        const readsAuto = Boolean(
          (JSON.parse(conn.config_json) as { reads_auto?: unknown }).reads_auto,
        )
        if (conn.environment !== "prod" || readsAuto) effective = "auto"
      }
    }
    return { policy, effective, risk_accepted_at: g?.risk_accepted_at ?? null }
  }

  view(conn: ConnectionRow) {
    const type = conn.conn_type as ConnectionType
    const item = conn.vault_item_id
      ? this.deps.db
          .query<
            { kind: string; public_key: string | null; last_used_at: string | null },
            [string]
          >(
            "SELECT kind, public_key, last_used_at FROM vault_items WHERE id = ? AND deleted_at IS NULL",
          )
          .get(conn.vault_item_id)
      : null
    const hostKey = conn.host_key
      ? (JSON.parse(conn.host_key) as { fingerprint: string; type: string })
      : null
    return {
      id: conn.id,
      name: conn.name,
      type,
      environment: conn.environment,
      config: JSON.parse(conn.config_json) as Record<string, unknown>,
      has_secret: conn.secret_ref !== null || item !== null,
      has_secret_ro: conn.secret_ref_ro !== null,
      guarantees: JSON.parse(conn.guarantees_json) as { server: string | null; keel: string },
      operations: (CONNECTION_OPERATIONS[type] ?? []).map((operation) => ({
        operation,
        ...this.policy(conn, operation),
      })),
      auth_method: conn.auth_method ?? null,
      tags: JSON.parse(conn.tags_json ?? "[]") as string[],
      host_key: hostKey ? { fingerprint: hostKey.fingerprint, type: hostKey.type } : null,
      secret: item ?? null,
    }
  }

  private assertOperation(conn: ConnectionRow, operation: string): void {
    const ops = CONNECTION_OPERATIONS[conn.conn_type as ConnectionType] as
      | readonly string[]
      | undefined
    if (!ops?.includes(operation))
      throw new BrokerError("invalid", `${conn.conn_type} no tiene la operación ${operation}`)
  }

  // --- ejecución -----------------------------------------------------------------------
  async execute(
    ctx: ExecuteContext,
    p: { connection: string; operation: string; input: Record<string, unknown> },
  ): Promise<BrokerResult> {
    const conn = this.find(ctx.projectId, p.connection)
    this.assertOperation(conn, p.operation)
    // ADR-0032: la clase del comando la decide Keel antes de mandarlo.
    const risk =
      conn.conn_type === "ssh" && p.operation === "command.run"
        ? classifySshCommand(String(p.input.command ?? ""))
        : null
    if (risk)
      assertAllowedCommand(
        JSON.parse(conn.config_json) as Record<string, unknown>,
        String(p.input.command ?? ""),
      )
    const { effective } = this.policy(conn, p.operation, ctx.workItemId, risk)
    if (effective === "deny")
      throw new BrokerError("denied", `${p.operation} en ${conn.name} está denegado para el agente`)
    // El humano decide por sí mismo; un agente sin grant vigente pregunta.
    if (effective === "ask" && ctx.actor.kind !== "human") {
      if (!ctx.runId)
        throw new BrokerError(
          "denied",
          `${p.operation} en ${conn.name} necesita aprobación y esta sesión no tiene run: pide un grant al humano`,
        )
      const decision = await this.deps.ask(ctx, {
        tool: `resource.${p.operation}`,
        input: {
          connection: conn.name,
          environment: conn.environment,
          operation: p.operation,
          ...p.input,
          ...(risk ? { risk } : {}),
          // ADR-0032 §2: en prod, lo destructivo se aprueba escribiendo el nombre.
          ...(risk?.class === "destructive" && conn.environment === "prod"
            ? { confirm_name: conn.name }
            : {}),
        },
      })
      if (decision !== "approved")
        throw new BrokerError(
          "denied",
          `el humano no aprobó ${p.operation} en ${conn.name} (${decision})${
            risk && risk.class !== "read"
              ? `. Keel lo clasificó ${RISK_LABEL[risk.class]} por «${risk.segment}» (${risk.reason}); si hay una alternativa menos destructiva, propónla`
              : ""
          }`,
        )
    }
    const read = !(WRITE_OPERATIONS as readonly string[]).includes(p.operation)
    const useRo = read && conn.secret_ref_ro !== null
    const ref = useRo ? conn.secret_ref_ro : conn.secret_ref
    const secrets: string[] = []
    const env = this.deps.env ?? process.env
    let cleanup = () => {}
    const cleanups: (() => void)[] = []
    let live: string[] = []
    try {
      // ADR-0025: con método de entrada, la credencial sale del vault (o se le pregunta
      // al humano), nunca de una referencia en el entorno.
      const managed = Boolean(conn.auth_method) && Boolean(this.deps.credentials)
      const secret =
        managed && conn.conn_type === "postgres"
          ? await (this.deps.credentials as Credentials).password(conn, ctx)
          : ref
            ? resolveSecret(ref, env)
            : null
      if (secret) secrets.push(secret)
      let ssh: Awaited<ReturnType<Credentials["ssh"]>> | null = null
      if (managed && conn.conn_type === "ssh") {
        ssh = await (this.deps.credentials as Credentials).ssh(conn, ctx)
        // Lo que askpass entregue durante la ejecución también se redacta.
        live = ssh.redact
        cleanup = ssh.done
      }
      const config = JSON.parse(conn.config_json) as Record<string, unknown>
      const varSecrets = (config.var_secrets ?? {}) as Record<string, string>
      const tfVars: Record<string, string> = {}
      for (const [name, r] of Object.entries(varSecrets)) {
        const v = resolveSecret(r, env)
        secrets.push(v)
        tfVars[`TF_VAR_${name}`] = v
      }
      const role = useRo
        ? "agent_ro"
        : conn.auth_method
          ? `vault:${conn.auth_method}`
          : ref
            ? "rw"
            : "sin credencial"
      // ADR-0033: una base detrás de una conexión SSH llega por su túnel.
      const tunnel = conn.conn_type === "postgres" ? await this.viaTunnel(ctx, conn, config) : null
      if (tunnel) cleanups.push(tunnel.release)
      const runConfig = tunnel?.config ?? config
      const started = performance.now()
      // SSH: la tarjeta se abre al empezar y se cierra con el exit y la duración.
      const sshKey = conn.conn_type === "ssh" ? ulid() : null
      if (sshKey)
        this.deps.emit(ctx.projectId, ctx.runId, "ssh.command.started", {
          run_key: sshKey,
          connection: conn.name,
          environment: conn.environment,
          server: String(config.user ? `${config.user}@${config.host}` : (config.host ?? "")),
          command: redactKnownPatterns(redactSecrets(String(p.input.command ?? ""), secrets)),
          ...(risk
            ? {
                risk: {
                  class: risk.class,
                  segment: redactKnownPatterns(redactSecrets(risk.segment, secrets)),
                  reason: risk.reason,
                },
              }
            : {}),
        })
      const raw =
        conn.conn_type === "ansible"
          ? await this.runAnsible(ctx, conn, config, p.operation, p.input, secrets, (l) => {
              live = l
            })
          : conn.conn_type === "terraform"
            ? await this.runTerraform(ctx, conn, config, p.operation, p.input, secrets, tfVars)
            : conn.conn_type === "ssh" && ssh
              ? await runManagedSsh(conn, config, p.input, ssh)
              : await this.run(conn, runConfig, p.operation, p.input, secret)
      const duration_ms = Math.round(performance.now() - started)
      // Redacción exacta (ADR-0013 §3) y por patrones conocidos (ADR-0025 §8).
      // Lo que askpass entregó para abrir el túnel también se redacta.
      const all = [...secrets, ...live, ...(tunnel?.redact() ?? [])]
      const clean = redactKnownPatterns(redactSecrets(raw, all))
      // El payload del evento es una función: lo que devuelve también pasa por la redacción.
      clean.semantic = {
        kind: raw.semantic.kind,
        payload: (ref) =>
          redactKnownPatterns(
            redactSecrets(
              {
                ...raw.semantic.payload(ref),
                ...(sshKey
                  ? {
                      run_key: sshKey,
                      connection: conn.name,
                      environment: conn.environment,
                      duration_ms,
                    }
                  : {}),
              },
              all,
            ),
          ),
      }
      return this.record(ctx, conn, p.operation, p.input, clean, {
        role,
        duration_ms,
        ...(risk ? { risk: risk.class } : {}),
      })
    } catch (e) {
      const all = [...secrets, ...live]
      if (e instanceof BrokerError) throw new BrokerError(e.code, redactSecrets(e.message, all))
      const message = redactSecrets(e instanceof Error ? e.message : String(e), all)
      throw new BrokerError("failed", `${p.operation} en ${conn.name} falló: ${message}`)
    } finally {
      cleanup()
      for (const c of cleanups) c()
    }
  }

  private async run(
    conn: ConnectionRow,
    config: Record<string, unknown>,
    operation: string,
    input: Record<string, unknown>,
    secret: string | null,
  ): Promise<RawResult> {
    switch (conn.conn_type) {
      case "sqlite":
      case "postgres":
        return runSql(conn, config, operation, input, secret)
      case "ssh":
        return runSsh(config, input)
      default:
        throw new BrokerError("invalid", `tipo de conexión desconocido: ${conn.conn_type}`)
    }
  }

  /** Evidencia con procedencia (ADR-0012) y evento semántico instrumentado (ADR-0011). */
  private async record(
    ctx: ExecuteContext,
    conn: ConnectionRow,
    operation: string,
    input: Record<string, unknown>,
    r: RawResult,
    meta: { role: string; duration_ms: number; risk?: string },
  ): Promise<BrokerResult> {
    const sensitivity: Sensitivity = conn.environment === "prod" ? "restricted" : "internal"
    const inputHash = await sha256Hex(canonicalJson({ operation, input }))
    const provenance = {
      actor: ctx.actor,
      connection: {
        id: conn.id,
        name: conn.name,
        type: conn.conn_type,
        environment: conn.environment,
      },
      role: meta.role,
      // ADR-0032 §3: la auditoría guarda la clase del comando con la operación.
      ...(meta.risk ? { risk: meta.risk } : {}),
      operation,
      input_sha256: inputHash,
      duration_ms: meta.duration_ms,
      captured_at: new Date().toISOString(),
    }
    const stored = this.deps.artifacts.put(r.body, r.media_type, sensitivity)
    const evidenceId =
      ctx.workItemId || ctx.runId
        ? this.deps.addEvidence({
            project_id: ctx.projectId,
            work_item_id: ctx.workItemId,
            run_id: ctx.runId,
            kind: r.evidence_kind,
            title: `${conn.name} · ${operation}`,
            artifact_ref: stored.ref,
            sha256: stored.sha256,
            metadata: { summary: r.summary, sensitivity },
            provenance,
            created_by: ctx.actor.id,
          })
        : null
    this.deps.emit(ctx.projectId, ctx.runId, r.semantic.kind, {
      ...r.semantic.payload(stored.ref),
      sensitivity,
      evidence_id: evidenceId,
    })
    return {
      operation,
      summary: r.summary,
      ...(r.table
        ? {
            columns: r.table.columns.map((c) => c.name),
            rows: r.table.rows.slice(0, AGENT_ROWS),
            row_count: r.table.row_count_total,
            truncated: r.table.truncated || r.table.rows.length > AGENT_ROWS,
          }
        : {}),
      ...(r.output !== undefined ? { output: r.output.slice(0, 20_000) } : {}),
      ...(r.exit_code !== undefined ? { exit_code: r.exit_code } : {}),
      ...(r.plan_sha256 ? { plan_sha256: r.plan_sha256 } : {}),
      ...(r.details !== undefined ? { details: r.details } : {}),
      evidence_id: evidenceId,
      result_ref: stored.ref,
    }
  }

  /**
   * ADR-0031: el check (`iac.plan`) o el despliegue (`iac.apply`) de un playbook. Cada
   * tarea llega en vivo como evento; al agente vuelve un resumen corto.
   */
  private async runAnsible(
    ctx: ExecuteContext,
    conn: ConnectionRow,
    config: Record<string, unknown>,
    operation: string,
    input: Record<string, unknown>,
    secrets: string[],
    setLive: (l: string[]) => void,
  ): Promise<RawResult> {
    const creds = this.deps.credentials
    if (!creds?.ansible || !this.deps.deployBase)
      throw new BrokerError("failed", "este daemon no tiene credenciales para Ansible")
    let spec: ReturnType<typeof ansibleSpec>
    try {
      spec = ansibleSpec(config)
    } catch (e) {
      throw new BrokerError("invalid", (e as Error).message)
    }
    const base = await this.deps.deployBase(ctx.projectId, spec.dir)
    if (base.behind > 0)
      throw new BrokerError(
        "denied",
        `${base.upstream ?? "el remoto"} va ${base.behind} commit(s) adelante: actualiza el checkout antes de desplegar`,
      )
    if (base.dirty.length)
      throw new BrokerError(
        "denied",
        `hay cambios sin commit en ${spec.dir} (${base.dirty.slice(0, 5).join(", ")}): lo que se despliega tiene que estar en un commit`,
      )
    let dir: string
    try {
      dir = playbookDir(base.root, spec)
    } catch (e) {
      throw new BrokerError("invalid", (e as Error).message)
    }
    const hostConns = Object.entries(spec.hosts).map(([name, c]) => ({
      name,
      conn: this.find(ctx.projectId, c),
    }))
    const mode = operation === "iac.plan" ? "check" : "apply"
    const runKey = ulid()
    const runDir = join(this.deps.plansDir, "ansible-runs", runKey)
    mkdirSync(runDir, { recursive: true, mode: 0o700 })
    const prep = await creds.ansible(
      conn,
      hostConns.map((h) => h.conn),
      ctx,
      runDir,
    )
    const redact = (s: string) =>
      redactKnownPatterns(redactSecrets(s, [...secrets, ...prep.redact()]))
    try {
      const hosts: AnsibleHost[] = hostConns.map(({ name, conn: c }) => {
        const cfg = JSON.parse(c.config_json) as Record<string, unknown>
        const key = c.host_key ? (JSON.parse(c.host_key) as { fingerprint?: string }) : null
        return {
          name,
          connection: c.name,
          host: String(cfg.host ?? ""),
          user: cfg.user ? String(cfg.user) : null,
          port: Number(cfg.port ?? 22),
          ssh: prep.ssh.get(c.id) as string,
          fingerprint: key?.fingerprint ?? null,
        }
      })
      prepareRunDir(runDir, hosts)
      const plansDir = join(this.deps.plansDir, "ansible")
      mkdirSync(plansDir, { recursive: true, mode: 0o700 })
      let choice = {
        tags: Array.isArray(input.tags) ? input.tags.map(String) : spec.tags,
        limit: input.limit ? String(input.limit) : spec.limit,
      }
      if (mode === "apply") {
        const sha = String(input.plan_sha256 ?? "")
        if (!/^[0-9a-f]{64}$/.test(sha))
          throw new BrokerError("invalid", "falta input.plan_sha256: el hash del check aprobado")
        const file = join(plansDir, `${sha}.json`)
        if (!existsSync(file))
          throw new BrokerError(
            "not_found",
            "ese check no existe: corre iac_plan antes de desplegar",
          )
        choice = (JSON.parse(readFileSync(file, "utf8")) as { choice: typeof choice }).choice
        if (deployDigest(dir, base.commit, spec, hosts, choice) !== sha)
          throw new BrokerError(
            "denied",
            "el commit, los archivos del playbook o los hosts cambiaron desde el check: vuelve a correr el check",
          )
      }
      const digest = deployDigest(dir, base.commit, spec, hosts, choice)
      const env = ansibleEnv(runDir, prep.env)
      // ADR-0031 §6: lo que guarda el vault de Ansible se redacta de todo lo que salga.
      if (prep.vaultPass) {
        const vaultBin = spec.ansible_path.replace(/ansible-playbook$/, "ansible-vault")
        for (const f of vaultFiles(dir)) {
          // Asíncrono: el script de la contraseña le pregunta al propio daemon por askpass.
          const r = await capture(
            vaultBin,
            ["view", "--vault-password-file", prep.vaultPass, f],
            dir,
            env,
          )
          if (r.status !== 0)
            throw new BrokerError(
              "denied",
              `no se pudo abrir ${f} con la contraseña de ansible-vault: ${redact(r.stderr).slice(-300)}`,
            )
          secrets.push(...secretLeaves(r.stdout))
        }
      }
      setLive(prep.redact())
      const head = {
        tool: "ansible",
        run_key: runKey,
        connection: conn.name,
        environment: conn.environment,
        mode,
        playbook: spec.playbook,
        tags: choice.tags,
        hosts: hosts.map((h) => ({ name: h.name, connection: h.connection, host: h.host })),
        commit: base.commit,
      }
      this.deps.emit(ctx.projectId, ctx.runId, "iac.run.started", head)
      let index = 0
      let outcome: Awaited<ReturnType<typeof runPlaybook>>
      const abort = new AbortController()
      this.running.set(runKey, abort)
      try {
        outcome = await runPlaybook(
          {
            bin: spec.ansible_path,
            args: playbookArgs(runDir, spec, mode, choice, prep.vaultPass),
            cwd: dir,
            env,
            eventsFile: join(runDir, "events.ndjson"),
            mode,
            timeoutMs: (mode === "check" ? 30 : 60) * 60_000,
          },
          (e) => this.emitAnsible(ctx, runKey, e, ++index, redact),
          abort.signal,
        )
      } catch (e) {
        if (e instanceof AnsibleError) throw new BrokerError("failed", e.message)
        throw e
      } finally {
        this.running.delete(runKey)
      }
      setLive(prep.redact())
      const summarized = summarize(outcome, spec, base.commit, choice.tags)
      // Sin el recap, el playbook no terminó (cancelado, colgado, matado): no es un check
      // que se pueda desplegar ni un despliegue completo, aunque nada haya fallado.
      const interrupted = !outcome.events.some((e) => e.kind === "recap")
      const summary = interrupted
        ? `${mode === "check" ? "check" : "despliegue"} interrumpido${abort.signal.aborted ? " por el humano" : ""} en ${outcome.events.filter((e) => e.kind === "task").at(-1)?.name ?? "el arranque"}`
        : summarized.summary
      const details = { ...summarized.details, ...(interrupted ? { interrupted: true } : {}) }
      if (mode === "check" && !interrupted)
        writeFileSync(
          join(plansDir, `${digest}.json`),
          JSON.stringify({ choice, commit: base.commit, created_at: new Date().toISOString() }),
          { mode: 0o600 },
        )
      const cleanDetails = JSON.parse(redact(JSON.stringify(details))) as typeof details
      const body = redact(outcome.output)
      return {
        summary,
        body,
        media_type: "text/plain",
        evidence_kind: "log",
        exit_code: interrupted ? (outcome.exit_code ?? -1) || -1 : outcome.exit_code,
        ...(interrupted ? {} : { plan_sha256: digest }),
        details: {
          ...cleanDetails,
          run_key: runKey,
          ...(base.error ? { base_warning: base.error } : {}),
        },
        semantic:
          mode === "check"
            ? {
                kind: "iac.plan.created",
                payload: (ref) => ({
                  server: spec.dir,
                  // Un check interrumpido no deja nada que desplegar.
                  plan_sha256: interrupted ? "" : digest,
                  summary,
                  plan_ref: ref,
                  tool: "ansible",
                  run_key: runKey,
                  details: cleanDetails,
                }),
              }
            : {
                kind: "iac.apply.completed",
                payload: (ref) => ({
                  server: spec.dir,
                  plan_sha256: digest,
                  exit_code: interrupted ? (outcome.exit_code ?? -1) || -1 : outcome.exit_code,
                  output_ref: ref,
                  tool: "ansible",
                  run_key: runKey,
                  details: cleanDetails,
                }),
              },
      }
    } finally {
      prep.done()
      rmSync(runDir, { recursive: true, force: true })
    }
  }

  /**
   * Terraform con salida para máquinas: cada recurso llega en vivo a la tarjeta y al
   * agente vuelve el árbol de cambios corto. `apply` sólo ejecuta el archivo de plan
   * aprobado, atado a su hash (ADR-0013 §5).
   */
  private async runTerraform(
    ctx: ExecuteContext,
    conn: ConnectionRow,
    config: Record<string, unknown>,
    operation: string,
    input: Record<string, unknown>,
    secrets: string[],
    vars: Record<string, string>,
  ): Promise<RawResult> {
    const raw = String(config.dir ?? "")
    // Las que eligió el alta son relativas al proyecto; las de antes, absolutas.
    const dir =
      raw && !isAbsolute(raw) && this.deps.projectRoot
        ? resolve(this.deps.projectRoot(ctx.projectId), raw)
        : raw
    if (!dir || !existsSync(dir))
      throw new BrokerError(
        "invalid",
        raw
          ? `la carpeta de Terraform ${raw} no existe`
          : "la conexión terraform necesita config.dir",
      )
    const bin = String(config.terraform_path ?? "terraform")
    // Un entorno por workspace o por archivo de variables, dentro de la misma carpeta.
    const workspace = config.workspace ? String(config.workspace) : null
    const varFile = config.var_file ? String(config.var_file) : null
    if (varFile) {
      const rel = relative(dir, resolve(dir, varFile))
      if (rel.startsWith("..") || isAbsolute(rel) || !existsSync(join(dir, rel)))
        throw new BrokerError("invalid", `el archivo de variables ${varFile} no está en ${raw}`)
    }
    const env = {
      ...(process.env as Record<string, string>),
      ...vars,
      TF_IN_AUTOMATION: "1",
      ...(workspace ? { TF_WORKSPACE: workspace } : {}),
    }
    const redact = (v: string) => redactKnownPatterns(redactSecrets(v, secrets))
    const mode = operation === "iac.plan" ? "plan" : "apply"
    const runKey = ulid()
    const started = performance.now()
    this.deps.emit(ctx.projectId, ctx.runId, "iac.run.started", {
      tool: "terraform",
      run_key: runKey,
      connection: conn.name,
      environment: conn.environment,
      mode,
    })
    const errors: string[] = []
    const onJson = (m: Record<string, unknown>) => {
      if (m.type === "diagnostic") {
        const d = m.diagnostic as { severity?: string; summary?: string; detail?: string }
        if (d?.severity === "error")
          errors.push(redact(`${d.summary ?? ""}${d.detail ? `: ${d.detail}` : ""}`).slice(0, 500))
      }
      const e = liveEvent(m)
      if (e)
        this.deps.emit(ctx.projectId, ctx.runId, "terraform.resource.progress", {
          run_key: runKey,
          ...e,
          message: e.message ? redact(e.message).slice(0, 500) : null,
        })
    }
    const tf = async (args: string[], cb?: (m: Record<string, unknown>) => void) => {
      try {
        return await terraform(bin, dir, args, env, cb)
      } catch (e) {
        if (e instanceof TerraformError) throw new BrokerError("failed", e.message)
        throw e
      }
    }
    const fail = (what: string, out: string) =>
      new BrokerError(
        "failed",
        `terraform ${what}: ${errors.length ? errors.join(" · ") : redact(out).slice(-2000)}`,
      )
    if (mode === "plan") {
      if (!existsSync(join(dir, ".terraform"))) {
        const init = await tf(["init", "-input=false", "-no-color"])
        if (init.status !== 0) throw fail("init", init.out)
      }
      // El archivo de plan lleva las variables (secretos incluidos) en claro: no es un
      // artefacto; vive en la carpeta privada de Keel y la aprobación se ata a su hash.
      mkdirSync(this.deps.plansDir, { recursive: true, mode: 0o700 })
      const tmp = join(this.deps.plansDir, `${ulid()}.tfplan`)
      const plan = await tf(
        [
          "plan",
          "-input=false",
          "-json",
          ...(varFile ? [`-var-file=${varFile}`] : []),
          `-out=${tmp}`,
        ],
        onJson,
      )
      if (plan.status !== 0) {
        rmSync(tmp, { force: true })
        throw fail("plan", plan.out)
      }
      const sha = new Bun.CryptoHasher("sha256").update(readFileSync(tmp)).digest("hex")
      const final = join(this.deps.plansDir, `${sha}.tfplan`)
      renameSync(tmp, final)
      chmodSync(final, 0o600)
      const show = await tf(["show", "-json", final])
      const text = await tf(["show", "-no-color", final])
      let resources: ReturnType<typeof changesFromShow> = []
      try {
        resources = changesFromShow(JSON.parse(show.out))
      } catch {
        // Sin el JSON queda el texto; la tarjeta muestra sólo el resumen.
      }
      const counts = countsOf(resources)
      const details: TfDetails = {
        tool: "terraform",
        mode,
        counts,
        resources: resources.slice(0, 60),
        destructive: resources
          .filter((r) => r.action === "delete" || r.action === "replace")
          .map((r) => r.address),
        outputs: {},
        errors,
        duration_ms: Math.round(performance.now() - started),
      }
      const summary = planSummary(counts)
      return {
        summary,
        body: text.out,
        media_type: "text/plain",
        evidence_kind: "log",
        plan_sha256: sha,
        details: { ...details, run_key: runKey },
        semantic: {
          kind: "iac.plan.created",
          payload: (ref) => ({
            server: dir,
            plan_sha256: sha,
            summary,
            plan_ref: ref,
            tool: "terraform",
            run_key: runKey,
            details,
          }),
        },
      }
    }
    const sha = String(input.plan_sha256 ?? "")
    if (!/^[0-9a-f]{64}$/.test(sha)) throw new BrokerError("invalid", "falta input.plan_sha256")
    const file = join(this.deps.plansDir, `${sha}.tfplan`)
    if (!existsSync(file))
      throw new BrokerError("not_found", "ese plan no existe; vuelve a planear")
    // Sólo se aplica el plan aprobado: si el archivo ya no es el del hash, se rechaza.
    const actual = new Bun.CryptoHasher("sha256").update(readFileSync(file)).digest("hex")
    if (actual !== sha)
      throw new BrokerError("denied", "el plan cambió desde que se aprobó; vuelve a planear")
    let outputs: Record<string, string> = {}
    let counts: TfDetails["counts"] = { add: 0, change: 0, remove: 0, replace: 0 }
    const r = await tf(["apply", "-input=false", "-json", file], (m) => {
      onJson(m)
      if (m.type === "outputs") outputs = outputsOf(m)
      if (m.type === "change_summary") {
        const c = m.changes as { add?: number; change?: number; remove?: number }
        counts = { add: c.add ?? 0, change: c.change ?? 0, remove: c.remove ?? 0, replace: 0 }
      }
    })
    rmSync(file, { force: true })
    const details: TfDetails = {
      tool: "terraform",
      mode,
      counts,
      resources: [],
      destructive: [],
      outputs,
      errors,
      duration_ms: Math.round(performance.now() - started),
    }
    const summary =
      r.status === 0
        ? `apply completado: ${planSummary(counts).replace(/^Plan: /, "")}`
        : `apply falló (exit ${r.status})${errors[0] ? `: ${errors[0]}` : ""}`
    return {
      summary,
      body: r.out,
      media_type: "application/x-ndjson",
      evidence_kind: "log",
      exit_code: r.status,
      plan_sha256: sha,
      details: { ...details, run_key: runKey },
      semantic: {
        kind: "iac.apply.completed",
        payload: (ref) => ({
          server: dir,
          plan_sha256: sha,
          exit_code: r.status,
          output_ref: ref,
          tool: "terraform",
          run_key: runKey,
          details,
        }),
      },
    }
  }

  /** Cada tarea y cada resultado por host, en vivo y redactados (ADR-0011, ADR-0031 §5). */
  private emitAnsible(
    ctx: ExecuteContext,
    runKey: string,
    e: AnsibleEvent,
    index: number,
    redact: (s: string) => string,
  ): void {
    if (e.kind === "task")
      this.deps.emit(ctx.projectId, ctx.runId, "ansible.task.started", {
        run_key: runKey,
        index,
        task: redact(e.name),
        action: e.action,
      })
    else if (e.kind === "result")
      this.deps.emit(ctx.projectId, ctx.runId, "ansible.host.result", {
        run_key: runKey,
        host: e.host,
        task: redact(e.task),
        status: e.status,
        changed: e.changed,
        msg: e.msg ? redact(e.msg) : null,
      })
  }
}

type Table = NonNullable<ReturnType<typeof tableFromText>>
type RawResult = {
  summary: string
  body: string
  media_type: string
  evidence_kind: string
  table?: Table
  output?: string
  exit_code?: number | null
  plan_sha256?: string
  details?: unknown
  semantic: { kind: string; payload: (ref: string) => Record<string, unknown> }
}

/** Corre un proceso sin bloquear el daemon y devuelve su salida. */
function capture(
  bin: string,
  args: string[],
  cwd: string,
  env: Record<string, string>,
  timeoutMs = 120_000,
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((done) => {
    const child = spawn(bin, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (d: Buffer) => {
      stdout += d.toString("utf8")
    })
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString("utf8")
    })
    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs)
    child.on("error", (e) => {
      clearTimeout(timer)
      done({ status: null, stdout, stderr: e.message })
    })
    child.on("close", (c) => {
      clearTimeout(timer)
      done({ status: c, stdout, stderr })
    })
  })
}

// --- SQL (PostgreSQL y SQLite por Bun.SQL) -------------------------------------------------
async function runSql(
  conn: ConnectionRow,
  config: Record<string, unknown>,
  operation: string,
  input: Record<string, unknown>,
  secret: string | null,
): Promise<RawResult> {
  const read = operation !== "query.write"
  let db: SQL
  if (conn.conn_type === "sqlite") {
    const path = String(config.path ?? "")
    if (!path) throw new BrokerError("invalid", "la conexión sqlite necesita config.path")
    // La garantía de lectura está en la base: el archivo se abre en sólo lectura.
    db = new SQL(`sqlite://${path}${read ? "?mode=ro" : ""}`)
  } else {
    db = new SQL({
      hostname: String(config.host ?? "localhost"),
      port: Number(config.port ?? 5432),
      database: String(config.database ?? ""),
      username: String((read && config.user_ro) || config.user || ""),
      ...(secret ? { password: secret } : {}),
      max: 1,
    })
  }
  try {
    let rows: Record<string, unknown>[]
    let query: string
    if (operation === "schema.read") {
      query =
        conn.conn_type === "sqlite"
          ? "SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name"
          : "SELECT table_name, column_name, data_type FROM information_schema.columns WHERE table_schema NOT IN ('pg_catalog','information_schema') ORDER BY table_name, ordinal_position"
      rows = (await db.unsafe(query)) as Record<string, unknown>[]
    } else {
      query = String(input.sql ?? input.query ?? "")
      if (!query) throw new BrokerError("invalid", "falta input.sql")
      const params = Array.isArray(input.params) ? input.params : []
      if (conn.conn_type === "postgres")
        rows = (await db.begin(async (tx) => {
          if (read) await tx.unsafe("SET TRANSACTION READ ONLY")
          await tx.unsafe(`SET LOCAL statement_timeout = ${STATEMENT_TIMEOUT_MS}`)
          return tx.unsafe(query, params)
        })) as Record<string, unknown>[]
      else rows = (await db.unsafe(query, params)) as Record<string, unknown>[]
    }
    const table = tableFromText(JSON.stringify([...rows])) ?? {
      columns: [],
      rows: [],
      row_count_total: 0,
      truncated: false,
    }
    return {
      summary: `${table.row_count_total} fila(s)`,
      body: JSON.stringify(table),
      media_type: "application/vnd.keel.table+json",
      evidence_kind: "sql_result",
      table,
      semantic: {
        kind: "database.query.completed",
        payload: (ref) => ({
          server: conn.name,
          tool: operation,
          query,
          row_count: table.row_count_total,
          columns: table.columns.map((c) => c.name),
          result_ref: ref,
          error: null,
        }),
      },
    }
  } finally {
    await db.close()
  }
}

// --- SSH (el ssh del usuario: sus llaves y su agente, nunca las de Keel) -------------------
const SHELL_META = /[;&|`<>\n\r]|\$\(/

/**
 * La lista permitida de la conexión. Capa de Keel; la garantía real es el usuario o el
 * comando forzado del servidor. Va antes de preguntar: lo que la lista rechaza no se
 * le pregunta al humano.
 */
function assertAllowedCommand(config: Record<string, unknown>, command: string): void {
  const allowed = Array.isArray(config.allowed_commands)
    ? config.allowed_commands.map(String)
    : null
  if (
    allowed &&
    (SHELL_META.test(command) || !allowed.some((a) => command === a || command.startsWith(`${a} `)))
  )
    throw new BrokerError("denied", `el comando no está en la lista permitida de la conexión`)
}

function runSsh(config: Record<string, unknown>, input: Record<string, unknown>): RawResult {
  const command = String(input.command ?? "")
  if (!command) throw new BrokerError("invalid", "falta input.command")
  assertAllowedCommand(config, command)
  const dest = config.user ? `${config.user}@${config.host}` : String(config.host ?? "")
  const args = [
    "-o",
    "BatchMode=yes",
    ...(config.port ? ["-p", String(config.port)] : []),
    dest,
    "--",
    command,
  ]
  const r = spawnSync(String(config.ssh_path ?? "ssh"), args, { encoding: "utf8", timeout: 60_000 })
  if (r.error) throw new BrokerError("failed", `ssh no disponible: ${r.error.message}`)
  const output = `${r.stdout}${r.stderr ? `\n${r.stderr}` : ""}`
  return {
    summary: `exit ${r.status}`,
    body: output,
    media_type: "text/plain",
    evidence_kind: "log",
    output,
    exit_code: r.status,
    semantic: {
      kind: "ssh.command.completed",
      payload: (ref) => ({ server: dest, command, exit_code: r.status, output_ref: ref }),
    },
  }
}

/**
 * SSH con el método de la conexión (ADR-0025 §4): las opciones y el entorno los arma el
 * daemon (agente de Keel, askpass); aquí sólo se ejecuta, sin bloquear el daemon, porque
 * askpass le pregunta al propio daemon.
 */
async function runManagedSsh(
  conn: ConnectionRow,
  config: Record<string, unknown>,
  input: Record<string, unknown>,
  prep: { args: string[]; env: Record<string, string> },
): Promise<RawResult> {
  const command = String(input.command ?? "")
  if (!command) throw new BrokerError("invalid", "falta input.command")
  const host = String(config.host ?? "")
  if (!host) throw new BrokerError("invalid", "la conexión ssh necesita config.host")
  const dest = config.user ? `${config.user}@${host}` : host
  const { code, out } = await new Promise<{ code: number | null; out: string }>(
    (resolve, reject) => {
      const child = spawn(String(config.ssh_path ?? "ssh"), [...prep.args, host, "--", command], {
        env: prep.env,
        stdio: ["ignore", "pipe", "pipe"],
      })
      let buf = ""
      const take = (d: Buffer) => {
        if (buf.length < 4_000_000) buf += d.toString("utf8")
      }
      child.stdout.on("data", take)
      child.stderr.on("data", take)
      const timer = setTimeout(() => child.kill("SIGTERM"), 120_000)
      child.on("error", (e) => {
        clearTimeout(timer)
        reject(new BrokerError("failed", `ssh no disponible: ${e.message}`))
      })
      child.on("close", (c) => {
        clearTimeout(timer)
        resolve({ code: c, out: buf })
      })
    },
  )
  if (code === 255 && /Host key verification failed|No .* host key is known/i.test(out))
    throw new BrokerError(
      "denied",
      `la huella de ${host} no está aceptada en Keel: el humano la revisa y la acepta en la conexión ${conn.name}`,
    )
  return {
    summary: `exit ${code}`,
    body: out,
    media_type: "text/plain",
    evidence_kind: "log",
    output: out,
    exit_code: code,
    semantic: {
      kind: "ssh.command.completed",
      payload: (ref) => ({ server: dest, command, exit_code: code, output_ref: ref }),
    },
  }
}
