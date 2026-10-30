/**
 * El texto de una fuente (ADR-0040 §1 y §5): Markdown y texto tal cual, `.docx` leyendo
 * su `word/document.xml` con un lector ZIP mínimo, y PDF con texto por página y bloque
 * en un Worker (`pdf-worker.ts`). Lo que sale es Markdown que `passagesOf` parte en
 * pasajes. Escaneos sin texto todavía no: OCR pide su spike.
 */
import { inflateRawSync } from "node:zlib"
import type { PdfResult } from "./pdf-text.js"

export class SourceError extends Error {}

const TEXT = /^(text\/|application\/(json|x-yaml|yaml|xml|csv))/
const TEXT_EXT = /\.(md|markdown|txt|csv|tsv|json|ya?ml|log)$/i
const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"

/** Lo más que Keel espera a un PDF; medido en el spike: 40 páginas en 150 ms. */
export const PDF_TIMEOUT_MS = 30_000

export async function extractText(
  bytes: Uint8Array,
  mediaType: string,
  title: string,
  pdfTimeoutMs = PDF_TIMEOUT_MS,
): Promise<string> {
  if (mediaType === DOCX || /\.docx$/i.test(title)) return docxToMarkdown(bytes)
  if (mediaType === "application/pdf" || /\.pdf$/i.test(title)) return pdfText(bytes, pdfTimeoutMs)
  if (TEXT.test(mediaType) || TEXT_EXT.test(title) || mediaType === "")
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes)
  throw new SourceError(`no sé leer ${mediaType || title}: sube .md, .txt, .docx o .pdf`)
}

/** El PDF en un Worker propio; si no contesta a tiempo se termina y la fuente se rechaza. */
function pdfText(bytes: Uint8Array, timeoutMs: number): Promise<string> {
  const worker = new Worker(new URL("./pdf-worker.ts", import.meta.url).href)
  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new SourceError(`el PDF tardó más de ${timeoutMs / 1000} s en leerse`))
      worker.terminate()
    }, timeoutMs)
    worker.onmessage = (e: MessageEvent<PdfResult>) => {
      clearTimeout(timer)
      worker.terminate()
      if (e.data.ok) resolve(e.data.markdown)
      else reject(new SourceError(e.data.message))
    }
    worker.onerror = (e) => {
      clearTimeout(timer)
      worker.terminate()
      reject(new SourceError(`no se pudo leer el PDF: ${e.message}`))
    }
    // Copia propia: un Buffer de Node puede compartir su ArrayBuffer con otros.
    const copy = new Uint8Array(bytes)
    worker.postMessage(copy, [copy.buffer])
  })
}

/** Lee un archivo de un ZIP por su nombre: directorio central y su cabecera local. */
export function unzipEntry(zip: Uint8Array, name: string): Uint8Array | null {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength)
  // El fin del directorio central está en los últimos 64 KB + 22 bytes.
  let eocd = -1
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 65_557); i--)
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i
      break
    }
  if (eocd < 0) throw new SourceError("el archivo no es un ZIP válido (¿es un .docx?)")
  const count = view.getUint16(eocd + 10, true)
  let at = view.getUint32(eocd + 16, true)
  const decoder = new TextDecoder()
  for (let n = 0; n < count; n++) {
    if (view.getUint32(at, true) !== 0x02014b50) break
    const method = view.getUint16(at + 10, true)
    const compressed = view.getUint32(at + 20, true)
    const nameLen = view.getUint16(at + 28, true)
    const extraLen = view.getUint16(at + 30, true)
    const commentLen = view.getUint16(at + 32, true)
    const local = view.getUint32(at + 42, true)
    const entry = decoder.decode(zip.subarray(at + 46, at + 46 + nameLen))
    at += 46 + nameLen + extraLen + commentLen
    if (entry !== name) continue
    const lName = view.getUint16(local + 26, true)
    const lExtra = view.getUint16(local + 28, true)
    const start = local + 30 + lName + lExtra
    const data = zip.subarray(start, start + compressed)
    if (method === 0) return data
    if (method === 8) return new Uint8Array(inflateRawSync(data))
    throw new SourceError(`compresión ZIP ${method} no soportada`)
  }
  return null
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
}
function decodeXml(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e: string) => {
    if (e[0] === "#")
      return String.fromCodePoint(
        e[1] === "x" || e[1] === "X" ? Number.parseInt(e.slice(2), 16) : Number(e.slice(1)),
      )
    return ENTITIES[e] ?? m
  })
}

/**
 * Un `.docx` a Markdown: un párrafo por `<w:p>`, los títulos (`Heading1`, `Title`) con
 * `#`, y los ítems de lista (`<w:numPr>`) con `-`. Basta para minutas y listas de
 * tareas; tablas y estilos se pierden.
 */
export function docxToMarkdown(bytes: Uint8Array): string {
  const xml = unzipEntry(bytes, "word/document.xml")
  if (!xml) throw new SourceError("el .docx no tiene word/document.xml")
  const doc = new TextDecoder().decode(xml)
  const out: string[] = []
  for (const p of doc.match(/<w:p[\s>][\s\S]*?<\/w:p>/g) ?? []) {
    const text = decodeXml(
      (p.match(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\/>|<w:br\/>/g) ?? [])
        .map((t) =>
          t.startsWith("<w:tab") ? "\t" : t.startsWith("<w:br") ? " " : t.replace(/<[^>]+>/g, ""),
        )
        .join(""),
    ).trim()
    if (!text) {
      out.push("")
      continue
    }
    const style = /<w:pStyle w:val="([^"]+)"/.exec(p)?.[1] ?? ""
    const level = /^(?:Heading|Ttulo|Titulo)(\d)$/i.exec(style)?.[1]
    if (level) out.push(`${"#".repeat(Math.min(6, Number(level)))} ${text}`, "")
    else if (/^Title$/i.test(style)) out.push(`# ${text}`, "")
    else if (/<w:numPr>/.test(p)) out.push(`- ${text}`)
    else out.push(text, "")
  }
  return out
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}
