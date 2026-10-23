/**
 * Proyección semántica (ADR-0011): intérpretes versionados leen los eventos de
 * origen y producen `database.query.completed`, `git.commit.created`… con su
 * cobertura. Es una proyección: `rebuild` la borra y la rehace desde `events`
 * con el mismo resultado, porque los intérpretes son funciones de los eventos
 * y los artefactos que producen están direccionados por contenido.
 */

import type { Database } from "bun:sqlite"
import { createHash } from "node:crypto"
import { type Coverage, SEMANTIC_SCHEMAS, validateSemantic } from "@keel/core"
import { type ArtifactStore, parseArtifactRef } from "./artifacts.js"
import type { EventRow, Repo } from "./store/repo.js"

export type SourceEvent = {
  id: string
  event_seq: number
  project_id: string
  run_id: string | null
  source: string
  kind: string
  occurred_at: string | null
  payload: Record<string, unknown>
}

export type SemanticDraft = {
  /** Único dentro del intérprete: reproyectar el mismo origen no duplica. */
  key: string
  kind: string
  coverage: Coverage
  payload: Record<string, unknown>
  source_event_ids: string[]
  tool_use_id?: string | null
  /** Contenido que el proyector guarda como artefacto; `$artifact:<slot>` en el payload lo referencia. */
  artifacts?: { slot: string; content: string; media_type: string }[]
}

export interface Interpreter {
  readonly name: string
  readonly version: number
  feed(e: SourceEvent): SemanticDraft[]
}

type Json = Record<string, unknown>
const str = (v: unknown): string | null => (typeof v === "string" ? v : null)

// --- 1. identidad: lo que ejecuta Keel nace semántico (ADR-0011 §2) ---------------------
export class KeelIdentity implements Interpreter {
  readonly name = "keel"
  readonly version = 1
  feed(e: SourceEvent): SemanticDraft[] {
    if (!(e.kind in SEMANTIC_SCHEMAS)) return []
    return [
      {
        key: e.id,
        kind: e.kind,
        coverage: "instrumented",
        payload: e.payload,
        source_event_ids: [e.id],
        tool_use_id: str(e.payload.tool_use_id),
      },
    ]
  }
}

// --- 2. consultas SQL por MCP (cobertura `observed`) ---------------------------------------
const SQL_SERVER = /postgres|pg|sql|mysql|sqlite|database|db/i
const SQL_TOOL = /query|sql|execute|select/i

/** `mcp__servidor__tool` → [servidor, tool]. */
function mcpName(name: string): [string, string] | null {
  const m = /^mcp__(.+?)__(.+)$/.exec(name)
  return m ? [m[1] as string, m[2] as string] : null
}

/** Texto del resultado de una tool MCP: `content: [{type:"text", text}]` o un string. */
function resultText(result: unknown): string | null {
  if (typeof result === "string") return result
  const content = Array.isArray(result) ? result : (result as Json | null)?.content
  if (!Array.isArray(content)) return null
  const texts = content
    .filter((c): c is Json => typeof c === "object" && c !== null && (c as Json).type === "text")
    .map((c) => String(c.text))
  return texts.length ? texts.join("\n") : null
}

/** Filas como tabla de Keel (ADR-0012 §4), si el texto es un JSON de filas. */
export function tableFromText(text: string | null): {
  columns: { name: string }[]
  rows: unknown[][]
  row_count_total: number
  truncated: boolean
} | null {
  if (!text) return null
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    return null
  }
  const rows = Array.isArray(data)
    ? data
    : Array.isArray((data as Json)?.rows)
      ? ((data as Json).rows as unknown[])
      : null
  if (!rows) return null
  const objects = rows.filter(
    (r): r is Json => typeof r === "object" && r !== null && !Array.isArray(r),
  )
  if (objects.length !== rows.length) return null
  const names: string[] = []
  for (const r of objects) for (const k of Object.keys(r)) if (!names.includes(k)) names.push(k)
  return {
    columns: names.map((name) => ({ name })),
    rows: objects.map((r) => names.map((n) => (r[n] === undefined ? null : r[n]))),
    row_count_total: objects.length,
    truncated: false,
  }
}

export class McpSql implements Interpreter {
  readonly name = "mcp-sql"
  readonly version = 1
  feed(e: SourceEvent): SemanticDraft[] {
    let server: string | null = null
    let tool: string | null = null
    let input: Json = {}
    let output: unknown = null
    let failed = false
    let toolUseId: string | null = null
    if (e.kind === "hook.PostToolUse" || e.kind === "hook.PostToolUseFailure") {
      const parts = mcpName(String(e.payload.tool_name ?? ""))
      if (!parts) return []
      ;[server, tool] = parts
      input = (e.payload.tool_input as Json) ?? {}
      output = e.payload.tool_response
      failed = e.kind === "hook.PostToolUseFailure"
      toolUseId = str(e.payload.tool_use_id)
    } else if (e.kind === "codex.app.item/completed") {
      const item = (e.payload.item as Json) ?? {}
      if (item.type !== "mcpToolCall") return []
      server = str(item.server)
      tool = str(item.tool)
      input = (item.arguments as Json) ?? {}
      output = item.result
      failed = item.status === "failed"
      toolUseId = str(item.id)
    } else return []
    if (!(SQL_SERVER.test(server ?? "") || SQL_TOOL.test(tool ?? ""))) return []
    const query = str(input.sql) ?? str(input.query) ?? str(input.statement)
    if (query === null) return []
    const text = resultText(output)
    const table = failed ? null : tableFromText(text)
    return [
      {
        key: `${e.id}`,
        kind: "database.query.completed",
        coverage: "observed",
        payload: {
          server,
          tool,
          query,
          row_count: table ? table.row_count_total : null,
          columns: table ? table.columns.map((c) => c.name) : null,
          result_ref: table ? "$artifact:result" : null,
          error: failed ? (text ?? "falló") : null,
        },
        source_event_ids: [e.id],
        tool_use_id: toolUseId,
        ...(table
          ? {
              artifacts: [
                {
                  slot: "result",
                  content: JSON.stringify(table),
                  media_type: "application/vnd.keel.table+json",
                },
              ],
            }
          : {}),
      },
    ]
  }
}

// --- 3. lo que se deduce de un comando de shell (cobertura `inferred`) ---------------------
const PSQL = /(?:^|[\s;&|(])psql\b/
const GIT_COMMIT = /(?:^|[\s;&|(])git(?:\s+-C\s+\S+)?\s+commit\b/
const GIT_PUSH = /(?:^|[\s;&|(])git(?:\s+-C\s+\S+)?\s+push\b/

function shellOutput(response: unknown): string {
  if (typeof response === "string") return response
  const r = (response ?? {}) as Json
  return [str(r.stdout), str(r.stderr), str(r.aggregatedOutput)].filter(Boolean).join("\n")
}

export class ShellInferred implements Interpreter {
  readonly name = "shell-inferred"
  readonly version = 1
  feed(e: SourceEvent): SemanticDraft[] {
    let command: string | null = null
    let output = ""
    let toolUseId: string | null = null
    if (e.kind === "hook.PostToolUse" && e.payload.tool_name === "Bash") {
      command = str((e.payload.tool_input as Json | undefined)?.command)
      output = shellOutput(e.payload.tool_response)
      toolUseId = str(e.payload.tool_use_id)
    } else if (e.kind === "codex.app.item/completed") {
      const item = (e.payload.item as Json) ?? {}
      if (item.type !== "commandExecution") return []
      command = str(item.command)
      output = str(item.aggregatedOutput) ?? ""
      toolUseId = str(item.id)
    }
    if (!command) return []
    const drafts: SemanticDraft[] = []
    const base = { source_event_ids: [e.id], tool_use_id: toolUseId, coverage: "inferred" as const }
    if (PSQL.test(command)) {
      const q = /(?:-c|--command)\s+(?:"([^"]*)"|'([^']*)')/.exec(command)
      drafts.push({
        ...base,
        key: `${e.id}:psql`,
        kind: "database.query.completed",
        // Lo que no se ve se dice: un psql por shell no tiene filas.
        payload: {
          server: null,
          tool: "psql",
          query: q ? (q[1] ?? q[2] ?? null) : null,
          row_count: null,
          columns: null,
          result_ref: null,
          error: null,
        },
      })
    }
    if (GIT_COMMIT.test(command)) {
      // `[rama abc1234] mensaje` en la salida de git commit.
      const m = /^\[([^\s\]]+)(?:\s+\([^)]*\))?\s+([0-9a-f]{7,40})\]\s*(.*)$/m.exec(output)
      drafts.push({
        ...base,
        key: `${e.id}:commit`,
        kind: "git.commit.created",
        payload: {
          sha: m ? (m[2] as string) : null,
          message: m ? (m[3] as string) : null,
          files: null,
          branch: m ? (m[1] as string) : null,
          worktree: null,
        },
      })
    }
    if (GIT_PUSH.test(command)) {
      const m = /([0-9a-f]{7,40})\.\.([0-9a-f]{7,40})\s+(\S+)\s+->\s+(\S+)/.exec(output)
      const remote = /git(?:\s+-C\s+\S+)?\s+push\s+(?:-\S+\s+)*([^\s-][^\s]*)/.exec(command)
      drafts.push({
        ...base,
        key: `${e.id}:push`,
        kind: "git.push.completed",
        payload: {
          remote: remote ? (remote[1] as string) : null,
          ref: m ? (m[4] as string) : null,
          old_sha: m ? (m[1] as string) : null,
          new_sha: m ? (m[2] as string) : null,
        },
      })
    }
    return drafts
  }
}

export const defaultInterpreters = (): Interpreter[] => [
  new KeelIdentity(),
  new McpSql(),
  new ShellInferred(),
]

/** Aplica los intérpretes a los eventos de origen y guarda lo que producen. */
export class SemanticProjector {
  private interpreters: Interpreter[]
  private readonly makeInterpreters: () => Interpreter[]
  private readonly db: Database
  private readonly repo: Repo
  private readonly artifacts: ArtifactStore | null
  constructor(deps: {
    db: Database
    repo: Repo
    artifacts: ArtifactStore | null
    interpreters?: () => Interpreter[]
  }) {
    this.db = deps.db
    this.repo = deps.repo
    this.artifacts = deps.artifacts
    this.makeInterpreters = deps.interpreters ?? defaultInterpreters
    this.interpreters = this.makeInterpreters()
  }

  /** Un evento recién guardado. Un intérprete que falla no frena a los demás. */
  onEvent(row: EventRow): number {
    const e = this.source(row)
    let n = 0
    for (const it of this.interpreters) {
      let drafts: SemanticDraft[] = []
      try {
        drafts = it.feed(e)
      } catch {
        continue
      }
      for (const d of drafts) if (this.store(it, e, d)) n++
    }
    return n
  }

  /** Borra la proyección (de un proyecto o toda) y la rehace desde `events`. */
  rebuild(projectId: string | null = null): number {
    this.db
      .query(
        projectId
          ? "DELETE FROM semantic_events WHERE project_id = ?"
          : "DELETE FROM semantic_events",
      )
      .run(...(projectId ? [projectId] : []))
    this.interpreters = this.makeInterpreters()
    let n = 0
    let after = 0
    for (;;) {
      const page = this.repo.eventsAfter(after, projectId, 1000)
      for (const row of page) n += this.onEvent(row)
      if (page.length < 1000) break
      after = (page.at(-1) as EventRow).event_seq
    }
    return n
  }

  /** El cuerpo íntegro de un evento: si quedó como artefacto (ADR-0012), se lee de ahí. */
  private source(row: EventRow): SourceEvent {
    let payload = JSON.parse(row.payload_json) as Json
    if (payload.keel_preview === 1 && typeof payload.body_ref === "string" && this.artifacts) {
      const sha = parseArtifactRef(payload.body_ref)
      if (sha)
        try {
          payload = JSON.parse(this.artifacts.readAll(sha).toString("utf8")) as Json
        } catch {
          // Sin el cuerpo, el intérprete ve el preview y lo dirá su resultado.
        }
    }
    return {
      id: row.id,
      event_seq: row.event_seq,
      project_id: row.project_id,
      run_id: row.run_id,
      source: row.source,
      kind: row.kind,
      occurred_at: row.occurred_at,
      payload,
    }
  }

  private store(it: Interpreter, e: SourceEvent, d: SemanticDraft): boolean {
    const refs: string[] = []
    let payload: unknown = d.payload
    if (d.artifacts?.length && this.artifacts) {
      const bySlot = new Map<string, string>()
      for (const a of d.artifacts) {
        const { ref } = this.artifacts.put(a.content, a.media_type)
        bySlot.set(a.slot, ref)
        refs.push(ref)
      }
      payload = JSON.parse(
        JSON.stringify(payload, (_k, v) =>
          typeof v === "string" && v.startsWith("$artifact:")
            ? (bySlot.get(v.slice(10)) ?? null)
            : v,
        ),
      )
    } else if (d.artifacts?.length)
      payload = JSON.parse(
        JSON.stringify(payload, (_k, v) =>
          typeof v === "string" && v.startsWith("$artifact:") ? null : v,
        ),
      )
    const valid = validateSemantic(d.kind, payload)
    const run = e.run_id ? this.repo.getRun(e.run_id) : null
    const interpreter = `${it.name}@${it.version}`
    const r = this.db
      .query(
        `INSERT OR IGNORE INTO semantic_events(id, project_id, work_item_id, run_id, tool_use_id, kind,
           schema_version, coverage, sensitivity, interpreter, dedupe_key, source_event_ids_json,
           artifact_refs_json, payload_json, occurred_at)
         VALUES (?,?,?,?,?,?,?,?,'internal',?,?,?,?,?,?)`,
      )
      .run(
        // Id determinista: reconstruir da las mismas filas (ADR-0011 §1).
        `sem_${createHash("sha256").update(`${interpreter}:${d.key}`).digest("hex").slice(0, 24)}`,
        e.project_id,
        run?.work_item_id ?? null,
        e.run_id,
        d.tool_use_id ?? null,
        valid.kind,
        valid.schema_version,
        d.coverage,
        interpreter,
        `${interpreter}:${d.key}`,
        JSON.stringify(d.source_event_ids),
        JSON.stringify(refs),
        JSON.stringify(valid.payload),
        e.occurred_at,
      )
    return r.changes > 0
  }
}
