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
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
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
  /**
   * Artefactos copiados junto al backup (ADR-0012 §6), en `<dir>/artifacts`
   * con la misma estructura. Ausente en backups anteriores.
   */
  artifacts?: { sha256: string; size: number }[]
}

export type RestoreReport = {
  path: string
  integrity: "ok"
  foreign_key_violations: number
  fts: "ok"
  migrations_applied: string[]
  /** Artefactos verificados y, si se pidió destino, copiados. */
  artifacts_verified: number
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
  opts: { artifactsDir?: string } = {},
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
  // Los artefactos que la base conoce y están en disco van con el backup (ADR-0012 §6).
  if (opts.artifactsDir) {
    const listed: { sha256: string; size: number }[] = []
    const into = join(destDir, `${file}.artifacts`)
    for (const a of store.db
      .query<{ sha256: string; size: number }, []>(
        "SELECT sha256, size FROM artifacts ORDER BY sha256",
      )
      .all()) {
      const from = artifactPath(opts.artifactsDir, a.sha256)
      if (!existsSync(from)) continue
      const to = artifactPath(into, a.sha256)
      mkdirSync(dirname(to), { recursive: true, mode: 0o700 })
      copyFileSync(from, to)
      listed.push(a)
    }
    manifest.artifacts = listed
  }
  const manifestPath = `${path}.manifest.json`
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 })
  return { manifestPath, manifest }
}

/** Restaura el backup del manifest en `targetPath`, que no debe existir. */
export function restoreStore(
  manifestPath: string,
  targetPath: string,
  opts: { migrationsDir?: string; loadVector?: boolean; artifactsDir?: string } = {},
): RestoreReport {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as BackupManifest
  if (manifest.version !== 1)
    throw new BackupError(`manifest versión ${manifest.version} no soportada`)
  const bytes = readFileSync(join(dirname(manifestPath), basename(manifest.file)))
  if (bytes.length !== manifest.bytes || sha256(bytes) !== manifest.sha256)
    throw new BackupError("el backup no coincide con su manifest (tamaño o sha256)")
  for (const p of [targetPath, `${targetPath}-wal`, `${targetPath}-shm`])
    if (existsSync(p)) throw new BackupError(`restore no pisa una base existente: ${p}`)
  // Todos los hashes de los artefactos se verifican antes de tocar nada (ADR-0012 §6).
  const fromDir = join(dirname(manifestPath), `${basename(manifest.file)}.artifacts`)
  for (const a of manifest.artifacts ?? []) {
    const path = artifactPath(fromDir, a.sha256)
    if (!existsSync(path)) throw new BackupError(`falta el artefacto ${a.sha256} del backup`)
    if (sha256(readFileSync(path)) !== a.sha256)
      throw new BackupError(`el artefacto ${a.sha256} no coincide con su hash`)
  }
  if (opts.artifactsDir)
    for (const a of manifest.artifacts ?? []) {
      const to = artifactPath(opts.artifactsDir, a.sha256)
      if (existsSync(to)) continue
      mkdirSync(dirname(to), { recursive: true, mode: 0o700 })
      copyFileSync(artifactPath(fromDir, a.sha256), to)
    }
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
      artifacts_verified: manifest.artifacts?.length ?? 0,
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

function artifactPath(root: string, sha: string): string {
  return join(root, "sha256", sha.slice(0, 2), sha.slice(2))
}
