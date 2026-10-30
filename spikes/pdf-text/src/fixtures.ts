// Spike ADR-0040 §5: PDFs de prueba. Chromium (Skia) produce lo mismo que Chrome o
// «Guardar como PDF»: fuentes CID con ToUnicode, flujos comprimidos. El mínimo es
// Helvetica sin comprimir, como sale de herramientas viejas.
import { mkdirSync, writeFileSync } from "node:fs"
import { chromium } from "@playwright/test"
import { MINUTA_LINES } from "./fixtures-lines.js"

const out = new URL("../fixtures/", import.meta.url).pathname
mkdirSync(out, { recursive: true })

const minuta = `<!doctype html><meta charset="utf-8"><style>body{font-family:sans-serif;font-size:12pt}</style>
<h1>${MINUTA_LINES[0]}</h1>
<h2>${MINUTA_LINES[1]}</h2>
<p>${MINUTA_LINES[2]}</p>
<ul><li>${MINUTA_LINES[3]}</li><li>${MINUTA_LINES[4]}</li><li>${MINUTA_LINES[5]}</li></ul>
<p>${MINUTA_LINES[6]}</p>
<h2 style="break-before:page">${MINUTA_LINES[7]}</h2>
<p>${MINUTA_LINES[8]}</p>
<div>• ${MINUTA_LINES[9]}</div><div>• ${MINUTA_LINES[10]}</div>`

const parrafo = (n: number) =>
  `<p>Párrafo ${n}. La tienda necesita que cada pedido muestre su estado, su fecha y el método de envío; el equipo revisa los cambios cada semana y deja sus acuerdos en esta minuta para que nadie pierda el hilo.</p>`
const largo = `<!doctype html><meta charset="utf-8"><body style="font-family:serif">${Array.from(
  { length: 40 },
  (_, p) =>
    `<h2 style="break-before:page">Sección ${p + 1}</h2>${Array.from({ length: 8 }, (_, i) => parrafo(p * 8 + i + 1)).join("")}`,
).join("")}`

// Texto pintado en un canvas: el PDF sólo lleva una imagen, como un escaneo.
const escaneado = `<!doctype html><canvas id=c width=800 height=200></canvas><script>
const x = document.getElementById("c").getContext("2d"); x.font = "32px sans-serif";
x.fillText("Pendiente: arreglar el carrito", 20, 80)</script>`

const browser = await chromium.launch()
const page = await browser.newPage()
for (const [name, html] of [
  ["minuta", minuta],
  ["largo", largo],
  ["escaneado", escaneado],
] as const) {
  await page.setContent(html)
  await page.pdf({ path: `${out}${name}.pdf`, format: "A4" })
}
await browser.close()

// PDF 1.4 mínimo: Helvetica con WinAnsiEncoding, contenido sin comprimir, xref clásico.
const objs = [
  "<< /Type /Catalog /Pages 2 0 R >>",
  "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
  "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
  "",
  "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
]
const content =
  "BT /F1 18 Tf 72 760 Td (Pendientes) Tj ET\nBT /F1 12 Tf 72 730 Td (Revisar el cat\\341logo de oto\\361o) Tj ET\nBT /F1 12 Tf 72 712 Td [(Separar ) -250 (en) 20 (v) 30 (\\355os)] TJ ET\n"
objs[3] = `<< /Length ${Buffer.byteLength(content, "latin1")} >>\nstream\n${content}endstream`
let pdf = "%PDF-1.4\n"
const offsets: number[] = []
objs.forEach((o, i) => {
  offsets.push(Buffer.byteLength(pdf, "latin1"))
  pdf += `${i + 1} 0 obj\n${o}\nendobj\n`
})
const xref = Buffer.byteLength(pdf, "latin1")
pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`
pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
writeFileSync(`${out}minimo.pdf`, Buffer.from(pdf, "latin1"))

console.log("fixtures en", out)
