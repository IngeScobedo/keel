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
import { BatchIntentSchema, DRAFT_KINDS } from "./intake.js"
import { CEREMONIES, STAGES, TASK_DOC_KINDS } from "./method.js"
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
/** Niveles de esfuerzo que entiende el proveedor (ADR-0020 §5). */
export const EffortSchema = z.enum(["low", "medium", "high", "xhigh", "max"])
export type Effort = z.infer<typeof EffortSchema>
/** Lo que el humano elige al arrancar; el daemon guarda los valores efectivos en el manifest. */
export const RunOptionsSchema = z.object({
  model: z.string().min(1).max(120).optional(),
  max_turns: z.number().int().min(1).max(500).optional(),
  permission_mode: PermissionModeSchema.optional(),
  effort: EffortSchema.optional(),
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

export const StageSchema = z.enum(STAGES)
export const CeremonySchema = z.enum(CEREMONIES)
export const TaskDocKindSchema = z.enum(TASK_DOC_KINDS)
export const PrioritySchema = z.enum(["urgent", "high", "medium", "low"])
export type Priority = z.infer<typeof PrioritySchema>
export const WorkItemViewSchema = z.object({
  id: z.string(),
  project_id: z.string(),
  display_id: z.string(),
  title: z.string(),
  kind: z.string().optional(),
  lifecycle: LifecycleSchema,
  board_status: z.string(),
  /** Etapa del método si la tarea se está trabajando (ADR-0021). */
  stage: StageSchema.optional(),
  ceremony: CeremonySchema.nullable().optional(),
  priority: PrioritySchema.optional(),
  /** La feature de la que es subtarea (ADR-0022). */
  parent_work_item_id: z.string().optional(),
  /** La tarea de la que nació, si la creó un agente fuera del plan (ADR-0024 §2). */
  origin_work_item_id: z.string().optional(),
  /** ADR-0022 §5: el avance de una feature con subtareas. */
  feature: z
    .object({
      branch: z.string(),
      auto_integrate: z.boolean(),
      done: z.number().int(),
      working: z.number().int(),
      blocked: z.number().int(),
      total: z.number().int(),
      phase: z.number().int().nullable(),
    })
    .optional(),
  /** ADR-0022: su línea del plan de la feature. */
  subtask: z
    .object({ key: z.string(), phase: z.number().int(), phase_title: z.string() })
    .optional(),
  ...projected,
})
/** Resultado de un comando de verificación del proyecto, recortado para el agente. */
export const VerifyResultSchema = z.object({
  name: z.string(),
  command: z.string(),
  ok: z.boolean(),
  exit_code: z.number().int().nullable(),
  duration_ms: z.number().int(),
  /** Las últimas líneas de la salida; la salida entera queda como artefacto. */
  tail: z.string(),
  output_ref: z.string().nullable(),
})
export type VerifyResult = z.infer<typeof VerifyResultSchema>
export const VerifyDeltaSchema = z.object({
  green: z.boolean(),
  newRed: z.array(z.string()),
  stillRed: z.array(z.string()),
  fixed: z.array(z.string()),
})
export const DocReportSchema = z.object({
  ok: z.boolean(),
  checks: z.array(
    z.object({
      ok: z.boolean(),
      level: z.enum(["block", "warn"]),
      msg: z.string(),
      detail: z.string().optional(),
    }),
  ),
})
/** El flujo de una tarea que se está trabajando (ADR-0021 §2). */
export const TaskFlowViewSchema = z.object({
  work_item_id: z.string(),
  stage: StageSchema,
  ceremony: CeremonySchema.nullable(),
  ceremony_reason: z.string().nullable(),
  contract_sha256: z.string().nullable(),
  baseline: z.array(VerifyResultSchema).nullable(),
  started_by: z.string(),
  updated_at: z.string(),
  /** El gate humano que espera, si hay uno. */
  pending_gate: z
    .object({
      approval_id: z.string(),
      operation_hash: z.string(),
      gate: z.enum(["brief", "design", "close"]),
      to: StageSchema,
    })
    .nullable(),
  /**
   * El último plan de git de la tarea (ADR-0015): si espera, si falló y por qué. Sin él,
   * una tarea en `close` con el plan caído parecía esperar algo que no estaba.
   */
  git_plan: z
    .object({
      plan_id: z.string(),
      run_id: z.string(),
      state: z.enum(["pending", "denied", "expired", "executing", "completed", "failed"]),
      reason: z.string().nullable(),
      /** Lo que sí se hizo antes de fallar: `git.commit.created`, `git.push.completed`… */
      done: z.array(z.string()),
    })
    .nullable()
    .optional(),
})
export type TaskFlowView = z.infer<typeof TaskFlowViewSchema>
export const TaskDocViewSchema = z.object({
  id: z.string(),
  work_item_id: z.string(),
  kind: TaskDocKindSchema,
  version: z.number().int(),
  sha256: z.string(),
  size: z.number().int(),
  author: z.string(),
  created_at: z.string(),
  /** Validación determinista del documento contra el método (ADR-0021). */
  report: DocReportSchema,
  content_markdown: z.string().optional(),
})
export type TaskDocView = z.infer<typeof TaskDocViewSchema>
/** Lo que Keel sabe del proyecto para conducir el método (ADR-0021 §5). */
export const ProjectProfileSchema = z.object({
  stack: z.array(z.string()),
  /** Comandos de verificación en el orden en que se corren; el delta-verde los compara. */
  verify: z.array(
    z.object({
      name: z.string().min(1).max(40),
      command: z.string().min(1).max(2_000),
      timeout_ms: z.number().int().positive().max(3_600_000).optional(),
    }),
  ),
  protected_branches: z.array(z.string()),
  /** Prefijos de rama por tipo de trabajo (`feat/`, `fix/`…). */
  branch_prefixes: z.record(z.string(), z.string()),
  generated_paths: z.array(z.string()),
  /** Dónde vive el canon del proyecto; puede haber un ADR y un SDD por contexto. */
  canon: z.object({
    adr_dirs: z.array(z.string()),
    sdd_dirs: z.array(z.string()),
    roadmap: z.string().nullable(),
  }),
  /** Fuentes de RegExp: tocar uno exige ADR en el diseño. */
  invariants: z.array(z.string()),
  adr_pattern: z.string().nullable(),
  /** El repo trae su propio harness (`.claude/`, `AGENTS.md`). */
  harness: z.object({ claude_dir: z.boolean(), agents_md: z.boolean(), claude_md: z.boolean() }),
})
export type ProjectProfile = z.infer<typeof ProjectProfileSchema>
export const ProjectProfileViewSchema = z.object({
  project_id: z.string(),
  profile: ProjectProfileSchema,
  /** Lo que detectó Keel, para comparar con lo confirmado. */
  detected: ProjectProfileSchema,
  confirmed_by: z.string().nullable(),
  confirmed_at: z.string().nullable(),
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
/** ADR-0040: una fuente del proyecto, partida en pasajes citables. */
export const SourceViewSchema = z.object({
  id: z.string(),
  /** `S-1`, `S-2`…: lo que se cita. */
  key: z.string(),
  title: z.string(),
  media_type: z.string(),
  passages: z.number().int(),
  created_by: z.string(),
  created_at: z.string(),
})
export const PassageSchema = z.object({
  anchor: z.string(),
  heading: z.string().nullable(),
  text: z.string(),
})
export const DraftIntentSchema = z.object({
  text: z.string(),
  kind: z.enum(DRAFT_KINDS),
  confidence: z.number(),
  ordering: z.enum(["now", "end-of-batch", "deferred"]),
  span: z.tuple([z.number().int(), z.number().int()]),
})
export const ReadyCheckSchema = z.object({
  goal: z.boolean(),
  scope: z.boolean(),
  acceptance: z.boolean(),
  ready: z.boolean(),
  questions: z.array(
    z.object({
      slot: z.enum(["goal", "scope", "acceptance"]),
      question: z.string(),
      options: z.array(z.string()),
    }),
  ),
})
/** ADR-0035: el plan del lote tal como lo ve y lo edita el humano. */
export const BatchPlanSchema = z.object({
  title: z.string().min(3).max(200),
  summary: z.string().max(10_000).default(""),
  intents: z.array(BatchIntentSchema).min(1).max(40),
  /** Las subtareas listas se integran solas a la rama del lote (ADR-0022 §2). */
  auto_integrate: z.boolean().default(true),
})
export type BatchPlan = z.infer<typeof BatchPlanSchema>
/**
 * ADR-0034 §6: notificación a todos los clientes humanos, sin importar su proyecto
 * activo, cuando cambia lo que espera al humano en cualquier proyecto.
 */
export const AttentionChangedSchema = z.object({ project_id: z.string(), kind: z.string() })
export type AttentionChanged = z.infer<typeof AttentionChangedSchema>
export const ApprovalViewSchema = z.object({
  id: z.string(),
  run_id: z.string(),
  work_item_id: z.string(),
  /** ADR-0034 §6: de qué proyecto es, para avisar desde otro. */
  project_id: z.string(),
  project_name: z.string(),
  /** La tarea, para que el aviso diga de cuál se trata sin otra llamada. */
  work_item_display_id: z.string(),
  work_item_title: z.string(),
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
  /** ADR-0031: `iac.plan` es el check (`--check --diff`); `iac.apply`, el despliegue. */
  ansible: ["iac.plan", "iac.apply"],
} as const
export type ConnectionType = keyof typeof CONNECTION_OPERATIONS
/** Operaciones que nunca son `auto` en producción (ADR-0013 §4). */
export const WRITE_OPERATIONS = ["query.write", "command.run", "iac.apply"] as const
export const GrantPolicySchema = z.enum(["auto", "ask", "deny"])
/** ADR-0025 §3: cómo entra una conexión, como en Termius. */
export const AUTH_METHODS = ["agent", "file", "key", "password", "ask"] as const
export const AuthMethodSchema = z.enum(AUTH_METHODS)
export type AuthMethod = z.infer<typeof AuthMethodSchema>
export const ConnectionViewSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.enum(["postgres", "sqlite", "ssh", "terraform", "ansible"]),
  environment: z.enum(["dev", "staging", "prod"]),
  /** Configuración sin secretos (host, base, ruta…). */
  config: z.record(z.string(), z.unknown()),
  has_secret: z.boolean(),
  has_secret_ro: z.boolean(),
  /** Qué garantiza el servidor y qué sólo Keel (ADR-0013 §5). */
  guarantees: z.object({ server: z.string().nullable(), keel: z.string() }),
  operations: z.array(
    z.object({
      operation: z.string(),
      policy: GrantPolicySchema,
      effective: GrantPolicySchema,
      /** ADR-0026: el humano quitó la pregunta en producción asumiendo el riesgo. */
      risk_accepted_at: z.string().nullable().optional(),
    }),
  ),
  /** ADR-0025 §3: cómo entra; null = la referencia de ADR-0013 (`secret_ref`). */
  auth_method: AuthMethodSchema.nullable().optional(),
  tags: z.array(z.string()).optional(),
  /** La huella aceptada del host (SSH), si la hay. */
  host_key: z.object({ fingerprint: z.string(), type: z.string() }).nullable().optional(),
  /** Lo que el vault guarda para esta conexión: nunca el valor. */
  secret: z
    .object({
      kind: z.string(),
      public_key: z.string().nullable(),
      last_used_at: z.string().nullable(),
    })
    .nullable()
    .optional(),
})
export const BaseStateSchema = z.object({
  branch: z.string().nullable(),
  upstream: z.string().nullable(),
  ahead: z.number().int(),
  behind: z.number().int(),
  fetched: z.boolean(),
  error: z.string().nullable(),
})
export const VaultStatusSchema = z.object({
  state: z.enum(["unlocked", "locked", "uninitialized"]),
  keystore: z.enum(["keychain", "passphrase", "none"]),
  keychain: z.object({
    available: z.boolean(),
    tool: z.string().nullable(),
    hint: z.string().nullable(),
  }),
  items: z.number().int(),
})
export const ImportedHostSchema = z.object({
  alias: z.string(),
  host: z.string(),
  user: z.string().nullable(),
  port: z.number().int(),
  proxy_jump: z.string().nullable(),
  identity_file: z.string().nullable(),
  environment: z.enum(["dev", "staging", "prod"]).nullable(),
  why: z.string(),
})
/** ADR-0025 §6: lo que el agente puede pedir; nunca un secreto. */
export const SetupRequestSchema = z.object({
  kind: z.enum(["connection", "grant", "plugin", "profile"]),
  why: z.string().min(1).max(2_000),
  /** Lo que propone: tipo, nombre, entorno, host, usuario, puerto, operación… sin secretos. */
  proposal: z.record(z.string(), z.unknown()),
  /** De dónde lo sacó: un archivo, un script, una línea. */
  evidence: z.string().max(500).optional(),
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
      effort: EffortSchema.nullable().optional(),
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
/** Un modelo que el proveedor dice tener para esta cuenta (ADR-0020 §5). */
export const ModelOptionSchema = z.object({
  value: z.string(),
  display_name: z.string(),
  description: z.string(),
  efforts: z.array(EffortSchema),
})
export type ModelOption = z.infer<typeof ModelOptionSchema>
/** Respuestas a `AskUserQuestion`: texto de la pregunta → etiqueta elegida (ADR-0020 §7). */
export const QuestionAnswersSchema = z.record(z.string(), z.string().max(20_000))
export const QuestionAnnotationsSchema = z.record(
  z.string(),
  z.object({ notes: z.string().max(20_000).optional(), preview: z.string().optional() }),
)

/** Ajustes del usuario; `source` dice de dónde sale el valor vigente. */
export const SettingsViewSchema = z.object({
  codex_subscription: z.object({
    enabled: z.boolean(),
    /** `flag`: `--codex-subscription` al arrancar; `setting`: lo eligió en la GUI. */
    source: z.enum(["flag", "setting", "off"]),
    updated_by: z.string().nullable(),
    updated_at: z.string().nullable(),
  }),
  /** ADR-0020 §3: null = una aprobación espera sin límite; al vencer, se niega. */
  approvals: z.object({ timeout_ms: z.number().int().positive().nullable() }),
  /** ADR-0020 §6: sugerencias de mensaje de Claude (cuestan tokens). */
  prompt_suggestions: z.object({ enabled: z.boolean() }),
  /**
   * ADR-0019 §4: con qué modelo arranca una tarea nueva si el humano no elige otro al
   * pulsar «Trabajar». `source: default` es el del perfil; `setting`, el que eligió el humano.
   */
  default_models: z
    .object({
      claude: z.object({
        model: z.string().nullable(),
        effort: EffortSchema.nullable(),
        source: z.enum(["default", "setting"]),
      }),
      codex: z.object({
        model: z.string().nullable(),
        effort: EffortSchema.nullable(),
        source: z.enum(["default", "setting"]),
      }),
      updated_by: z.string().nullable(),
      updated_at: z.string().nullable(),
    })
    .optional(),
  /**
   * ADR-0002 regla 5: presupuesto estimado y concurrencia. Defaults bajos; subirlos
   * es acción del humano (aquí o con flags del daemon, que mandan).
   */
  limits: z
    .object({
      /** null: sin tope, por decisión del humano (ADR-0002 regla 3). */
      run_budget_usd: z.number().nullable(),
      daily_budget_usd: z.number().nullable(),
      max_concurrent_runs: z.number().int(),
      source: z.enum(["default", "setting", "flag"]),
      updated_by: z.string().nullable(),
      updated_at: z.string().nullable(),
    })
    .optional(),
})
export type SettingsView = z.infer<typeof SettingsViewSchema>

export const Methods = {
  "work_items.create": {
    params: MutationMeta.extend({
      project_id: z.string().optional(),
      title: z.string().min(1),
      kind: z.string(),
      spec_markdown: z.string().optional(),
      priority: PrioritySchema.optional(),
    }),
    result: WorkItemViewSchema,
  },
  /**
   * ADR-0027: cierre humano de una tarea, con su motivo y su evidencia (un enlace o
   * un texto que diga dónde está el trabajo). Sólo por la puerta humana.
   */
  "work_items.close": {
    params: MutationMeta.extend({
      work_item_id: z.string(),
      reason: z.string().trim().min(3).max(2_000),
      evidence: z
        .object({
          url: z.string().url().max(2_000).optional(),
          text: z.string().trim().min(3).max(2_000).optional(),
        })
        .refine((e) => e.url !== undefined || e.text !== undefined, {
          message: "la evidencia necesita un enlace o un texto",
        }),
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
  /**
   * ADR-0028: la rama del proyecto contra su remoto, después de un `git fetch` sin
   * terminal. `error` dice por qué no se pudo consultar (sin red, sin permiso).
   */
  "projects.base_check": {
    params: z.object({ project_id: z.string().optional() }),
    result: BaseStateSchema,
  },
  /** ADR-0028: `git pull --ff-only` del checkout del humano, a pedido suyo. */
  "projects.pull": {
    params: MutationMeta.extend({ project_id: z.string().optional() }),
    result: BaseStateSchema,
  },
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
  /** ADR-0020 §4: el modo de un run vivo; `bypass` sólo con worktree de git. */
  "runs.set_mode": {
    params: MutationMeta.extend({ run_id: z.string(), permission_mode: PermissionModeSchema }),
    result: z.object({ run: RunViewSchema, applies: z.enum(["now", "next_turn"]) }),
  },
  /** ADR-0020 §4: modelo y esfuerzo de un run vivo. */
  "runs.set_model": {
    params: MutationMeta.extend({
      run_id: z.string(),
      model: z.string().min(1).max(120),
      effort: EffortSchema.optional(),
    }),
    result: z.object({ run: RunViewSchema, applies: z.enum(["now", "next_turn"]) }),
  },
  /**
   * ADR-0021 §3: «Trabajar» en una tarea. El daemon decide: escribirle al run
   * vivo, continuar la conversación o arrancarla en la etapa que toca.
   */
  "tasks.work": {
    params: MutationMeta.extend({
      work_item_id: z.string(),
      text: z.string().max(20_000).optional(),
      profile: z.enum(["claude", "codex"]).optional(),
      options: RunOptionsSchema.optional(),
    }),
    result: z.object({
      delivered: z.enum(["message", "continued", "started"]),
      run: RunViewSchema,
      flow: TaskFlowViewSchema,
    }),
  },
  /**
   * ADR-0024: la conversación del proyecto. `open` la crea la primera vez (una
   * tarea oculta) y devuelve su último run, lo que nació de ella y sus notas.
   */
  "conversation.open": {
    params: z.object({ project_id: z.string().optional() }),
    result: z.object({
      work_item: WorkItemViewSchema,
      run: RunViewSchema.nullable(),
      born: z.array(WorkItemViewSchema),
      notes: z.array(NoteViewSchema),
    }),
  },
  /**
   * Pregunta al proyecto: le escribe al run vivo, continúa la última sesión o,
   * con `fresh`, empieza una conversación nueva sin la sesión anterior.
   */
  "conversation.ask": {
    params: MutationMeta.extend({
      project_id: z.string().optional(),
      text: z.string().min(1).max(20_000),
      fresh: z.boolean().optional(),
      /** ADR-0040: fuentes adjuntas a este mensaje (ids); el agente las lee con `source_read`. */
      sources: z.array(z.string()).max(20).optional(),
      profile: z.enum(["claude", "codex"]).optional(),
      options: RunOptionsSchema.optional(),
    }),
    result: z.object({
      delivered: z.enum(["message", "continued", "started"]),
      run: RunViewSchema,
    }),
  },
  /** ADR-0040: adjuntar una fuente al proyecto; Keel la parte en pasajes. Sólo humanos. */
  "sources.add": {
    params: MutationMeta.extend({
      title: z.string().min(1).max(300),
      media_type: z.string().min(1).max(200),
      /** El archivo en base64; hasta ~8 MB. */
      content_base64: z.string().min(1).max(12_000_000),
      project_id: z.string().optional(),
    }),
    result: SourceViewSchema,
  },
  "sources.list": {
    params: z.object({ project_id: z.string().optional() }),
    result: z.object({ sources: z.array(SourceViewSchema) }),
  },
  /** Una fuente con sus pasajes, por id o por clave (`S-2`). */
  "sources.get": {
    params: z.object({ source: z.string(), project_id: z.string().optional() }),
    result: z.object({ source: SourceViewSchema, passages: z.array(PassageSchema) }),
  },
  /** ADR-0042: el primer corte determinista de un mensaje en intents. */
  "intake.draft": {
    params: z.object({ text: z.string().min(1).max(50_000) }),
    result: z.object({ intents: z.array(DraftIntentSchema) }),
  },
  /** ADR-0042: rutas del repo que coinciden con un texto (`git ls-files`, sin tokens). */
  "repo.anchor": {
    params: z.object({
      query: z.string().min(1).max(500),
      limit: z.number().int().max(50).optional(),
    }),
    result: z.object({ matches: z.array(z.string()) }),
  },
  /** ADR-0042: objetivo, alcance y criterio de un intent; preguntas para lo que falta. */
  "intake.ready_check": {
    params: z.object({ intent: BatchIntentSchema }),
    result: ReadyCheckSchema,
  },
  /**
   * ADR-0035: el orquestador propone el lote. Keel valida el esquema, corre el check de
   * listo sobre cada intent y abre el gate del plan en la conversación. No arranca nada.
   */
  "batch.propose": {
    params: MutationMeta.extend(BatchPlanSchema.shape),
    result: z.object({
      approval_id: z.string(),
      ready: z.array(z.string()),
      not_ready: z.array(z.object({ key: z.string(), questions: z.array(z.string()) })),
      lanes: z.array(z.array(z.string())),
    }),
  },
  /** ADR-0038 §4: el reporte del lote, desde sus subtareas e intents, no desde diffs. */
  "batch.report": {
    params: z.object({ work_item_id: z.string() }),
    result: z.object({ markdown: z.string() }),
  },
  "tasks.flow": {
    params: z.object({ work_item_id: z.string() }),
    result: z.object({ flow: TaskFlowViewSchema.nullable() }),
  },
  /**
   * ADR-0021 §2: el agente avanza la etapa; Keel valida la transición y sus
   * documentos, y abre el gate humano si lo hay.
   */
  "stages.advance": {
    params: MutationMeta.extend({
      work_item_id: z.string(),
      to: StageSchema,
      ceremony: CeremonySchema.optional(),
      reason: z.string().max(4_000).optional(),
    }),
    result: z.object({
      flow: TaskFlowViewSchema,
      /** null si avanzó; si no, el gate que quedó esperando al humano. */
      gate: z
        .object({ approval_id: z.string(), gate: z.enum(["brief", "design", "close"]) })
        .nullable(),
    }),
  },
  /** Un humano devuelve la tarea a una etapa anterior. */
  "stages.return": {
    params: MutationMeta.extend({
      work_item_id: z.string(),
      to: StageSchema,
      reason: z.string().min(1).max(4_000),
    }),
    result: TaskFlowViewSchema,
  },
  "task_docs.put": {
    params: MutationMeta.extend({
      work_item_id: z.string(),
      kind: TaskDocKindSchema,
      content_markdown: z.string().min(1).max(400_000),
    }),
    result: TaskDocViewSchema,
  },
  "task_docs.get": {
    params: z.object({
      work_item_id: z.string(),
      kind: TaskDocKindSchema,
      version: z.number().int().positive().optional(),
    }),
    result: z.object({ doc: TaskDocViewSchema.nullable() }),
  },
  "task_docs.list": {
    params: z.object({ work_item_id: z.string() }),
    result: z.object({ docs: z.array(TaskDocViewSchema) }),
  },
  /** ADR-0021 §4: corre la verificación del proyecto y compara contra el baseline. */
  "verify.run": {
    params: MutationMeta.extend({ work_item_id: z.string() }),
    result: z.object({
      results: z.array(VerifyResultSchema),
      delta: VerifyDeltaSchema,
      baseline: z.boolean(),
    }),
  },
  "projects.profile_get": {
    params: z.object({ project_id: z.string().optional() }),
    result: ProjectProfileViewSchema,
  },
  "projects.profile_set": {
    params: MutationMeta.extend({
      project_id: z.string().optional(),
      profile: ProjectProfileSchema,
    }),
    result: ProjectProfileViewSchema,
  },
  /** ADR-0020 §5: los modelos y esfuerzos que el proveedor ofrece a esta cuenta. */
  "providers.models": {
    params: z.object({ provider: z.enum(["claude", "codex"]) }),
    result: z.object({
      models: z.array(ModelOptionSchema),
      /** `sdk`: los dio el proveedor; `profile`: sólo el del perfil, no se pudo preguntar. */
      source: z.enum(["sdk", "profile"]),
    }),
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
      /** Lo que el agente lee al negarse: «no quiso contestar», «sigue planeando: …». */
      reason: z.string().max(20_000).optional(),
      /**
       * ADR-0020 §2: el patrón corregido por el humano (`cd *`) para «sesión» o
       * «siempre». El daemon lo rechaza si no cubre la operación pedida.
       */
      pattern: z.string().max(2_000).optional(),
      /** ADR-0020 §7: respuestas a una pregunta del agente; sin ellas no se aprueba. */
      answers: QuestionAnswersSchema.optional(),
      annotations: QuestionAnnotationsSchema.optional(),
      /** Al aprobar un plan (`ExitPlanMode`), el modo con el que sigue el run. */
      then_mode: PermissionModeSchema.optional(),
      /**
       * ADR-0022 §2: al aprobar el diseño de una feature, si las subtareas se integran
       * solas cuando tienen QA PASS, verificación sin rojo nuevo y diff en su frontera.
       */
      auto_integrate: z.boolean().optional(),
      /**
       * ADR-0032 §2: un comando destructivo en producción se aprueba escribiendo el
       * nombre de la conexión, como ADR-0026.
       */
      confirm: z.string().max(200).optional(),
      /**
       * ADR-0035 §2: el plan del lote como lo dejó el humano en la tarjeta: nombres,
       * perfiles, diferidos. Sólo puede quitar o cambiar intents, no inventar otros.
       */
      batch: BatchPlanSchema.optional(),
      /** ADR-0025 §6: lo que el humano dejó listo para una petición `setup.request`. */
      setup_result: z
        .object({ connection_id: z.string().optional(), note: z.string().max(500).optional() })
        .optional(),
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
      /** ADR-0034 §6: las de todos los proyectos abiertos en el daemon; sólo humanos. */
      all_projects: z.boolean().optional(),
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
      type: z.enum(["postgres", "sqlite", "ssh", "terraform", "ansible"]),
      environment: z.enum(["dev", "staging", "prod"]),
      config: z.record(z.string(), z.unknown()),
      secret_ref: z.string().optional(),
      secret_ref_ro: z.string().optional(),
      server_guarantee: z.string().optional(),
      /** ADR-0025 §3: método de entrada. */
      auth_method: AuthMethodSchema.optional(),
      /**
       * La contraseña (o la frase de la llave con `file`), que el daemon guarda en el
       * vault. Sólo por la puerta humana; nunca va a un evento ni a un recibo.
       */
      secret_value: z.string().min(1).max(10_000).optional(),
      tags: z.array(z.string().max(40)).max(20).optional(),
      /** ADR-0025 §6: la petición del agente que esta alta resuelve. */
      setup_request_id: z.string().optional(),
    }),
    result: ConnectionViewSchema,
  },
  /** ADR-0025: cambia el método, el secreto, el entorno o las etiquetas de una conexión. */
  "connections.update": {
    params: MutationMeta.extend({
      connection_id: z.string(),
      environment: z.enum(["dev", "staging", "prod"]).optional(),
      auth_method: AuthMethodSchema.optional(),
      secret_value: z.string().min(1).max(10_000).optional(),
      /** Quita el secreto guardado (pasa a preguntar). */
      forget_secret: z.boolean().optional(),
      identity_file: z.string().optional(),
      tags: z.array(z.string().max(40)).max(20).optional(),
      server_guarantee: z.string().optional(),
      /**
       * ADR-0032 §2: en producción, los comandos de lectura corren sin preguntar. Queda a
       * nombre de quien lo enciende.
       */
      reads_auto: z.boolean().optional(),
    }),
    result: ConnectionViewSchema,
  },
  /** ADR-0025 §3: Keel genera una llave ed25519 en el vault y devuelve la pública. */
  "connections.generate_key": {
    params: MutationMeta.extend({
      connection_id: z.string(),
      command: z.string().max(500).optional(),
      from: z.string().max(200).optional(),
    }),
    result: z.object({
      connection: ConnectionViewSchema,
      public_key: z.string(),
      authorized_keys: z.string(),
    }),
  },
  /** ADR-0025 §9: copia al vault una llave que el humano eligió. Keel no recorre ~/.ssh. */
  "connections.import_key_file": {
    params: MutationMeta.extend({ connection_id: z.string(), path: z.string().min(1) }),
    result: ConnectionViewSchema,
  },
  /** ADR-0025 §3: los Host de ~/.ssh/config, con el entorno propuesto por prefijo. */
  "connections.import_preview": {
    params: z.object({}),
    result: z.object({ hosts: z.array(ImportedHostSchema) }),
  },
  "connections.import": {
    params: MutationMeta.extend({
      hosts: z
        .array(
          ImportedHostSchema.pick({
            alias: true,
            host: true,
            user: true,
            port: true,
            proxy_jump: true,
            identity_file: true,
          }).extend({ environment: z.enum(["dev", "staging", "prod"]) }),
        )
        .min(1)
        .max(200),
    }),
    result: z.object({ connections: z.array(ConnectionViewSchema) }),
  },
  /** ADR-0025 §4: las llaves que presenta el host; aceptar una es decisión humana. */
  "connections.host_keys": {
    params: z.object({ connection_id: z.string() }),
    result: z.object({
      keys: z.array(z.object({ line: z.string(), fingerprint: z.string(), type: z.string() })),
      accepted: z.object({ fingerprint: z.string(), type: z.string() }).nullable(),
    }),
  },
  "connections.host_key_accept": {
    params: MutationMeta.extend({ connection_id: z.string(), line: z.string().min(1) }),
    result: ConnectionViewSchema,
  },
  /**
   * ADR-0025 §5: lo que necesita `keel ssh <conexión>` para abrir la terminal del humano:
   * argumentos y entorno de `ssh` (el agente de Keel, askpass con su token), y el aviso.
   */
  /**
   * ADR-0031 §1: los playbooks de Ansible del proyecto, con sus hosts, tags y vault, y la
   * conexión SSH que parece de cada host. Con `path`, sólo ese archivo.
   */
  "ansible.discover": {
    params: z.object({ project_id: z.string().optional(), path: z.string().optional() }),
    result: z.object({
      root: z.string(),
      playbooks: z.array(
        z.object({
          dir: z.string(),
          playbook: z.string(),
          targets: z.array(z.string()),
          hosts: z.array(
            z.object({
              name: z.string(),
              address: z.string().nullable(),
              user: z.string().nullable(),
              port: z.number().nullable(),
              /** La conexión SSH con la misma dirección (o el mismo nombre). */
              suggested_connection: z.string().nullable(),
            }),
          ),
          tags: z.array(z.string()),
          vault_files: z.array(z.string()),
          inventories: z.array(z.string()),
        }),
      ),
    }),
  },
  /**
   * ADR-0033 §3: «Probar conexión» de una base, por el mismo camino que una consulta
   * (túnel incluido), en sólo lectura y con la credencial con que lee el agente.
   */
  /** Cancela un check o un despliegue de Ansible en curso, por su `run_key`. Sólo humano. */
  "resources.cancel": {
    params: MutationMeta.extend({ run_key: z.string() }),
    result: z.object({ cancelled: z.boolean() }),
  },
  "connections.test": {
    params: z.object({ connection_id: z.string() }),
    result: z.object({
      ok: z.boolean(),
      user: z.string().nullable(),
      database: z.string().nullable(),
      version: z.string().nullable(),
      read_only: z.boolean().nullable(),
      ro_credential: z.boolean(),
      tunnel_ms: z.number().nullable(),
      db_ms: z.number().nullable(),
      via: z.string().nullable(),
      error: z.string().nullable(),
    }),
  },
  "connections.ssh_session": {
    params: z.object({ connection: z.string() }),
    result: z.object({
      connection: ConnectionViewSchema,
      args: z.array(z.string()),
      env: z.record(z.string(), z.string()),
      banner: z.string().nullable(),
    }),
  },
  "vault.status": { params: z.object({}), result: VaultStatusSchema },
  /** Sin llavero: la frase abre el vault (y lo crea la primera vez). */
  "vault.unlock": {
    params: MutationMeta.extend({ passphrase: z.string().min(8).max(1_000) }),
    result: VaultStatusSchema,
  },
  /**
   * El programa `keel askpass` pide una contraseña o una frase con el token que Keel
   * le dio a ese `ssh`. `ask` = el valor no está guardado: pregúntale al humano.
   */
  "secrets.askpass": {
    params: z.object({ token: z.string().min(16), prompt: z.string().max(1_000) }),
    result: z.object({ value: z.string().nullable(), ask: z.boolean() }),
  },
  /** Lo que el humano escribió en su terminal (askpass), para recordarlo. */
  "secrets.remember": {
    params: MutationMeta.extend({
      token: z.string().min(16),
      value: z.string().min(1).max(10_000),
      scope: z.enum(["session", "vault"]),
    }),
    result: z.object({ ok: z.literal(true) }),
  },
  /** La respuesta del humano a una pregunta de secreto del broker (método `ask`). */
  "secrets.prompt_answer": {
    params: MutationMeta.extend({
      prompt_id: z.string(),
      value: z.string().max(10_000).optional(),
      cancel: z.boolean().optional(),
      remember: z.enum(["once", "session", "vault"]).default("once"),
    }),
    result: z.object({ ok: z.literal(true) }),
  },
  /** ADR-0025 §6: el agente pide lo que le falta; el humano lo configura. */
  "setup.request": {
    params: MutationMeta.extend(SetupRequestSchema.shape),
    result: z.object({
      approval_id: z.string(),
      state: z.enum(["approved", "denied", "expired"]),
      message: z.string(),
    }),
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
      /**
       * ADR-0026: para quitar la pregunta en producción, el nombre de la conexión
       * escrito por el humano.
       */
      risk_confirm: z.string().optional(),
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
      /** ADR-0031 §5: el resumen estructurado y corto (Terraform y Ansible). */
      details: z.unknown().optional(),
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
  /** Ajustes del usuario que valen para todo el daemon (migración 0011). */
  "settings.get": {
    params: z.object({}),
    result: SettingsViewSchema,
  },
  /**
   * ADR-0008 §2: usar Codex con la sesión de ChatGPT del usuario es una opción
   * explícita suya. Sólo un humano la cambia; queda guardada con su autor.
   */
  "settings.codex_subscription_set": {
    params: MutationMeta.extend({ enabled: z.boolean() }),
    result: SettingsViewSchema,
  },
  /** ADR-0020 §3 y §6: límite de espera de una aprobación y sugerencias de Claude. */
  "settings.update": {
    params: MutationMeta.extend({
      approvals_timeout_ms: z
        .number()
        .int()
        .min(10_000)
        .max(7 * 86_400_000)
        .nullable()
        .optional(),
      prompt_suggestions: z.boolean().optional(),
      /** model null vuelve al del perfil. */
      default_model: z
        .object({
          provider: z.enum(["claude", "codex"]),
          model: z.string().min(1).max(120).nullable(),
          effort: EffortSchema.nullable().optional(),
        })
        .optional(),
      /** ADR-0002 regla 5: subir (o bajar) el presupuesto y la concurrencia. */
      limits: z
        .object({
          /** null quita el tope (ADR-0002 regla 3: decisión explícita y visible). */
          run_budget_usd: z.number().min(0.1).max(1_000).nullable().optional(),
          daily_budget_usd: z.number().min(1).max(10_000).nullable().optional(),
          max_concurrent_runs: z.number().int().min(1).max(8).optional(),
        })
        .optional(),
    }),
    result: SettingsViewSchema,
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
          run_budget_micro_usd: z.number().int().nullable(),
          daily_budget_micro_usd: z.number().int().nullable(),
        })
        .optional(),
      spent_today_micro_usd: z.number().int().optional(),
      /** A qué proyecto y carpeta sirve este daemon: el cliente lo muestra para no confundir daemons. */
      project: z.object({ id: z.string(), root_path: z.string() }).optional(),
      /**
       * Los métodos que entiende este daemon. La GUI los compara con los suyos: si le
       * falta alguno, el daemon corre código anterior y hay que reiniciarlo.
       */
      methods: z.array(z.string()).optional(),
      /** Si este daemon se puede reiniciar desde un cliente (`daemon.restart`). */
      restartable: z.boolean().optional(),
    }),
  },
  /**
   * Para el daemon de forma ordenada para que el shell arranque uno nuevo con el código
   * actual. Sólo un humano, y nunca con runs vivos.
   */
  "daemon.restart": {
    params: MutationMeta,
    result: z.object({ restarting: z.literal(true) }),
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
  "tasks.flow",
  "stages.advance",
  "task_docs.put",
  "task_docs.get",
  "task_docs.list",
  "verify.run",
  "projects.profile_get",
  "setup.request",
  "sources.list",
  "sources.get",
  "intake.draft",
  "repo.anchor",
  "intake.ready_check",
  "batch.propose",
  "batch.report",
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
  "tasks.flow": "tasks:read",
  "stages.advance": "tasks:write",
  "task_docs.put": "tasks:write",
  "task_docs.get": "tasks:read",
  "task_docs.list": "tasks:read",
  "verify.run": "tasks:write",
  "projects.profile_get": "tasks:read",
  "setup.request": "resources:use",
  "sources.list": "tasks:read",
  "sources.get": "tasks:read",
  "intake.draft": "tasks:read",
  "repo.anchor": "tasks:read",
  "intake.ready_check": "tasks:read",
  "batch.propose": "tasks:write",
  "batch.report": "tasks:read",
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
