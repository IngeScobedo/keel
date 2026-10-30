// Spike ADR-0040 §5: texto de un PDF por página y bloque. Mide fidelidad, tiempo, peso
// e import en frío de `unpdf` y `pdfjs-dist`; `pdftotext` (poppler) es sólo la
// referencia: no existe en Windows, así que no es candidato.
import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { MINUTA_LINES } from "./fixtures-lines.js"

const dir = new URL("../fixtures/", import.meta.url).pathname
const FIXTURES = ["minuta", "minimo", "largo", "escaneado"] as const
const EXPECTED: Record<string, string[]> = {
  minuta: MINUTA_LINES,
  minimo: ["Pendientes", "Revisar el catálogo de otoño", "Separar envíos"],
  largo: ["Sección 40", "Párrafo 320. La tienda necesita que cada pedido muestre su estado"],
  escaneado: [],
}

type Item = { str: string; transform: number[]; width: number; height: number; hasEOL: boolean }
type Proxy = {
  numPages: number
  getPage(n: number): Promise<{ getTextContent(): Promise<{ items: unknown[] }> }>
  destroy?(): Promise<void>
  loadingTask?: { destroy(): Promise<void> }
}

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

async function viaProxy(doc: Proxy): Promise<string[][]> {
  const pages: string[][] = []
  for (let p = 1; p <= doc.numPages; p++) {
    const tc = await (await doc.getPage(p)).getTextContent()
    pages.push(blocksOf(tc.items.filter((i): i is Item => typeof (i as Item).str === "string")))
  }
  await (doc.destroy?.() ?? doc.loadingTask?.destroy())
  return pages
}

const CANDIDATES: Record<string, (bytes: Uint8Array) => Promise<string[][]>> = {
  unpdf: async (bytes) => {
    const { getDocumentProxy } = await import("unpdf")
    return viaProxy((await getDocumentProxy(bytes)) as unknown as Proxy)
  },
  "pdfjs-dist": async (bytes) => {
    const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs")
    return viaProxy((await getDocument({ data: bytes, verbosity: 0 }).promise) as unknown as Proxy)
  },
  pdftotext: async (_bytes) => [], // se corre aparte, por archivo
}

const norm = (s: string) => s.replace(/\s+/g, " ").trim()
function recall(text: string, expected: string[]) {
  const t = norm(text)
  const miss = expected.filter((e) => !t.includes(norm(e)))
  return { hits: expected.length - miss.length, miss }
}

console.log("## Estructura de los fixtures\n")
for (const f of FIXTURES) {
  const raw = readFileSync(`${dir}${f}.pdf`).toString("latin1")
  const has = (re: RegExp) => (re.test(raw) ? "sí" : "no")
  console.log(
    `${f}: ${(raw.length / 1024).toFixed(1)} KB · Flate ${has(/FlateDecode/)} · Type0/CID ${has(/\/Type0/)} · ToUnicode ${has(/ToUnicode/)} · ObjStm ${has(/\/ObjStm/)} · XRef stream ${has(/\/Type\s*\/XRef/)}`,
  )
}

console.log("\n## Primera extracción en frío: import + `minimo` (proceso nuevo, mediana de 5)\n")
for (const [name, spec] of [
  [
    "unpdf",
    `const { getDocumentProxy } = await import("unpdf"); const d = await getDocumentProxy(new Uint8Array(require("fs").readFileSync("fixtures/minimo.pdf"))); await (await d.getPage(1)).getTextContent()`,
  ],
  [
    "pdfjs-dist",
    `const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs"); const d = await getDocument({ data: new Uint8Array(require("fs").readFileSync("fixtures/minimo.pdf")), verbosity: 0 }).promise; await (await d.getPage(1)).getTextContent()`,
  ],
] as const) {
  const runs = Array.from({ length: 5 }, () =>
    Number(
      execFileSync(
        "bun",
        ["-e", `const t=performance.now();${spec};console.log(performance.now()-t)`],
        { cwd: new URL("..", import.meta.url).pathname },
      ).toString(),
    ),
  ).sort((a, b) => a - b)
  console.log(`${name}: ${runs[2]?.toFixed(0)} ms`)
}

console.log("\n## Extracción\n")
for (const f of FIXTURES) {
  const bytes = new Uint8Array(readFileSync(`${dir}${f}.pdf`))
  for (const [name, run] of Object.entries(CANDIDATES)) {
    let text: string
    let pages: string[][] = []
    const t0 = performance.now()
    try {
      if (name === "pdftotext")
        text = execFileSync("pdftotext", ["-layout", `${dir}${f}.pdf`, "-"]).toString()
      else {
        pages = await run(bytes.slice())
        text = pages.map((b) => b.join("\n\n")).join("\n\n")
      }
    } catch (e) {
      console.log(`${f} · ${name}: ERROR ${(e as Error).message}`)
      continue
    }
    const ms = performance.now() - t0
    const r = recall(text, EXPECTED[f] ?? [])
    const blocks = pages.reduce((n, b) => n + b.length, 0)
    console.log(
      `${f} · ${name}: ${ms.toFixed(0)} ms · ${text.trim().length} chars · ${pages.length || "-"} págs · ${blocks || "-"} bloques · líneas ${r.hits}/${EXPECTED[f]?.length}${r.miss.length ? ` · faltan ${JSON.stringify(r.miss)}` : ""}`,
    )
    if (f === "minuta" && name === "unpdf") console.log(JSON.stringify(pages, null, 1))
    if (f === "minimo" && name !== "pdftotext") console.log(JSON.stringify(pages))
  }
}

console.log("\n## Memoria tras extraer `largo` 5 veces (unpdf)\n")
const big = new Uint8Array(readFileSync(`${dir}largo.pdf`))
const rss0 = process.memoryUsage().rss
for (let i = 0; i < 5; i++) await CANDIDATES.unpdf?.(big.slice())
Bun.gc(true)
console.log(`RSS +${((process.memoryUsage().rss - rss0) / 2 ** 20).toFixed(0)} MB`)
