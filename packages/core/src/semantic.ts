/**
 * Eventos semánticos (ADR-0011): `<dominio>.<objeto>.<verbo en participio>`,
 * cada uno con su esquema y su versión. Son una proyección de los eventos de
 * origen; un payload que no valida se guarda como evento genérico, nunca se
 * descarta. Puro: sin E/S.
 */
import { z } from "zod"

export const CoverageSchema = z.enum(["instrumented", "observed", "inferred"])
export type Coverage = z.infer<typeof CoverageSchema>

const sha = z.string().nullable()

export const SEMANTIC_SCHEMAS = {
  "database.query.completed": {
    schema_version: 1,
    schema: z.object({
      /** Servidor MCP o conexión; null si sólo se infirió del shell. */
      server: z.string().nullable(),
      tool: z.string().nullable(),
      query: z.string().nullable(),
      /** null = no se vio el resultado (p. ej., `psql` dentro de `Bash`). */
      row_count: z.number().int().nullable(),
      columns: z.array(z.string()).nullable(),
      /** Resultado como `application/vnd.keel.table+json` (ADR-0012 §4). */
      result_ref: z.string().nullable(),
      error: z.string().nullable(),
    }),
  },
  "git.commit.created": {
    schema_version: 1,
    schema: z.object({
      sha,
      message: z.string().nullable(),
      files: z.array(z.string()).nullable(),
      branch: z.string().nullable(),
      worktree: z.string().nullable(),
    }),
  },
  "git.push.completed": {
    schema_version: 1,
    schema: z.object({
      remote: z.string().nullable(),
      ref: z.string().nullable(),
      old_sha: sha,
      new_sha: sha,
    }),
  },
  "git.plan.proposed": {
    schema_version: 1,
    schema: z.object({
      plan_id: z.string(),
      plan_hash: z.string(),
      operations: z.array(z.string()),
    }),
  },
  "git.plan.approved": {
    schema_version: 1,
    schema: z.object({ plan_id: z.string(), plan_hash: z.string() }),
  },
  "git.plan.expired": {
    schema_version: 1,
    schema: z.object({ plan_id: z.string(), reason: z.string() }),
  },
  "git.pull_request.created": {
    schema_version: 1,
    schema: z.object({ url: z.string().nullable(), number: z.number().int().nullable() }),
  },
} as const

export type SemanticKind = keyof typeof SEMANTIC_SCHEMAS
/** El tipo genérico para lo que no validó contra su esquema. */
export const GENERIC_SEMANTIC_KIND = "generic.unvalidated"

/**
 * Valida un payload contra el esquema de su `kind`. Si no valida (o el `kind`
 * no existe), devuelve el evento genérico con el motivo: nunca se descarta.
 */
export function validateSemantic(
  kind: string,
  payload: unknown,
): { kind: string; schema_version: number; payload: unknown } {
  const entry = (SEMANTIC_SCHEMAS as Record<string, { schema_version: number; schema: z.ZodType }>)[
    kind
  ]
  if (!entry)
    return {
      kind: GENERIC_SEMANTIC_KIND,
      schema_version: 1,
      payload: { intended_kind: kind, payload, error: "kind sin esquema" },
    }
  const parsed = entry.schema.safeParse(payload)
  if (parsed.success) return { kind, schema_version: entry.schema_version, payload: parsed.data }
  return {
    kind: GENERIC_SEMANTIC_KIND,
    schema_version: 1,
    payload: { intended_kind: kind, payload, error: parsed.error.message },
  }
}

export const SemanticEventViewSchema = z.object({
  seq: z.number().int(),
  id: z.string(),
  kind: z.string(),
  schema_version: z.number().int(),
  coverage: CoverageSchema,
  sensitivity: z.enum(["internal", "restricted"]),
  interpreter: z.string(),
  run_id: z.string().nullable(),
  work_item_id: z.string().nullable(),
  tool_use_id: z.string().nullable(),
  source_event_ids: z.array(z.string()),
  artifact_refs: z.array(z.string()),
  payload: z.unknown(),
  occurred_at: z.string().nullable(),
})
