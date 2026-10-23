/**
 * Backup y restore del store (SDD 03 §7, ADR-0004, DoD de la Fase 0).
 *
 * - Backup con `VACUUM INTO`: lee un snapshot consistente con WAL aunque el
 *   daemon siga escribiendo; nunca se copia el archivo principal a mano.
 * - Cada backup lleva un manifest con tamaño, sha256 y las migraciones
 *   aplicadas. Restore verifica el hash antes de tocar nada.
 * - Restore nunca pisa una base existente: escribe en una ruta nueva, la abre
 *   (aplicando migraciones más nuevas si las hay) y pasa `integrity_check`,
 *   `foreign_key_check` y la verificación de FTS. Si algo falla, borra lo que
 *   escribió y lanza.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { basename, dirname, join } from "node:path"
import { openStore, type Store } from "./db.js"

export type BackupManifest = {
  version: 1
  created_at: string
  /** Ruta de la base respaldada, informativa. */
  source: string
  /** Nombre del archivo de backup, junto al manifest. */
  file: string
  bytes: number
  sha256: string
  sqlite_version: string
  migrations: { id: string; status: string; checksum: string }[]
}

export type RestoreReport = {
  path: string
  integrity: "ok"
  foreign_key_violations: number
  fts: "ok"
  migrations_applied: string[]
}

export class BackupError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "BackupError"
  }
}

/** Respalda `store` en `destDir`. Devuelve la ruta del manifest. */
export function backupStore(
  store: Store,
  destDir: string,
): { manifestPath: string; manifest: BackupManifest } {
  mkdirSync(destDir, { recursive: true, mode: 0o700 })
  const stamp = new Date().toISOString().replace(/[-:.]/g, "")
  const file = `keel-${stamp}.sqlite`
  const path = join(destDir, file)
  if (existsSync(path)) throw new BackupError(`ya existe ${path}`)
  store.db.exec(`VACUUM INTO '${path.replaceAll("'", "''")}'`)
  const bytes = readFileSync(path)
  const manifest: BackupManifest = {
    version: 1,
    created_at: new Date().toISOString(),
    source: store.path,
    file,
    bytes: bytes.length,
    sha256: sha256(bytes),
    sqlite_version:
      store.db.query<{ v: string }, []>("SELECT sqlite_version() AS v").get()?.v ?? "unknown",
    migrations: store.db
      .query<{ id: string; status: string; checksum: string }, []>(
        "SELECT id, status, checksum FROM schema_migrations ORDER BY id",
      )
      .all(),
  }
  const manifestPath = `${path}.manifest.json`
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 })
  return { manifestPath, manifest }
}

/** Restaura el backup del manifest en `targetPath`, que no debe existir. */
export function restoreStore(
  manifestPath: string,
  targetPath: string,
  opts: { migrationsDir?: string; loadVector?: boolean } = {},
): RestoreReport {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as BackupManifest
  if (manifest.version !== 1)
    throw new BackupError(`manifest versión ${manifest.version} no soportada`)
  const bytes = readFileSync(join(dirname(manifestPath), basename(manifest.file)))
  if (bytes.length !== manifest.bytes || sha256(bytes) !== manifest.sha256)
    throw new BackupError("el backup no coincide con su manifest (tamaño o sha256)")
  for (const p of [targetPath, `${targetPath}-wal`, `${targetPath}-shm`])
    if (existsSync(p)) throw new BackupError(`restore no pisa una base existente: ${p}`)
  mkdirSync(dirname(targetPath), { recursive: true, mode: 0o700 })
  writeFileSync(targetPath, bytes, { mode: 0o600 })
  let store: Store | null = null
  try {
    store = openStore(targetPath, opts)
    const db = store.db
    const integrity = db.query<{ integrity_check: string }, []>("PRAGMA integrity_check").all()
    if (integrity.length !== 1 || integrity[0]?.integrity_check !== "ok")
      throw new BackupError(`integrity_check: ${JSON.stringify(integrity)}`)
    const fk = db.query("PRAGMA foreign_key_check").all()
    if (fk.length > 0) throw new BackupError(`foreign_key_check: ${fk.length} violaciones`)
    // Lanza si el índice FTS no corresponde a su contenido.
    db.exec("INSERT INTO research_fts(research_fts) VALUES('integrity-check')")
    return {
      path: targetPath,
      integrity: "ok",
      foreign_key_violations: 0,
      fts: "ok",
      migrations_applied: store.migrations.filter((m) => m.status === "applied").map((m) => m.id),
    }
  } catch (e) {
    store?.db.close()
    store = null
    for (const p of [targetPath, `${targetPath}-wal`, `${targetPath}-shm`])
      rmSync(p, { force: true })
    throw e
  } finally {
    store?.db.close()
  }
}

function sha256(bytes: Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex")
}
