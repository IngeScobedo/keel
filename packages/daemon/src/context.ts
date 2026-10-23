/**
 * Contexto para agentes (ADR-0017): se pide, no se empuja. Búsqueda léxica
 * (FTS5) sobre lo del proyecto, filtrada por proyecto antes de rankear, con
 * fragmentos y referencias en vez de documentos enteros; y el contexto del
 * proyecto (`always_read` y la lista de ADRs).
 */
import type { Database } from "bun:sqlite"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { isAbsolute, join, relative, resolve } from "node:path"

/** Texto libre → consulta FTS5 segura: cada palabra entre comillas, con prefijo. */
export function ftsQuery(text: string): string | null {
  const words = text.match(/[\p{L}\p{N}_]+/gu) ?? []
  return words.length ? words.map((w) => `"${w}"*`).join(" ") : null
}

const SCOPE_KIND = { tasks: "task", notes: "note", evidence: "evidence" } as const
type Scope = "tasks" | "notes" | "evidence" | "research"

export function searchContext(
  db: Database,
  projectId: string,
  p: { query: string; scopes?: Scope[] | undefined; limit?: number | undefined },
): {
  mode: "lexical"
  results: { ref: string; kind: string; title: string; snippet: string; rank: number }[]
} {
  const q = ftsQuery(p.query)
  const limit = p.limit ?? 10
  if (!q) return { mode: "lexical", results: [] }
  const scopes: Scope[] = p.scopes?.length ? p.scopes : ["tasks", "notes", "evidence", "research"]
  const kinds = scopes
    .filter((s): s is keyof typeof SCOPE_KIND => s in SCOPE_KIND)
    .map((s) => SCOPE_KIND[s])
  type Hit = { ref: string; kind: string; title: string; snippet: string; rank: number }
  const hits: Hit[] = []
  if (kinds.length)
    hits.push(
      ...db
        .query<Hit, (string | number)[]>(
          `SELECT ref, kind, title, snippet(context_fts, 4, '«', '»', '…', 16) AS snippet,
                  bm25(context_fts) AS rank
             FROM context_fts
            WHERE context_fts MATCH ? AND project_id = ? AND kind IN (${kinds.map(() => "?").join(",")})
            ORDER BY rank LIMIT ?`,
        )
        .all(q, projectId, ...kinds, limit),
    )
  if (scopes.includes("research"))
    hits.push(
      ...db
        .query<Hit, (string | number)[]>(
          `SELECT 'keel://research/' || research_id AS ref, 'research' AS kind, title,
                  snippet(research_fts, 3, '«', '»', '…', 16) AS snippet, bm25(research_fts) AS rank
             FROM research_fts WHERE research_fts MATCH ? AND project_id = ?
            ORDER BY rank LIMIT ?`,
        )
        .all(q, projectId, limit),
    )
  // bm25: menor es mejor. Sin embedder evaluado, el modo es léxico y se dice (ADR-0017 §2).
  return { mode: "lexical", results: hits.sort((a, b) => a.rank - b.rank).slice(0, limit) }
}

const DOC_MAX = 50_000

/** `.keel/project.toml` → `[context] always_read = [...]`, más la lista de ADRs del repo. */
export function projectContext(root: string): {
  always_read: { path: string; text: string; truncated: boolean }[]
  adrs: { path: string; title: string }[]
} {
  const always: string[] = []
  const toml = join(root, ".keel", "project.toml")
  if (existsSync(toml))
    try {
      const cfg = Bun.TOML.parse(readFileSync(toml, "utf8")) as {
        context?: { always_read?: unknown }
      }
      const list = cfg.context?.always_read
      if (Array.isArray(list)) for (const x of list) if (typeof x === "string") always.push(x)
    } catch {
      // Un toml roto no da contexto, pero no rompe nada.
    }
  const always_read = always.flatMap((path) => {
    const full = resolve(root, path)
    const rel = relative(root, full)
    if (rel.startsWith("..") || isAbsolute(rel) || !existsSync(full)) return []
    const text = readFileSync(full, "utf8")
    return [{ path: rel, text: text.slice(0, DOC_MAX), truncated: text.length > DOC_MAX }]
  })
  const adrDir = join(root, "docs", "adr")
  const adrs = existsSync(adrDir)
    ? readdirSync(adrDir)
        .filter((f) => /^\d{4}-.*\.md$/.test(f))
        .sort()
        .map((f) => {
          const first = readFileSync(join(adrDir, f), "utf8")
            .split("\n")
            .find((l) => l.startsWith("# "))
          return { path: `docs/adr/${f}`, title: first ? first.slice(2).trim() : f }
        })
    : []
  return { always_read, adrs }
}
