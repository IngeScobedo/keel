/**
 * Almacén de artefactos direccionado por contenido (ADR-0012). Los bytes viven
 * fuera de SQLite, en `<raíz>/sha256/<2>/<62>`; la tabla `artifacts` guarda
 * tamaño, tipo, sensibilidad e integridad. Son inmutables: se escriben a un
 * temporal y se renombran, y el mismo contenido se guarda una sola vez. Las
 * referencias son `artifact:sha256:<hex>`.
 */

import type { Database } from "bun:sqlite"
import { createHash, randomBytes } from "node:crypto"
import {
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { dirname, join } from "node:path"
import { defaultStateDir } from "./state-dir.js"

export type Sensitivity = "internal" | "restricted"
export type ArtifactRow = {
  sha256: string
  size: number
  media_type: string
  sensitivity: Sensitivity
  integrity: "ok" | "mismatch" | "missing"
  created_at: string
}

const REF_PREFIX = "artifact:sha256:"
/** Tope de una lectura por partes: cabe en un frame de 8 MiB (ADR-0005 §2) en base64. */
export const MAX_READ_BYTES = 4 * 1024 * 1024

export function artifactRef(sha256: string): string {
  return `${REF_PREFIX}${sha256}`
}

/** `artifact:sha256:<hex>` → `<hex>`; null si no es una referencia válida. */
export function parseArtifactRef(ref: string): string | null {
  if (!ref.startsWith(REF_PREFIX)) return null
  const hex = ref.slice(REF_PREFIX.length)
  return /^[0-9a-f]{64}$/.test(hex) ? hex : null
}

export function defaultArtifactsDir(
  platform: NodeJS.Platform = process.platform,
  env: Record<string, string | undefined> = process.env,
): string {
  return join(defaultStateDir(platform, env), "artifacts")
}

export class ArtifactStore {
  readonly root: string
  private readonly db: Database
  constructor(root: string, db: Database) {
    this.root = root
    this.db = db
  }

  pathOf(sha256: string): string {
    return join(this.root, "sha256", sha256.slice(0, 2), sha256.slice(2))
  }

  /**
   * Guarda el contenido si no estaba y devuelve su referencia. Escribe a un
   * temporal y renombra: un lector nunca ve un archivo a medias.
   */
  put(
    content: Uint8Array | string,
    mediaType: string,
    sensitivity: Sensitivity = "internal",
  ): { ref: string; sha256: string; size: number } {
    const bytes = typeof content === "string" ? Buffer.from(content, "utf8") : content
    const sha256 = createHash("sha256").update(bytes).digest("hex")
    const path = this.pathOf(sha256)
    if (!existsSync(path)) {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
      const tmp = `${path}.${randomBytes(6).toString("hex")}.tmp`
      writeFileSync(tmp, bytes, { mode: 0o600 })
      renameSync(tmp, path)
    }
    // La misma clave con más restricción gana: lo restringido nunca se relaja.
    this.db
      .query(
        `INSERT INTO artifacts(sha256, size, media_type, sensitivity) VALUES (?,?,?,?)
         ON CONFLICT(sha256) DO UPDATE SET
           sensitivity = CASE WHEN excluded.sensitivity = 'restricted' THEN 'restricted' ELSE artifacts.sensitivity END,
           integrity = 'ok'`,
      )
      .run(sha256, bytes.byteLength, mediaType, sensitivity)
    return { ref: artifactRef(sha256), sha256, size: bytes.byteLength }
  }

  get(sha256: string): ArtifactRow | null {
    return this.db
      .query<ArtifactRow, [string]>("SELECT * FROM artifacts WHERE sha256 = ?")
      .get(sha256)
  }

  /** Lectura por partes (ADR-0012 §9); el cliente verifica el hash al final. */
  read(
    sha256: string,
    offset = 0,
    length = MAX_READ_BYTES,
  ): { data: Uint8Array; size: number; eof: boolean } {
    const path = this.pathOf(sha256)
    const fd = openSync(path, "r")
    try {
      const size = fstatSync(fd).size
      const want = Math.max(0, Math.min(length, MAX_READ_BYTES, size - offset))
      const data = new Uint8Array(want)
      const n = want > 0 ? readSync(fd, data, 0, want, offset) : 0
      return { data: data.subarray(0, n), size, eof: offset + n >= size }
    } finally {
      closeSync(fd)
    }
  }

  /** El contenido entero, para usos internos del daemon (proyecciones). */
  readAll(sha256: string): Buffer {
    return readFileSync(this.pathOf(sha256))
  }

  /** ¿Siguen coincidiendo los bytes con su hash? Lo marca en la tabla (ADR-0012 §6). */
  verify(sha256: string): "ok" | "mismatch" | "missing" {
    const path = this.pathOf(sha256)
    let state: "ok" | "mismatch" | "missing"
    if (!existsSync(path)) state = "missing"
    else
      state =
        createHash("sha256").update(readFileSync(path)).digest("hex") === sha256 ? "ok" : "mismatch"
    this.db.query("UPDATE artifacts SET integrity = ? WHERE sha256 = ?").run(state, sha256)
    return state
  }

  /** Borra los bytes y la fila. Sólo lo llama la recolección tras una purga. */
  remove(sha256: string): void {
    rmSync(this.pathOf(sha256), { force: true })
    this.db.query("DELETE FROM artifacts WHERE sha256 = ?").run(sha256)
  }
}
