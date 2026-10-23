/**
 * Intermediario de recursos (ADR-0013): el agente recibe operaciones, no
 * credenciales. El daemon resuelve el secreto sólo al ejecutar, ejecuta con
 * él, borra su valor literal de la salida, guarda el resultado como evidencia
 * con su procedencia y emite el evento semántico instrumentado. La política es
 * por conexión, operación y entorno; en producción las escrituras nunca son
 * `auto` y lo que se produce es `restricted`.
 */
import type { Database } from "bun:sqlite"
import { spawnSync } from "node:child_process"
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs"
import { join } from "node:path"
import { CONNECTION_OPERATIONS, type ConnectionType, WRITE_OPERATIONS } from "@keel/core"
import { SQL } from "bun"
import type { ArtifactStore, Sensitivity } from "../artifacts.js"
import { canonicalJson, sha256Hex, ulid } from "../ids.js"
import { tableFromText } from "../semantic.js"
import { redactSecrets, resolveSecret } from "./secrets.js"

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
}

export type Policy = "auto" | "ask" | "deny"

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
}

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
  ssh: "Lista de comandos permitidos por prefijo en Keel; la garantía real es un usuario restringido en el servidor.",
  terraform: "apply sólo ejecuta el archivo de plan aprobado, atado a su hash.",
}

export class ResourceBroker {
  private readonly deps: BrokerDeps
  constructor(deps: BrokerDeps) {
    this.deps = deps
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
  }): ConnectionRow {
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
           environment, guarantees_json, created_at)
         VALUES (?,?,?,?,?,?,?,?,?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`,
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
      )
    return this.find(p.project_id, id)
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
  ): void {
    this.assertOperation(conn, operation)
    if (
      policy === "auto" &&
      conn.environment === "prod" &&
      (WRITE_OPERATIONS as readonly string[]).includes(operation)
    )
      throw new BrokerError(
        "invalid",
        `en producción ${operation} nunca es auto: cada vez pregunta (ADR-0013 §4)`,
      )
    const db = this.deps.db
    db.query(
      "UPDATE permission_grants SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE connection_id = ? AND operation = ? AND revoked_at IS NULL",
    ).run(conn.id, operation)
    db.query(
      `INSERT INTO permission_grants(id, project_id, connection_id, policy, scope_json, granted_by, expires_at, operation)
       VALUES (?,?,?,?,?,?,?,?)`,
    ).run(
      ulid(),
      conn.project_id,
      conn.id,
      policy,
      JSON.stringify({ operation, environment: conn.environment }),
      actor,
      expiresAt,
      operation,
    )
  }

  /** La política vigente: sin grant se pregunta; en prod las escrituras siempre preguntan. */
  policy(conn: ConnectionRow, operation: string): { policy: Policy; effective: Policy } {
    const g = this.deps.db
      .query<{ policy: string }, [string, string, string]>(
        `SELECT policy FROM permission_grants WHERE connection_id = ? AND operation = ? AND revoked_at IS NULL
           AND (expires_at IS NULL OR expires_at > ?) ORDER BY rowid DESC LIMIT 1`,
      )
      .get(conn.id, operation, new Date().toISOString())
    const policy = (g?.policy === "dry_run_then_ask" ? "ask" : (g?.policy ?? "ask")) as Policy
    const forced =
      policy === "auto" &&
      conn.environment === "prod" &&
      (WRITE_OPERATIONS as readonly string[]).includes(operation)
    return { policy, effective: forced ? "ask" : policy }
  }

  view(conn: ConnectionRow) {
    const type = conn.conn_type as ConnectionType
    return {
      id: conn.id,
      name: conn.name,
      type,
      environment: conn.environment,
      config: JSON.parse(conn.config_json) as Record<string, unknown>,
      has_secret: conn.secret_ref !== null,
      has_secret_ro: conn.secret_ref_ro !== null,
      guarantees: JSON.parse(conn.guarantees_json) as { server: string | null; keel: string },
      operations: (CONNECTION_OPERATIONS[type] ?? []).map((operation) => ({
        operation,
        ...this.policy(conn, operation),
      })),
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
    const { effective } = this.policy(conn, p.operation)
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
        },
      })
      if (decision !== "approved")
        throw new BrokerError(
          "denied",
          `el humano no aprobó ${p.operation} en ${conn.name} (${decision})`,
        )
    }
    const read = !(WRITE_OPERATIONS as readonly string[]).includes(p.operation)
    const useRo = read && conn.secret_ref_ro !== null
    const ref = useRo ? conn.secret_ref_ro : conn.secret_ref
    const secrets: string[] = []
    const env = this.deps.env ?? process.env
    try {
      const secret = ref ? resolveSecret(ref, env) : null
      if (secret) secrets.push(secret)
      const config = JSON.parse(conn.config_json) as Record<string, unknown>
      const varSecrets = (config.var_secrets ?? {}) as Record<string, string>
      const tfVars: Record<string, string> = {}
      for (const [name, r] of Object.entries(varSecrets)) {
        const v = resolveSecret(r, env)
        secrets.push(v)
        tfVars[`TF_VAR_${name}`] = v
      }
      const role = useRo ? "agent_ro" : ref ? "rw" : "sin credencial"
      const started = performance.now()
      const raw = await this.run(conn, config, p.operation, p.input, secret, tfVars)
      const duration_ms = Math.round(performance.now() - started)
      // Redacción exacta (ADR-0013 §3): el valor resuelto no sale en nada.
      const clean = redactSecrets(raw, secrets)
      return this.record(ctx, conn, p.operation, p.input, clean, { role, duration_ms })
    } catch (e) {
      if (e instanceof BrokerError) throw new BrokerError(e.code, redactSecrets(e.message, secrets))
      const message = redactSecrets(e instanceof Error ? e.message : String(e), secrets)
      throw new BrokerError("failed", `${p.operation} en ${conn.name} falló: ${message}`)
    }
  }

  private async run(
    conn: ConnectionRow,
    config: Record<string, unknown>,
    operation: string,
    input: Record<string, unknown>,
    secret: string | null,
    tfVars: Record<string, string>,
  ): Promise<RawResult> {
    switch (conn.conn_type) {
      case "sqlite":
      case "postgres":
        return runSql(conn, config, operation, input, secret)
      case "ssh":
        return runSsh(config, input)
      case "terraform":
        return operation === "iac.plan"
          ? runPlan(config, tfVars, this.deps.plansDir)
          : runApply(config, input, tfVars, this.deps.plansDir)
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
    meta: { role: string; duration_ms: number },
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
      evidence_id: evidenceId,
      result_ref: stored.ref,
    }
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
  semantic: { kind: string; payload: (ref: string) => Record<string, unknown> }
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

function runSsh(config: Record<string, unknown>, input: Record<string, unknown>): RawResult {
  const command = String(input.command ?? "")
  if (!command) throw new BrokerError("invalid", "falta input.command")
  const allowed = Array.isArray(config.allowed_commands)
    ? config.allowed_commands.map(String)
    : null
  // Capa de Keel; la garantía real es el usuario o el comando forzado del servidor.
  if (
    allowed &&
    (SHELL_META.test(command) || !allowed.some((a) => command === a || command.startsWith(`${a} `)))
  )
    throw new BrokerError("denied", `el comando no está en la lista permitida de la conexión`)
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

// --- Terraform (plan aprobado, atado a su hash) ---------------------------------------------
function tf(
  config: Record<string, unknown>,
  args: string[],
  vars: Record<string, string>,
): { status: number | null; out: string } {
  const dir = String(config.dir ?? "")
  if (!dir || !existsSync(dir))
    throw new BrokerError("invalid", "la conexión terraform necesita config.dir")
  const r = spawnSync(String(config.terraform_path ?? "terraform"), [`-chdir=${dir}`, ...args], {
    encoding: "utf8",
    timeout: 10 * 60_000,
    env: { ...process.env, ...vars, TF_IN_AUTOMATION: "1" },
  })
  if (r.error) throw new BrokerError("failed", `terraform no disponible: ${r.error.message}`)
  return { status: r.status, out: `${r.stdout}${r.stderr ? `\n${r.stderr}` : ""}` }
}

function runPlan(
  config: Record<string, unknown>,
  vars: Record<string, string>,
  plansDir: string,
): RawResult {
  const dir = String(config.dir ?? "")
  if (!existsSync(join(dir, ".terraform"))) {
    const init = tf(config, ["init", "-input=false", "-no-color"], vars)
    if (init.status !== 0)
      throw new BrokerError("failed", `terraform init: ${init.out.slice(-2000)}`)
  }
  // El archivo de plan lleva las variables (secretos incluidos) en claro: no es un
  // artefacto; vive en la carpeta privada de Keel y la aprobación se ata a su hash.
  mkdirSync(plansDir, { recursive: true, mode: 0o700 })
  const tmp = join(plansDir, `${ulid()}.tfplan`)
  const plan = tf(config, ["plan", "-input=false", "-no-color", `-out=${tmp}`], vars)
  if (plan.status !== 0) {
    rmSync(tmp, { force: true })
    throw new BrokerError("failed", `terraform plan: ${plan.out.slice(-2000)}`)
  }
  const bytes = readFileSync(tmp)
  const sha = new Bun.CryptoHasher("sha256").update(bytes).digest("hex")
  const final = join(plansDir, `${sha}.tfplan`)
  renameSync(tmp, final)
  chmodSync(final, 0o600)
  const show = tf(config, ["show", "-no-color", final], vars)
  const summary = /Plan: .*|No changes\..*/.exec(plan.out)?.[0] ?? "plan creado"
  return {
    summary,
    body: show.out,
    media_type: "text/plain",
    evidence_kind: "log",
    output: show.out,
    plan_sha256: sha,
    semantic: {
      kind: "iac.plan.created",
      payload: (ref) => ({ server: dir, plan_sha256: sha, summary, plan_ref: ref }),
    },
  }
}

function runApply(
  config: Record<string, unknown>,
  input: Record<string, unknown>,
  vars: Record<string, string>,
  plansDir: string,
): RawResult {
  const sha = String(input.plan_sha256 ?? "")
  if (!/^[0-9a-f]{64}$/.test(sha)) throw new BrokerError("invalid", "falta input.plan_sha256")
  const file = join(plansDir, `${sha}.tfplan`)
  if (!existsSync(file)) throw new BrokerError("not_found", "ese plan no existe; vuelve a planear")
  // Sólo se aplica el plan aprobado: si el archivo ya no es el del hash, se rechaza.
  const actual = new Bun.CryptoHasher("sha256").update(readFileSync(file)).digest("hex")
  if (actual !== sha)
    throw new BrokerError("denied", "el plan cambió desde que se aprobó; vuelve a planear")
  const r = tf(config, ["apply", "-input=false", "-no-color", file], vars)
  rmSync(file, { force: true })
  const dir = String(config.dir ?? "")
  return {
    summary: r.status === 0 ? "apply completado" : `apply falló (exit ${r.status})`,
    body: r.out,
    media_type: "text/plain",
    evidence_kind: "log",
    output: r.out,
    exit_code: r.status,
    plan_sha256: sha,
    semantic: {
      kind: "iac.apply.completed",
      payload: (ref) => ({ server: dir, plan_sha256: sha, exit_code: r.status, output_ref: ref }),
    },
  }
}
