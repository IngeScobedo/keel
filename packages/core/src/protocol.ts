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
export const CostKindSchema = z.enum(["observed", "estimated", "unknown"])
export type CostKind = z.infer<typeof CostKindSchema>

/** Toda entidad proyectada que viaja por el protocolo lleva su visual ya resuelto (ADR-0006 §3). */
const projected = { visual_state: VisualStateSchema, revision: z.number().int().nonnegative() }

export const WorkItemViewSchema = z.object({
  id: z.string(),
  project_id: z.string(),
  display_id: z.string(),
  title: z.string(),
  lifecycle: LifecycleSchema,
  board_status: z.string(),
  ...projected,
})
export const RunViewSchema = z.object({
  id: z.string(),
  work_item_id: z.string(),
  purpose: RunPurposeSchema,
  status: RunStatusSchema,
  end_reason: z.string().nullable(),
  cost_kind: CostKindSchema,
  total_cost_micro_usd: z.number().int().nullable(),
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
      decision: z.enum(["approve_once", "approve_session", "amend", "deny"]),
      amended_operation: z.unknown().optional(),
      reason: z.string().optional(),
    }),
    result: z.object({
      approval_id: z.string(),
      state: z.enum(["approved", "denied", "expired", "consumed"]),
    }),
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
    }),
  },
} as const
export type MethodName = keyof typeof Methods
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
