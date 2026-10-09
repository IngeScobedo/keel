/**
 * Apertura del store (ADR-0004): un archivo SQLite en WAL, `synchronous=FULL`,
 * `foreign_keys=ON`, `busy_timeout`, con `sqlite-vec` si está disponible. El
 * daemon es el único escritor; los clientes nunca abren este archivo (ADR-0005).
 */

import { Database } from "bun:sqlite"
import { join } from "node:path"
import { loadMigrations, type MigrationStatus, migrate } from "./migrate.js"

export const MIGRATIONS_DIR = join(import.meta.dir, "..", "..", "migrations")

export type Store = {
  db: Database
  path: string
  vector: { available: boolean; version: string | null; reason: string | null }
  migrations: MigrationStatus[]
}

export function openStore(
  path: string,
  opts: { migrationsDir?: string; loadVector?: boolean } = {},
): Store {
  const db = new Database(path, { create: true, strict: true })
  // Los PRAGMA de conexión van aquí y no sólo en el DDL: journal_mode persiste en el
  // archivo, pero foreign_keys, busy_timeout y synchronous son por conexión.
  db.exec("PRAGMA journal_mode = WAL")
  db.exec("PRAGMA synchronous = FULL")
  db.exec("PRAGMA foreign_keys = ON")
  db.exec("PRAGMA busy_timeout = 5000")
  const vector = tryLoadVector(db, opts.loadVector ?? true)
  const migrations = migrate(db, loadMigrations(opts.migrationsDir ?? MIGRATIONS_DIR), {
    vectorAvailable: vector.available,
  })
  return { db, path, vector, migrations }
}

function tryLoadVector(db: Database, enabled: boolean): Store["vector"] {
  if (!enabled) return { available: false, version: null, reason: "desactivado" }
  try {
    // Import diferido: la ausencia del binario para la plataforma no debe impedir abrir el store.
    const { getLoadablePath } = require("sqlite-vec") as { getLoadablePath: () => string }
    db.loadExtension(getLoadablePath())
    const row = db.query<{ v: string }, []>("SELECT vec_version() AS v").get()
    return { available: true, version: row?.v ?? null, reason: null }
  } catch (e) {
    return { available: false, version: null, reason: e instanceof Error ? e.message : String(e) }
  }
}
