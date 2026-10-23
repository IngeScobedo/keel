/**
 * Cuerpos grandes (ADR-0004 §3, SDD 03 §5): por encima del umbral se guarda un
 * preview que sigue siendo JSON válido, con hash, tamaño y una referencia al
 * cuerpo íntegro. Nunca se trunca en silencio ni se corta un JSON a la mitad.
 */

/** Umbral propuesto por SDD 03 §5. */
export const INLINE_JSON_MAX_BYTES = 256 * 1024
/** Caracteres del cuerpo que viajan en el preview. */
export const PREVIEW_CHARS = 4096

export type JsonPreview = {
  keel_preview: 1
  bytes: number
  sha256: string
  /** Dónde está el cuerpo íntegro, p. ej. `event:<id>#/tool_response`. */
  body_ref: string
  preview: string
}

/**
 * Serializa `value`. Si cabe, lo devuelve tal cual; si no, devuelve el preview
 * serializado y la referencia, que va también a la columna `artifact_ref`.
 */
export function inlineOrPreview(
  value: unknown,
  bodyRef: string,
  maxBytes: number = INLINE_JSON_MAX_BYTES,
): { json: string; artifactRef: string | null } {
  const json = JSON.stringify(value)
  const bytes = Buffer.byteLength(json, "utf8")
  if (bytes <= maxBytes) return { json, artifactRef: null }
  const preview: JsonPreview = {
    keel_preview: 1,
    bytes,
    sha256: new Bun.CryptoHasher("sha256").update(json).digest("hex"),
    body_ref: bodyRef,
    preview: json.slice(0, PREVIEW_CHARS),
  }
  return { json: JSON.stringify(preview), artifactRef: bodyRef }
}

/**
 * Como `inlineOrPreview`, pero el cuerpo íntegro va a un almacén (ADR-0012 §2):
 * `store` lo guarda y devuelve su referencia (`artifact:sha256:<hex>`).
 */
export function previewOrInline(
  json: string,
  store: (body: string) => string,
  maxBytes: number = INLINE_JSON_MAX_BYTES,
): { json: string; artifactRef: string | null } {
  const bytes = Buffer.byteLength(json, "utf8")
  if (bytes <= maxBytes) return { json, artifactRef: null }
  const ref = store(json)
  const preview: JsonPreview = {
    keel_preview: 1,
    bytes,
    sha256: new Bun.CryptoHasher("sha256").update(json).digest("hex"),
    body_ref: ref,
    preview: json.slice(0, PREVIEW_CHARS),
  }
  return { json: JSON.stringify(preview), artifactRef: ref }
}
