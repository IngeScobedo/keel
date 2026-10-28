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
  "ssh.command.completed": {
    schema_version: 1,
    schema: z.object({
      server: z.string(),
      command: z.string(),
      exit_code: z.number().int().nullable(),
      output_ref: z.string().nullable(),
    }),
  },
  "iac.plan.created": {
    schema_version: 1,
    schema: z.object({
      server: z.string(),
      plan_sha256: z.string(),
      summary: z.string().nullable(),
      plan_ref: z.string().nullable(),
      /** ADR-0031: qué herramienta (sin él, Terraform) y su ejecución en vivo. */
      tool: z.enum(["terraform", "ansible"]).optional(),
      run_key: z.string().optional(),
      details: z.unknown().optional(),
    }),
  },
  "iac.apply.completed": {
    schema_version: 1,
    schema: z.object({
      server: z.string(),
      plan_sha256: z.string(),
      exit_code: z.number().int().nullable(),
      output_ref: z.string().nullable(),
      tool: z.enum(["terraform", "ansible"]).optional(),
      run_key: z.string().optional(),
      details: z.unknown().optional(),
    }),
  },
  /** Arranca un check o un despliegue: la tarjeta en vivo se abre con esto. */
  "iac.run.started": {
    schema_version: 1,
    schema: z.object({
      tool: z.enum(["terraform", "ansible"]),
      run_key: z.string(),
      connection: z.string(),
      environment: z.string(),
      mode: z.enum(["check", "plan", "apply"]),
      playbook: z.string().optional(),
      tags: z.array(z.string()).optional(),
      hosts: z
        .array(z.object({ name: z.string(), connection: z.string(), host: z.string() }))
        .optional(),
      commit: z.string().nullable().optional(),
    }),
  },
  "ansible.task.started": {
    schema_version: 1,
    schema: z.object({
      run_key: z.string(),
      index: z.number().int(),
      task: z.string(),
      action: z.string(),
    }),
  },
  "ansible.host.result": {
    schema_version: 1,
    schema: z.object({
      run_key: z.string(),
      host: z.string(),
      task: z.string(),
      status: z.enum(["ok", "changed", "failed", "ignored", "skipped", "unreachable"]),
      changed: z.boolean(),
      msg: z.string().nullable(),
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
