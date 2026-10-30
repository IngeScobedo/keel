/**
 * El texto de un PDF por página y bloque (ADR-0040 §1 y §5). pdf.js empaquetado por
 * `unpdf` 1.9.0 (pdf.js 6.4.299, sin worker ni `eval`); el spike `spikes/pdf-text` midió
 * fidelidad, tiempo y peso. Corre dentro de `pdf-worker.ts` para que un PDF hostil no
 * bloquee el daemon: `pdfToMarkdown` es lo que llama el worker.
 */
import { getDocumentProxy } from "unpdf"

/** Lo que el Worker devuelve, o por qué no pudo. */
export type PdfResult =
  | { ok: true; markdown: string; pages: number }
  | { ok: false; reason: "password" | "invalid" | "empty"; message: string }

type Item = { str: string; transform: number[]; width: number; height: number; hasEOL: boolean }

const BULLET = /^[•◦▪▫●○■□‣⁃–-]\s+/

/**
 * Ítems de pdf.js a bloques. Una línea termina en `hasEOL`. Abre bloque nuevo: un salto
 * vertical grande, otro tamaño de letra, una viñeta, más sangría, una línea que cierra
 * frase seguida de una que empieza en mayúscula, o una línea anterior corta (no llegó al
 * margen derecho). Partir de más sólo da citas más finas; juntar dos pendientes no.
 */
export function blocksOf(items: Item[]): string[] {
  type Line = { text: string; x: number; y: number; h: number; right: number }
  const lines: Line[] = []
  let cur: Line | null = null
  for (const it of items) {
    if (it.str) {
      const x = it.transform[4] ?? 0
      cur ??= { text: "", x, y: it.transform[5] ?? 0, h: it.height, right: 0 }
      cur.text += it.str
      cur.right = Math.max(cur.right, x + it.width)
    } else if (cur && !it.hasEOL) cur.text += " "
    if (it.hasEOL && cur) {
      if (cur.text.trim()) lines.push({ ...cur, text: cur.text.trim() })
      cur = null
    }
  }
  if (cur?.text.trim()) lines.push({ ...cur, text: cur.text.trim() })
  const margin = Math.max(0, ...lines.map((l) => l.right))
  const blocks: string[] = []
  let para: string[] = []
  lines.forEach((l, i) => {
    const prev = lines[i - 1]
    if (
      prev &&
      (Math.abs(prev.y - l.y) > 1.6 * Math.max(prev.h, l.h) ||
        Math.abs(prev.h - l.h) > 0.5 ||
        BULLET.test(l.text) ||
        l.x > prev.x + l.h / 2 ||
        (/[.!?:;]$/.test(prev.text) && /^[¿¡"«(\p{Lu}\d]/u.test(l.text)) ||
        prev.right < margin * 0.85)
    ) {
      blocks.push(para.join(" "))
      para = []
    }
    para.push(l.text)
  })
  if (para.length) blocks.push(para.join(" "))
  return blocks.map((b) => b.replace(BULLET, "- "))
}

/** Un bloque que `passagesOf` leería como encabezado o código se escapa: es texto. */
const literal = (b: string) => b.replace(/^(\s*)(#{1,6}\s|```)/, "$1\\$2")

/**
 * El PDF a Markdown: `## Página N` abre cada página con texto y cada bloque es un
 * párrafo (o un ítem `-`), así cada pasaje lleva su página como encabezado.
 */
export async function pdfToMarkdown(bytes: Uint8Array): Promise<PdfResult> {
  let doc: Awaited<ReturnType<typeof getDocumentProxy>>
  try {
    doc = await getDocumentProxy(bytes, { verbosity: 0, disableFontFace: true })
  } catch (e) {
    const name = (e as { name?: string }).name
    if (name === "PasswordException")
      return {
        ok: false,
        reason: "password",
        message: "el PDF pide contraseña: quítasela o súbelo como .docx o .md",
      }
    return { ok: false, reason: "invalid", message: `no es un PDF válido: ${(e as Error).message}` }
  }
  try {
    const out: string[] = []
    for (let n = 1; n <= doc.numPages; n++) {
      const content = await (await doc.getPage(n)).getTextContent()
      const blocks = blocksOf(content.items.filter((i) => "str" in i))
      if (blocks.length) out.push(`## Página ${n}`, ...blocks.map(literal))
    }
    if (!out.length)
      return {
        ok: false,
        reason: "empty",
        message:
          "el PDF no tiene texto (¿es un escaneo?): Keel todavía no hace OCR (ADR-0040 §5). Pégalo como texto o súbelo como .docx o .md.",
      }
    return { ok: true, markdown: out.join("\n\n"), pages: doc.numPages }
  } finally {
    await doc.loadingTask.destroy()
  }
}
