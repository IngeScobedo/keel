/**
 * Migraciones numeradas con checksum y tabla de aplicación (ADR-0004 §2).
 *
 * - `NNNN-nombre.sql` se aplica en orden lexicográfico dentro de una transacción.
 * - `NNNN-nombre.vec.sql` es el bloque vectorial: sólo se aplica si `sqlite-vec`
 *   cargó; si no, queda registrado como `skipped` y el Research Hub trabaja en
 *   modo léxico (SDD 02 §5).
 * - Una migración ya aplicada cuyo checksum cambió es un error: el historial no
 *   se reescribe, se añade otra migración.
 */

import type { Database } from "bun:sqlite"
import { createHash } from "node:crypto"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

export type Migration = { id: string; kind: "relational" | "vector"; sql: string; checksum: string }
export type MigrationStatus = {
  id: string
  kind: Migration["kind"]
  status: "applied" | "skipped" | "already"
}

export function loadMigrations(dir: string): Migration[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((f) => {
      const sql = readFileSync(join(dir, f), "utf8")
      return {
        id: f.replace(/\.sql$/, ""),
        kind: f.endsWith(".vec.sql") ? "vector" : "relational",
        sql,
        checksum: createHash("sha256").update(sql).digest("hex"),
      }
    })
}

export function ensureSchemaTable(db: Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    id TEXT PRIMARY KEY NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('relational','vector')),
    checksum TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('applied','skipped')),
    applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`)
}

export class MigrationChecksumError extends Error {
  readonly id: string
  readonly recorded: string
  readonly current: string
  constructor(id: string, recorded: string, current: string) {
    super(
      `la migración ${id} ya se aplicó con otro contenido (registrado ${recorded.slice(0, 12)}, actual ${current.slice(0, 12)}); el historial no se edita, se añade una migración nueva`,
    )
    this.id = id
    this.recorded = recorded
    this.current = current
  }
}

/**
 * Los PRAGMA de conexión del DDL (journal_mode, synchronous, foreign_keys,
 * busy_timeout) los fija el store al abrir; dentro de una transacción
 * `journal_mode = WAL` falla. Se quitan del SQL ejecutado; el checksum sigue
 * siendo el del fichero íntegro.
 */
export function stripConnectionPragmas(sql: string): string {
  return sql
    .split("\n")
    .filter(
      (line) => !/^\s*PRAGMA\s+(journal_mode|synchronous|foreign_keys|busy_timeout)\b/i.test(line),
    )
    .join("\n")
}

export function migrate(
  db: Database,
  migrations: Migration[],
  opts: { vectorAvailable: boolean },
): MigrationStatus[] {
  ensureSchemaTable(db)
  const out: MigrationStatus[] = []
  const select = db.prepare<{ checksum: string; status: string }, [string]>(
    "SELECT checksum, status FROM schema_migrations WHERE id = ?",
  )
  const insert = db.prepare(
    "INSERT INTO schema_migrations(id, kind, checksum, status) VALUES (?, ?, ?, ?)",
  )
  for (const m of migrations) {
    const row = select.get(m.id)
    if (row) {
      if (row.checksum !== m.checksum)
        throw new MigrationChecksumError(m.id, row.checksum, m.checksum)
      if (row.status === "skipped" && m.kind === "vector" && opts.vectorAvailable) {
        db.transaction(() => {
          db.exec(stripConnectionPragmas(m.sql))
          db.prepare(
            "UPDATE schema_migrations SET status='applied', applied_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?",
          ).run(m.id)
        })()
        out.push({ id: m.id, kind: m.kind, status: "applied" })
        continue
      }
      out.push({ id: m.id, kind: m.kind, status: "already" })
      continue
    }
    if (m.kind === "vector" && !opts.vectorAvailable) {
      insert.run(m.id, m.kind, m.checksum, "skipped")
      out.push({ id: m.id, kind: m.kind, status: "skipped" })
      continue
    }
    db.transaction(() => {
      db.exec(stripConnectionPragmas(m.sql))
      insert.run(m.id, m.kind, m.checksum, "applied")
    })()
    out.push({ id: m.id, kind: m.kind, status: "applied" })
  }
  return out
}
