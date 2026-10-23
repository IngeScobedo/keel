/**
 * Plugins de Keel (ADR-0014): un manifiesto declarativo dice qué reconoce el
 * plugin, qué eventos semánticos emite (con su esquema), cómo se ven y qué
 * permisos pide. No hay permisos para secretos, la base interna ni el daemon.
 * Puro: sin E/S.
 */
import { z } from "zod"

export const PLUGIN_API_VERSION = 1

export const PluginPermissionSchema = z.enum(["events:emit", "artifacts:create", "evidence:attach"])

export const PluginVisualizerSchema = z.object({
  kind: z.string(),
  /** Primitivas del UI kit: no ejecutan código; la TUI las muestra como texto. */
  primitive: z.enum(["kv", "table", "code"]),
  fields: z.array(z.string()).optional(),
  rows_field: z.string().optional(),
  code_field: z.string().optional(),
})

export const PluginManifestSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  version: z.string().min(1),
  keel_api: z.literal(PLUGIN_API_VERSION),
  /** Proceso del intérprete, relativo a la carpeta del plugin. */
  entry: z.object({ command: z.string(), args: z.array(z.string()).default([]) }),
  recognizes: z.object({
    /** Patrones de nombre de tool: `mcp__stripe__*`. */
    tools: z.array(z.string()).default([]),
    event_kinds: z.array(z.string()).default([]),
  }),
  emits: z.array(
    z.object({
      kind: z.string().regex(/^[a-z0-9_]+\.[a-z0-9_]+\.[a-z0-9_]+$/),
      schema_version: z.number().int().positive(),
      /** JSON Schema del payload (el subconjunto de `validateJsonSchema`). */
      schema: z.record(z.string(), z.unknown()),
    }),
  ),
  visualizers: z.array(PluginVisualizerSchema).default([]),
  permissions: z.array(PluginPermissionSchema).default([]),
})
export type PluginManifest = z.infer<typeof PluginManifestSchema>

/** `mcp__stripe__*` → ¿casa con el nombre? Sólo `*` como comodín. */
export function matchesToolPattern(pattern: string, name: string): boolean {
  const re = new RegExp(
    `^${pattern
      .split("*")
      .map((p) => p.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
      .join(".*")}$`,
  )
  return re.test(name)
}

type Schema = {
  type?: string | string[]
  properties?: Record<string, Schema>
  required?: string[]
  items?: Schema
  enum?: unknown[]
  additionalProperties?: boolean
}

/**
 * Validador del subconjunto de JSON Schema que usan los manifiestos: `type`,
 * `properties`, `required`, `items`, `enum` y `additionalProperties: false`.
 * Devuelve el primer error, o null si valida.
 */
export function validateJsonSchema(schema: unknown, value: unknown, path = "$"): string | null {
  const s = (schema ?? {}) as Schema
  const typeOf = (v: unknown) =>
    v === null ? "null" : Array.isArray(v) ? "array" : Number.isInteger(v) ? "integer" : typeof v
  if (s.type) {
    const types = Array.isArray(s.type) ? s.type : [s.type]
    const t = typeOf(value)
    const ok = types.some((x) => x === t || (x === "number" && t === "integer"))
    if (!ok) return `${path}: se esperaba ${types.join("|")} y llegó ${t}`
  }
  if (s.enum && !s.enum.some((e) => JSON.stringify(e) === JSON.stringify(value)))
    return `${path}: valor fuera del enum`
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>
    for (const r of s.required ?? []) if (!(r in obj)) return `${path}.${r}: falta`
    for (const [k, sub] of Object.entries(s.properties ?? {}))
      if (k in obj) {
        const e = validateJsonSchema(sub, obj[k], `${path}.${k}`)
        if (e) return e
      }
    if (s.additionalProperties === false)
      for (const k of Object.keys(obj))
        if (!(k in (s.properties ?? {}))) return `${path}.${k}: propiedad no declarada`
  }
  if (Array.isArray(value) && s.items)
    for (let i = 0; i < value.length; i++) {
      const e = validateJsonSchema(s.items, value[i], `${path}[${i}]`)
      if (e) return e
    }
  return null
}
