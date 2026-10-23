/**
 * Contrato IPC de Keel (ADR-0005): JSON-RPC 2.0 en NDJSON sobre socket local.
 *
 * - Envelope versionado: todo frame lleva `keel_protocol: 1`.
 * - Mutaciones con `request_id`, `idempotency_key` y revisión esperada opcional.
 * - Errores estructurados: `code`, `message`, `retryable`, `details`, `correlation`.
 * - Suscripción con cursor: `events.subscribe` → snapshot + `after_event_seq`.
 *
 * Aquí viven sólo esquemas Zod y codecs puros (sin I/O). Los tipos se derivan con
 * `z.infer`, nunca se escriben a mano.
 */
import { z } from "zod"
import { PluginManifestSchema } from "./plugins.js"
import { ClaimKindSchema, ClaimViewSchema } from "./research.js"
import { SemanticEventViewSchema } from "./semantic.js"
import { VISUAL_STATES } from "./visual-state.js"

export const KEEL_PROTOCOL_VERSION = 1 as const

export const MAX_FRAME_BYTES = 8 * 1024 * 1024

export const JsonRpcId = z.union([z.string().min(1), z.number().int()])
export type JsonRpcId = z.infer<typeof JsonRpcId>

/** Códigos de error: los de JSON-RPC más el rango propio de Keel (-32000..-32099). */
export const ErrorCode = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
  protocolVersion: -32000,
  frameTooLarge: -32001,
  unauthorized: -32002,
  conflict: -32003, // revisión esperada no coincide
  idempotencyMismatch: -32004, // misma idempotency_key con otro request_hash
  notFound: -32005,
  invalidTransition: -32006,
  backpressure: -32007,
  limitExceeded: -32008, // concurrencia o presupuesto antes del spawn (ADR-0002 regla 3)
  cursorExpired: -32009, // el cursor es anterior a una purga; details.min_cursor (ADR-0012 §8)
} as const

export const RpcError = z.object({
  code: z.number().int(),
  message: z.string(),
  retryable: z.boolean(),
  details: z.unknown().optional(),
  correlation: z
    .object({ request_id: z.string().optional(), event_seq: z.number().int().optional() })
    .optional(),
})
export type RpcError = z.infer<typeof RpcError>

/** Metadatos de toda mutación (SDD 02 §2). Las lecturas no los necesitan. */
export const MutationMeta = z.object({
  request_id: z.string().min(1),
  idempotency_key: z.string().min(1),
  expected_revision: z.number().int().nonnegative().optional(),
})
export type MutationMeta = z.infer<typeof MutationMeta>

const envelope = { jsonrpc: z.literal("2.0"), keel_protocol: z.literal(KEEL_PROTOCOL_VERSION) }

export const Request = z.object({
  ...envelope,
  id: JsonRpcId,
  method: z.string().min(1),
  params: z.unknown().optional(),
})
export const Notification = z.object({
  ...envelope,
  method: z.string().min(1),
  params: z.unknown().optional(),
})
export const SuccessResponse = z.object({ ...envelope, id: JsonRpcId, result: z.unknown() })
export const ErrorResponse = z.object({ ...envelope, id: JsonRpcId.nullable(), error: RpcError })
export const Frame = z.union([Request, Notification, SuccessResponse, ErrorResponse])
export type Request = z.infer<typeof Request>
export type Notification = z.infer<typeof Notification>
export type SuccessResponse = z.infer<typeof SuccessResponse>
export type ErrorResponse = z.infer<typeof ErrorResponse>
export type Frame = z.infer<typeof Frame>

// --- vocabulario compartido con las proyecciones ------------------------------------
export const VisualStateSchema = z.enum(VISUAL_STATES)
export const LifecycleSchema = z.enum([
  "triage",
  "planned",
  "running",
  "waiting_human",
  "blocked",
  "needs_review",
  "failed",
  "done",
])
export const RunStatusSchema = z.enum([
  "queued",
  "initializing",
  "running",
  "paused",
  "waiting_human",
  "completed",
  "failed",
  "cancelled",
  "interrupted",
  "budget_exceeded",
])
export const RunPurposeSchema = z.enum(["plan", "execute", "triage_eval"])
export const NodeStateSchema = z.enum([
  "pending",
  "running",
  "waiting_human",
  "succeeded",
  "failed",
  "cancelled",
  "interrupted",
  "orphan",
])
/**
 * Modo de permisos de un run (ADR-0019 §4). `ask` es el valor por defecto;
 * `bypass` deja al agente sin gate y sólo existe para `execute` en un worktree.
 */
export const PermissionModeSchema = z.enum(["ask", "accept_edits", "plan", "bypass"])
export type PermissionMode = z.infer<typeof PermissionModeSchema>
/** Lo que el humano elige al arrancar; el daemon guarda los valores efectivos en el manifest. */
export const RunOptionsSchema = z.object({
  model: z.string().min(1).max(120).optional(),
  max_turns: z.number().int().min(1).max(500).optional(),
  permission_mode: PermissionModeSchema.optional(),
})
export const PermissionRuleViewSchema = z.object({
  id: z.string(),
  tool: z.string(),
  prefix: z.string().nullable(),
  exact: z.boolean(),
  effect: z.enum(["auto", "deny"]),
  /** Texto corto: `Bash(git status:*)`. */
  label: z.string(),
  source_approval_id: z.string().nullable(),
  created_by: z.string(),
  created_at: z.string(),
  expires_at: z.string().nullable(),
  revoked_at: z.string().nullable(),
})
export const CostKindSchema = z.enum(["observed", "estimated", "unknown"])
export type CostKind = z.infer<typeof CostKindSchema>

/** Toda entidad proyectada que viaja por el protocolo lleva su visual ya resuelto (ADR-0006 §3). */
const projected = { visual_state: VisualStateSchema, revision: z.number().int().nonnegative() }

export const WorkItemViewSchema = z.object({
  id: z.string(),
  project_id: z.string(),
  display_id: z.string(),
  title: z.string(),
  kind: z.string().optional(),
  lifecycle: LifecycleSchema,
  board_status: z.string(),
  ...projected,
})
/** Lo que un agente externo puede hacer, por grupos de métodos (ADR-0009 §4). */
export const AgentScopeSchema = z.enum([
  "tasks:read",
  "tasks:write",
  "notes:write",
  "runs:request",
  /** Usar conexiones del proyecto por el intermediario (ADR-0013). */
  "resources:use",
])
export type AgentScope = z.infer<typeof AgentScopeSchema>
export const AGENT_SCOPES: readonly AgentScope[] = AgentScopeSchema.options
export const PairingViewSchema = z.object({
  id: z.string(),
  code: z.string(),
  client_name: z.string(),
  cwd: z.string().nullable(),
  state: z.enum(["pending", "approved", "rejected", "closed"]),
  project_id: z.string().nullable(),
  work_item_id: z.string().nullable(),
  scopes: z.array(AgentScopeSchema),
  created_at: z.string(),
})
export const RunRequestViewSchema = z.object({
  id: z.string(),
  work_item_id: z.string(),
  purpose: RunPurposeSchema,
  prompt: z.string().nullable(),
  profile: z.string().nullable(),
  reason: z.string(),
  requested_by: z.string(),
  state: z.enum(["pending", "started", "rejected"]),
  run_id: z.string().nullable(),
  created_at: z.string(),
})
export const ApprovalViewSchema = z.object({
  id: z.string(),
  run_id: z.string(),
  work_item_id: z.string(),
  operation_hash: z.string(),
  /** La operación ya redactada (ADR-0002): herramienta y entrada. */
  operation: z.unknown(),
  state: z.enum(["pending", "approved", "denied", "expired", "consumed"]),
  expires_at: z.string().nullable(),
  /** Quién decidió (humano o regla); null si nadie todavía. */
  decision_actor: z.string().nullable().optional(),
})
export const ProjectViewSchema = z.object({
  id: z.string(),
  name: z.string(),
  root_path: z.string(),
  vcs: z.string(),
  last_opened_at: z.string().nullable(),
})
/** Tipos de evidencia (ADR-0012 §3). */
export const EvidenceKindSchema = z.enum([
  "sql_result",
  "screenshot",
  "diff",
  "test_report",
  "chart",
  "document",
  "log",
])
export const SensitivitySchema = z.enum(["internal", "restricted"])
export const EvidenceViewSchema = z.object({
  id: z.string(),
  work_item_id: z.string().nullable(),
  run_id: z.string().nullable(),
  kind: z.string(),
  title: z.string().nullable(),
  artifact_ref: z.string(),
  sha256: z.string(),
  size: z.number().int().nullable(),
  media_type: z.string().nullable(),
  sensitivity: SensitivitySchema.nullable(),
  integrity: z.enum(["ok", "mismatch", "missing"]).nullable(),
  metadata: z.unknown(),
  provenance: z.unknown(),
  created_by: z.string(),
  supersedes_id: z.string().nullable(),
  created_at: z.string(),
})
/** Un archivo del plan de git con sus líneas (ADR-0015 §2). */
export const GitPlanFileSchema = z.object({
  path: z.string(),
  status: z.enum(["M", "A", "D", "R"]),
  additions: z.number().int(),
  deletions: z.number().int(),
})
/** El plan que aprueba el humano: lo que se confirma, a dónde va y desde dónde. */
export const GitPlanSchema = z.object({
  version: z.literal(1),
  run_id: z.string(),
  work_item_id: z.string(),
  repo_root: z.string(),
  worktree: z.string(),
  branch: z.string(),
  expected_head_sha: z.string().nullable(),
  content_hash: z.string(),
  files: z.array(GitPlanFileSchema),
  diff_ref: z.string().nullable(),
  operations: z.array(
    z.discriminatedUnion("op", [
      z.object({ op: z.literal("commit"), message: z.string(), paths: z.array(z.string()) }),
      z.object({ op: z.literal("push"), remote: z.string(), branch: z.string() }),
      z.object({
        op: z.literal("pr.create"),
        base: z.string(),
        head: z.string(),
        title: z.string(),
        body: z.string(),
      }),
    ]),
  ),
})
export type GitPlan = z.infer<typeof GitPlanSchema>
/** ADR-0013: tipos de conexión y sus operaciones. */
export const CONNECTION_OPERATIONS = {
  postgres: ["schema.read", "query.read", "query.write"],
  sqlite: ["schema.read", "query.read", "query.write"],
  ssh: ["command.run"],
  terraform: ["iac.plan", "iac.apply"],
} as const
export type ConnectionType = keyof typeof CONNECTION_OPERATIONS
/** Operaciones que nunca son `auto` en producción (ADR-0013 §4). */
export const WRITE_OPERATIONS = ["query.write", "command.run", "iac.apply"] as const
export const GrantPolicySchema = z.enum(["auto", "ask", "deny"])
export const ConnectionViewSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.enum(["postgres", "sqlite", "ssh", "terraform"]),
  environment: z.enum(["dev", "staging", "prod"]),
  /** Configuración sin secretos (host, base, ruta…). */
  config: z.record(z.string(), z.unknown()),
  has_secret: z.boolean(),
  has_secret_ro: z.boolean(),
  /** Qué garantiza el servidor y qué sólo Keel (ADR-0013 §5). */
  guarantees: z.object({ server: z.string().nullable(), keel: z.string() }),
  operations: z.array(
    z.object({ operation: z.string(), policy: GrantPolicySchema, effective: GrantPolicySchema }),
  ),
})
export const PluginViewSchema = z.object({
  id: z.string(),
  version: z.string(),
  path: z.string(),
  sha256: z.string(),
  manifest: PluginManifestSchema,
  /** `ok`, o por qué no corre (hash cambiado, proceso caído…). */
  status: z.string(),
})
export const ReportViewSchema = z.object({
  id: z.string(),
  work_item_id: z.string(),
  version: z.number().int(),
  sha256: z.string(),
  markdown: z.string(),
  created_by: z.string(),
  created_at: z.string(),
  /** true si los registros no cambiaron y se devolvió la versión existente. */
  reused: z.boolean(),
})
export const NoteViewSchema = z.object({
  id: z.string(),
  work_item_id: z.string(),
  author: z.string(),
  content_markdown: z.string(),
  created_at: z.string(),
})
export const RunViewSchema = z.object({
  id: z.string(),
  work_item_id: z.string(),
  purpose: RunPurposeSchema,
  status: RunStatusSchema,
  end_reason: z.string().nullable(),
  cost_kind: CostKindSchema,
  total_cost_micro_usd: z.number().int().nullable(),
  /** Modelo, turnos y modo efectivos del run (ADR-0019 §4). */
  options: z
    .object({
      model: z.string().nullable(),
      max_turns: z.number().int().nullable(),
      permission_mode: PermissionModeSchema,
    })
    .nullable()
    .optional(),
  parent_run_id: z.string().nullable().optional(),
  /**
   * Aislamiento del agente (ADR-0018): `sandbox` (bubblewrap de Keel),
   * `provider` (el sandbox propio del proveedor, sin verificar contra la puerta
   * humana) o `none`. null mientras no arranca.
   */
  isolation: z.enum(["none", "sandbox", "provider", "os_user"]).nullable().optional(),
  ...projected,
})
export const NodeViewSchema = z.object({
  id: z.string(),
  run_id: z.string(),
  kind: z.enum(["agent", "workflow", "tool_call"]),
  state: NodeStateSchema,
  parent_id: z.string().nullable(),
  parent_source: z.enum(["sdk", "transcript", "launch", "prompt"]).nullable(),
  ...projected,
})

// --- métodos ------------------------------------------------------------------------
export const Methods = {
  "work_items.create": {
    params: MutationMeta.extend({
      project_id: z.string().optional(),
      title: z.string().min(1),
      kind: z.string(),
      spec_markdown: z.string().optional(),
    }),
    result: WorkItemViewSchema,
  },
  "work_items.transition": {
    params: MutationMeta.extend({
      work_item_id: z.string(),
      to: LifecycleSchema,
      reason: z.string().optional(),
    }),
    result: WorkItemViewSchema,
  },
  "session.bind_agent": {
    params: z.object({ token: z.string().min(16) }),
    result: z.object({
      actor_id: z.string(),
      run_id: z.string(),
      project_id: z.string(),
      work_item_id: z.string(),
    }),
  },
  "work_items.list": {
    params: z.object({
      project_id: z.string().optional(),
      lifecycle: z.array(LifecycleSchema).optional(),
      limit: z.number().int().positive().max(500).optional(),
    }),
    result: z.object({ items: z.array(WorkItemViewSchema) }),
  },
  "work_items.get": {
    params: z.object({ work_item_id: z.string() }),
    result: z.object({
      item: WorkItemViewSchema,
      spec_markdown: z.string(),
      notes: z.array(NoteViewSchema),
    }),
  },
  "notes.add": {
    params: MutationMeta.extend({ work_item_id: z.string(), content_markdown: z.string().min(1) }),
    result: NoteViewSchema,
  },
  "handoffs.request": {
    params: MutationMeta.extend({
      title: z.string().min(1),
      summary_markdown: z.string().min(1),
      kind: z.string().optional(),
    }),
    result: z.object({ note: NoteViewSchema, work_item: WorkItemViewSchema }),
  },
  "runs.request": {
    params: MutationMeta.extend({
      work_item_id: z.string(),
      purpose: RunPurposeSchema,
      prompt: z.string().optional(),
      profile: z.string().optional(),
      reason: z.string().min(1),
    }),
    result: RunRequestViewSchema,
  },
  "runs.requests_list": {
    params: z.object({ state: z.enum(["pending", "started", "rejected"]).optional() }),
    result: z.object({ requests: z.array(RunRequestViewSchema) }),
  },
  "runs.request_resolve": {
    params: MutationMeta.extend({
      run_request_id: z.string(),
      decision: z.enum(["approve", "reject"]),
    }),
    result: z.object({ request: RunRequestViewSchema, run: RunViewSchema.nullable() }),
  },
  "session.pair": {
    params: z.object({ client_name: z.string().min(1).max(120), cwd: z.string().optional() }),
    result: PairingViewSchema,
  },
  "session.pair_status": {
    params: z.object({}),
    result: PairingViewSchema,
  },
  "session.pairings_list": {
    params: z.object({ state: z.enum(["pending", "approved", "rejected", "closed"]).optional() }),
    result: z.object({ pairings: z.array(PairingViewSchema) }),
  },
  "session.pair_resolve": {
    params: MutationMeta.extend({
      pairing_id: z.string(),
      decision: z.enum(["approve", "reject"]),
      work_item_id: z.string().optional(),
      scopes: z.array(AgentScopeSchema).optional(),
    }),
    result: PairingViewSchema,
  },
  /** ADR-0019 §2: proyectos abiertos en este daemon, el más reciente primero. */
  "projects.list": {
    params: z.object({}),
    result: z.object({ projects: z.array(ProjectViewSchema), current: z.string() }),
  },
  /** Abre (o reabre) la carpeta como proyecto y lo deja activo en esta conexión. */
  "projects.open": {
    params: z.object({ path: z.string().min(1) }),
    result: ProjectViewSchema,
  },
  /** Cambia el proyecto activo de esta conexión. */
  "projects.use": {
    params: z.object({ project_id: z.string() }),
    result: ProjectViewSchema,
  },
  /** Rama, HEAD, upstream y cambios del repo del proyecto (`@keel/git`). */
  "projects.status": {
    params: z.object({ project_id: z.string().optional() }),
    result: z.object({
      project_id: z.string(),
      root_path: z.string(),
      git: z
        .object({
          branch: z.string().nullable(),
          head: z.string().nullable(),
          upstream: z.string().nullable(),
          ahead: z.number().int(),
          behind: z.number().int(),
          changed: z.number().int(),
          untracked: z.number().int(),
        })
        .nullable(),
    }),
  },
  "projects.set_vcs": {
    params: MutationMeta.extend({
      project_id: z.string().optional(),
      vcs: z.enum(["git", "none"]),
    }),
    result: z.object({
      project_id: z.string(),
      vcs: z.enum(["git", "none"]),
      vcs_none_confirmed_at: z.string().nullable(),
      vcs_none_confirmed_by: z.string().nullable(),
    }),
  },
  "snapshots.restore": {
    params: MutationMeta.extend({ run_id: z.string(), delete_new: z.boolean().optional() }),
    result: z.object({ run_id: z.string(), queued: z.literal(true) }),
  },
  "runs.start": {
    params: MutationMeta.extend({
      work_item_id: z.string(),
      purpose: RunPurposeSchema,
      profile: z.string().optional(),
      prompt: z.string().optional(),
      options: RunOptionsSchema.optional(),
    }),
    result: RunViewSchema,
  },
  /** ADR-0019 §3: un mensaje humano a un run vivo; queda como `run.user_message`. */
  "runs.message": {
    params: MutationMeta.extend({ run_id: z.string(), text: z.string().min(1).max(20_000) }),
    result: z.object({ run_id: z.string(), delivered: z.literal(true) }),
  },
  /**
   * Continúa un run terminado: run hijo (`parent_run_id`) que retoma la sesión
   * del proveedor y, si ejecuta, el worktree del padre.
   */
  "runs.continue": {
    params: MutationMeta.extend({
      run_id: z.string(),
      text: z.string().min(1).max(20_000),
      options: RunOptionsSchema.optional(),
    }),
    result: RunViewSchema,
  },
  "runs.pause": { params: MutationMeta.extend({ run_id: z.string() }), result: RunViewSchema },
  "runs.resume": {
    params: MutationMeta.extend({ run_id: z.string(), directive: z.string().optional() }),
    result: RunViewSchema,
  },
  "runs.cancel": {
    params: MutationMeta.extend({ run_id: z.string(), reason: z.string().optional() }),
    result: RunViewSchema,
  },
  "approvals.resolve": {
    params: MutationMeta.extend({
      approval_id: z.string(),
      operation_hash: z.string(),
      /**
       * `approve_session`: el mismo patrón el resto del run (máx. 15 min).
       * `approve_always`: además crea una regla `auto` del proyecto (ADR-0019 §4).
       */
      decision: z.enum(["approve_once", "approve_session", "approve_always", "amend", "deny"]),
      amended_operation: z.unknown().optional(),
      reason: z.string().optional(),
    }),
    result: z.object({
      approval_id: z.string(),
      state: z.enum(["approved", "denied", "expired", "consumed"]),
    }),
  },
  "approvals.list": {
    params: z.object({
      state: z.enum(["pending", "approved", "denied", "expired", "consumed"]).optional(),
      /** Todas las decisiones, no sólo las pendientes: la vista de permisos. */
      include_resolved: z.boolean().optional(),
      run_id: z.string().optional(),
      limit: z.number().int().positive().max(1000).optional(),
    }),
    result: z.object({ approvals: z.array(ApprovalViewSchema) }),
  },
  /** ADR-0012 §9: lectura por partes; el cliente verifica el hash al final. */
  "artifacts.read": {
    params: z.object({
      ref: z.string(),
      offset: z.number().int().nonnegative().optional(),
      length: z.number().int().positive().optional(),
    }),
    result: z.object({
      sha256: z.string(),
      size: z.number().int(),
      media_type: z.string(),
      sensitivity: SensitivitySchema,
      integrity: z.enum(["ok", "mismatch", "missing"]),
      offset: z.number().int(),
      data_base64: z.string(),
      eof: z.boolean(),
    }),
  },
  /**
   * Adjunta evidencia (ADR-0012 §3). El humano manda el contenido; un agente,
   * la ruta de un archivo de su worktree. Una corrección apunta a la anterior.
   */
  "evidence.attach": {
    params: MutationMeta.extend({
      work_item_id: z.string().optional(),
      run_id: z.string().optional(),
      kind: EvidenceKindSchema,
      title: z.string().max(200).optional(),
      content_base64: z.string().optional(),
      media_type: z.string().optional(),
      path: z.string().optional(),
      supersedes_id: z.string().optional(),
      metadata: z.record(z.string(), z.unknown()).optional(),
      sensitivity: SensitivitySchema.optional(),
    }),
    result: EvidenceViewSchema,
  },
  "evidence.list": {
    params: z.object({ work_item_id: z.string().optional(), run_id: z.string().optional() }),
    result: z.object({ evidence: z.array(EvidenceViewSchema) }),
  },
  /**
   * Retención explícita (ADR-0012 §7): borra eventos de un proyecto más viejos
   * que `older_than_days` (y, si se nombra, su evidencia); luego recolecta los
   * artefactos sin referencias. `dry_run` sólo cuenta.
   */
  "retention.purge": {
    params: MutationMeta.extend({
      project_id: z.string().optional(),
      older_than_days: z.number().int().positive(),
      event_kinds: z.array(z.string()).optional(),
      include_evidence: z.boolean().optional(),
      dry_run: z.boolean().optional(),
    }),
    result: z.object({
      events: z.number().int(),
      evidence: z.number().int(),
      artifacts: z.number().int(),
      dry_run: z.boolean(),
    }),
  },
  /** ADR-0011: eventos semánticos, por run o tarea; `after_seq` es su cursor propio. */
  "semantic.list": {
    params: z.object({
      run_id: z.string().optional(),
      work_item_id: z.string().optional(),
      kinds: z.array(z.string()).optional(),
      after_seq: z.number().int().nonnegative().optional(),
      limit: z.number().int().positive().max(1000).optional(),
    }),
    result: z.object({ events: z.array(SemanticEventViewSchema) }),
  },
  /** Borra la proyección semántica y la rehace desde `events` (ADR-0011 §1). */
  "semantic.rebuild": {
    params: MutationMeta.extend({ project_id: z.string().optional() }),
    result: z.object({ events: z.number().int() }),
  },
  /** ADR-0015 §1: estado del worktree del run, sin aprobación. */
  "git.status": {
    params: z.object({ run_id: z.string().optional() }),
    result: z.object({
      run_id: z.string(),
      worktree: z.string(),
      branch: z.string().nullable(),
      head: z.string().nullable(),
      files: z.array(GitPlanFileSchema),
    }),
  },
  "git.diff": {
    params: z.object({ run_id: z.string().optional(), paths: z.array(z.string()).optional() }),
    result: z.object({
      diff: z.string(),
      truncated: z.boolean(),
      files: z.array(GitPlanFileSchema),
    }),
  },
  /**
   * ADR-0015 §2: propone commit, push y PR como un plan. No ejecuta: el plan
   * entra al inbox con su hash y lo ejecuta el daemon al aprobarlo.
   */
  "git.propose": {
    params: MutationMeta.extend({
      run_id: z.string().optional(),
      message: z.string().min(1).max(5000),
      paths: z.array(z.string()).optional(),
      push: z.object({ remote: z.string().optional(), branch: z.string().optional() }).optional(),
      pr: z
        .object({
          base: z.string().optional(),
          title: z.string().min(1),
          body: z.string().optional(),
        })
        .optional(),
    }),
    result: z.object({ plan_id: z.string(), plan_hash: z.string(), plan: GitPlanSchema }),
  },
  "git.plan_status": {
    params: z.object({ plan_id: z.string() }),
    result: z.object({
      plan_id: z.string(),
      state: z.enum(["pending", "denied", "expired", "executing", "completed", "failed"]),
      steps: z.array(z.object({ op: z.string(), state: z.string(), detail: z.unknown() })),
    }),
  },
  /**
   * ADR-0017 §2: búsqueda en el proyecto (tareas, notas, evidencia,
   * investigaciones). Responde fragmentos y referencias, y dice su modo: sin
   * embedder evaluado es `lexical`.
   */
  "context.search": {
    params: z.object({
      query: z.string().min(1).max(500),
      scopes: z.array(z.enum(["tasks", "notes", "evidence", "research"])).optional(),
      limit: z.number().int().positive().max(50).optional(),
    }),
    result: z.object({
      mode: z.enum(["lexical", "hybrid"]),
      results: z.array(
        z.object({
          ref: z.string(),
          kind: z.string(),
          title: z.string(),
          snippet: z.string(),
          rank: z.number(),
        }),
      ),
    }),
  },
  /** ADR-0017 §1: `keel://project/context`, documentos de `always_read` y la lista de ADRs. */
  "context.project": {
    params: z.object({}),
    result: z.object({
      root: z.string(),
      always_read: z.array(
        z.object({ path: z.string(), text: z.string(), truncated: z.boolean() }),
      ),
      adrs: z.array(z.object({ path: z.string(), title: z.string() })),
    }),
  },
  "connections.list": {
    params: z.object({}),
    result: z.object({ connections: z.array(ConnectionViewSchema) }),
  },
  /** Alta de una conexión: referencias a secretos, nunca valores (ADR-0013 §1). */
  "connections.add": {
    params: MutationMeta.extend({
      name: z.string().min(1).max(80),
      type: z.enum(["postgres", "sqlite", "ssh", "terraform"]),
      environment: z.enum(["dev", "staging", "prod"]),
      config: z.record(z.string(), z.unknown()),
      secret_ref: z.string().optional(),
      secret_ref_ro: z.string().optional(),
      server_guarantee: z.string().optional(),
    }),
    result: ConnectionViewSchema,
  },
  "connections.archive": {
    params: MutationMeta.extend({ connection_id: z.string() }),
    result: z.object({ connection_id: z.string(), archived: z.literal(true) }),
  },
  /** El permiso es por conexión y operación; en prod las escrituras nunca son auto. */
  "grants.set": {
    params: MutationMeta.extend({
      connection_id: z.string(),
      operation: z.string(),
      policy: GrantPolicySchema,
      expires_at: z.string().optional(),
    }),
    result: ConnectionViewSchema,
  },
  /** Lo que el agente ve: conexiones y operaciones permitidas, nunca credenciales. */
  "resources.list": {
    params: z.object({}),
    result: z.object({ connections: z.array(ConnectionViewSchema) }),
  },
  /** Ejecuta una operación con la credencial; el agente ve el resultado, no el secreto. */
  "resources.execute": {
    params: MutationMeta.extend({
      connection: z.string(),
      operation: z.string(),
      input: z.record(z.string(), z.unknown()),
    }),
    result: z.object({
      operation: z.string(),
      summary: z.string(),
      columns: z.array(z.string()).optional(),
      rows: z.array(z.array(z.unknown())).optional(),
      row_count: z.number().int().optional(),
      truncated: z.boolean().optional(),
      output: z.string().optional(),
      exit_code: z.number().int().nullable().optional(),
      plan_sha256: z.string().optional(),
      evidence_id: z.string().nullable(),
      result_ref: z.string().nullable(),
    }),
  },
  /** ADR-0014 §6: instalación explícita, con versión y hash fijos. */
  "plugins.install": {
    params: MutationMeta.extend({ path: z.string().min(1) }),
    result: PluginViewSchema,
  },
  "plugins.list": {
    params: z.object({}),
    result: z.object({ plugins: z.array(PluginViewSchema) }),
  },
  /** Desinstalar no borra lo que interpretó (ADR-0014 §5). */
  "plugins.uninstall": {
    params: MutationMeta.extend({ id: z.string() }),
    result: z.object({ id: z.string(), uninstalled: z.literal(true) }),
  },
  /** Guarda bytes en el almacén (p. ej., el SVG de una gráfica, ADR-0012 §5); sólo humano. */
  "artifacts.put": {
    params: MutationMeta.extend({ content_base64: z.string(), media_type: z.string() }),
    result: z.object({ ref: z.string(), sha256: z.string(), size: z.number().int() }),
  },
  /** ADR-0016 §2–§3: hipótesis, hallazgos y conclusiones de una tarea `research`. */
  "research.claim_add": {
    params: MutationMeta.extend({
      work_item_id: z.string().optional(),
      kind: ClaimKindSchema,
      statement: z.string().min(1).max(4000),
      evidence_ids: z.array(z.string()).optional(),
    }),
    result: ClaimViewSchema,
  },
  /** Sólo un humano verifica o refuta (ADR-0016 §2). */
  "research.claim_decide": {
    params: MutationMeta.extend({
      claim_id: z.string(),
      decision: z.enum(["verified", "refuted"]),
      reason: z.string().optional(),
    }),
    result: ClaimViewSchema,
  },
  "research.claims_list": {
    params: z.object({ work_item_id: z.string().optional() }),
    result: z.object({ claims: z.array(ClaimViewSchema) }),
  },
  /** Versión inmutable con hash; si nada cambió, devuelve la misma versión. */
  "research.report_generate": {
    params: MutationMeta.extend({ work_item_id: z.string() }),
    result: ReportViewSchema,
  },
  "research.reports_list": {
    params: z.object({ work_item_id: z.string() }),
    result: z.object({ reports: z.array(ReportViewSchema) }),
  },
  /** Markdown o HTML con las gráficas ya renderizadas; lo restringido sólo si se elige. */
  "research.report_export": {
    params: z.object({
      report_id: z.string(),
      format: z.enum(["markdown", "html"]),
      include_restricted: z.boolean().optional(),
    }),
    result: z.object({ filename: z.string(), media_type: z.string(), content: z.string() }),
  },
  "permissions.rules_list": {
    params: z.object({ include_revoked: z.boolean().optional() }),
    result: z.object({ rules: z.array(PermissionRuleViewSchema) }),
  },
  "permissions.rule_add": {
    params: MutationMeta.extend({
      tool: z.string().min(1),
      prefix: z.string().min(1).nullable().optional(),
      exact: z.boolean().optional(),
      effect: z.enum(["auto", "deny"]),
      expires_at: z.string().optional(),
    }),
    result: PermissionRuleViewSchema,
  },
  "permissions.rule_revoke": {
    params: MutationMeta.extend({ rule_id: z.string() }),
    result: PermissionRuleViewSchema,
  },
  "events.subscribe": {
    params: z.object({
      project_id: z.string().optional(),
      after_event_seq: z.number().int().nonnegative().default(0),
    }),
    result: z.object({
      subscription_id: z.string(),
      cursor: z.number().int().nonnegative(),
      snapshot: z.object({ work_items: z.array(WorkItemViewSchema), runs: z.array(RunViewSchema) }),
    }),
  },
  "events.unsubscribe": {
    params: z.object({ subscription_id: z.string() }),
    result: z.object({ ok: z.literal(true) }),
  },
  "fs.read": {
    params: z.object({
      target_id: z.string(),
      repo_id: z.string(),
      revision: z.string(),
      path: z.string(),
    }),
    result: z.object({ content: z.string(), sha256: z.string(), truncated: z.boolean() }),
  },
  "diff.read": {
    params: z.object({ run_id: z.string(), repo_id: z.string() }),
    result: z.object({
      files: z.array(
        z.object({
          path: z.string(),
          additions: z.number().int(),
          deletions: z.number().int(),
          patch: z.string(),
        }),
      ),
    }),
  },
  "pty.attach": {
    params: z.object({ run_id: z.string(), repo_id: z.string().optional() }),
    result: z.object({ session_name: z.string(), cols: z.number().int(), rows: z.number().int() }),
  },
  "daemon.health": {
    params: z.object({}),
    result: z.object({
      version: z.string(),
      event_loop_lag_ms: z.number(),
      rss_bytes: z.number().int(),
      ingest_queue: z.number().int(),
      wal_bytes: z.number().int(),
      /** Límites vigentes y gasto estimado de hoy: subir un límite debe verse (ADR-0002 regla 3). */
      limits: z
        .object({
          max_concurrent_runs: z.number().int(),
          run_budget_micro_usd: z.number().int(),
          daily_budget_micro_usd: z.number().int(),
        })
        .optional(),
      spent_today_micro_usd: z.number().int().optional(),
      /** A qué proyecto y carpeta sirve este daemon: el cliente lo muestra para no confundir daemons. */
      project: z.object({ id: z.string(), root_path: z.string() }).optional(),
    }),
  },
} as const
export type MethodName = keyof typeof Methods

/**
 * Lo único que puede pedir una conexión vinculada como actor `agent`
 * (ADR-0009 §5). El daemon además comprueba en cada operación que el recurso
 * pertenezca a la capacidad del agente: conocer un id no autoriza nada.
 */
export const AGENT_METHODS: readonly MethodName[] = [
  "daemon.health",
  "session.bind_agent",
  "work_items.list",
  "work_items.get",
  "work_items.create",
  "notes.add",
  "handoffs.request",
  "runs.request",
  "session.pair_status",
  "evidence.attach",
  "git.status",
  "git.diff",
  "context.search",
  "context.project",
  "evidence.list",
  "resources.list",
  "resources.execute",
  "research.claim_add",
  "research.claims_list",
  "git.propose",
  "git.plan_status",
]

/** El scope que exige cada método de agente; los demás no necesitan scope. */
export const METHOD_SCOPE: Partial<Record<MethodName, AgentScope>> = {
  "work_items.list": "tasks:read",
  "work_items.get": "tasks:read",
  "work_items.create": "tasks:write",
  "handoffs.request": "tasks:write",
  "notes.add": "notes:write",
  "runs.request": "runs:request",
  "evidence.attach": "notes:write",
  "context.search": "tasks:read",
  "context.project": "tasks:read",
  "evidence.list": "tasks:read",
  "resources.list": "resources:use",
  "research.claim_add": "notes:write",
  "research.claims_list": "tasks:read",
  "resources.execute": "resources:use",
}

/**
 * Una conexión que pidió `session.pair` y aún no tiene respuesta sólo puede
 * esto (ADR-0009 §2): ni actúa como humano ni como agente.
 */
export const PENDING_METHODS: readonly MethodName[] = ["daemon.health", "session.pair_status"]
/**
 * Conexiones por la puerta de agentes que aún no se vincularon (ADR-0018 §2):
 * sólo pueden vincularse con su token o pedir emparejamiento. Nunca son humanas.
 */
export const UNBOUND_METHODS: readonly MethodName[] = [
  "daemon.health",
  "session.bind_agent",
  "session.pair",
]
export const ActorKindSchema = z.enum(["human", "agent", "system"])
export type ActorKind = z.infer<typeof ActorKindSchema>
export const METHOD_NAMES = Object.keys(Methods) as MethodName[]

/** Notificaciones que emite el daemon. */
export const EventNotification = z.object({
  event_seq: z.number().int().positive(),
  kind: z.string(),
  project_id: z.string(),
  run_id: z.string().nullable(),
  received_at: z.string(),
  entity: z.union([WorkItemViewSchema, RunViewSchema, NodeViewSchema]).optional(),
  payload: z.unknown().optional(),
})
export type EventNotification = z.infer<typeof EventNotification>

// --- codec NDJSON ---------------------------------------------------------------------
export type DecodeResult =
  | { ok: true; frame: Frame }
  | { ok: false; error: RpcError; id: JsonRpcId | null }

/** Decodifica una línea NDJSON a un frame válido o a un error estructurado (nunca lanza). */
export function decodeFrame(line: string): DecodeResult {
  if (line.length > MAX_FRAME_BYTES) {
    return {
      ok: false,
      id: null,
      error: {
        code: ErrorCode.frameTooLarge,
        message: `frame de ${line.length} bytes supera ${MAX_FRAME_BYTES}`,
        retryable: false,
      },
    }
  }
  let raw: unknown
  try {
    raw = JSON.parse(line)
  } catch (e) {
    return {
      ok: false,
      id: null,
      error: {
        code: ErrorCode.parseError,
        message: e instanceof Error ? e.message : "JSON inválido",
        retryable: false,
      },
    }
  }
  const id =
    typeof raw === "object" && raw !== null && "id" in raw
      ? JsonRpcId.safeParse((raw as { id: unknown }).id)
      : null
  const idValue: JsonRpcId | null = id?.success ? id.data : null
  if (
    typeof raw === "object" &&
    raw !== null &&
    (raw as { keel_protocol?: unknown }).keel_protocol !== KEEL_PROTOCOL_VERSION
  ) {
    return {
      ok: false,
      id: idValue,
      error: {
        code: ErrorCode.protocolVersion,
        message: `keel_protocol debe ser ${KEEL_PROTOCOL_VERSION}`,
        retryable: false,
      },
    }
  }
  const parsed = Frame.safeParse(raw)
  if (!parsed.success) {
    return {
      ok: false,
      id: idValue,
      error: {
        code: ErrorCode.invalidRequest,
        message: "frame inválido",
        retryable: false,
        details: parsed.error.issues,
      },
    }
  }
  return { ok: true, frame: parsed.data }
}

/** Codifica un frame a una línea NDJSON (sin el salto final). Rechaza saltos de línea sin escapar por construcción. */
export function encodeFrame(frame: Frame): string {
  return JSON.stringify(frame)
}

export function request(id: JsonRpcId, method: MethodName, params: unknown): Request {
  return { jsonrpc: "2.0", keel_protocol: KEEL_PROTOCOL_VERSION, id, method, params }
}
export function success(id: JsonRpcId, result: unknown): SuccessResponse {
  return { jsonrpc: "2.0", keel_protocol: KEEL_PROTOCOL_VERSION, id, result }
}
export function failure(id: JsonRpcId | null, error: RpcError): ErrorResponse {
  return { jsonrpc: "2.0", keel_protocol: KEEL_PROTOCOL_VERSION, id, error }
}
export function notification(method: string, params: unknown): Notification {
  return { jsonrpc: "2.0", keel_protocol: KEEL_PROTOCOL_VERSION, method, params }
}

/** Valida los params de un método conocido; devuelve el error JSON-RPC adecuado si no cuadran. */
export function validateParams(
  method: string,
  params: unknown,
): { ok: true; method: MethodName; params: unknown } | { ok: false; error: RpcError } {
  // `in` también ve propiedades heredadas (`toString`, `constructor`, `__proto__`):
  // sólo cuentan las propias del catálogo.
  if (!Object.hasOwn(Methods, method))
    return {
      ok: false,
      error: {
        code: ErrorCode.methodNotFound,
        message: `método desconocido: ${method}`,
        retryable: false,
      },
    }
  const spec = Methods[method as MethodName]
  const parsed = spec.params.safeParse(params ?? {})
  if (!parsed.success)
    return {
      ok: false,
      error: {
        code: ErrorCode.invalidParams,
        message: `params inválidos para ${method}`,
        retryable: false,
        details: parsed.error.issues,
      },
    }
  return { ok: true, method: method as MethodName, params: parsed.data }
}
