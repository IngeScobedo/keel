/**
 * PDF con texto por página y bloque (ADR-0040 §5). `minuta.pdf` y `escaneado.pdf` salen
 * de `spikes/pdf-text` (Chromium: fuentes CID con ToUnicode); el mínimo, Helvetica sin
 * comprimir, sale de `fixtures/minimal-pdf.ts`.
 */
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { passagesOf } from "@keel/core"
import { blocksOf } from "../src/pdf-text.js"
import { extractText, SourceError } from "../src/sources-extract.js"
import { minimalPdf } from "./fixtures/minimal-pdf.ts"

const fixture = (name: string) =>
  new Uint8Array(readFileSync(join(import.meta.dir, "fixtures", name)))

const PDF = "application/pdf"

describe("PDF a pasajes", () => {
  test("una minuta de Chromium: página como encabezado, un pasaje por pendiente", async () => {
    const passages = passagesOf(await extractText(fixture("minuta.pdf"), PDF, "minuta.pdf"))
    expect(passages.map((p) => [p.heading, p.text])).toEqual([
      ["Página 1", "Minuta: pendientes de la tienda"],
      ["Página 1", "Acuerdos del 28 de octubre"],
      ["Página 1", "Quedamos en que la galería del producto ordena las fotos por fecha."],
      ["Página 1", "El botón «Comprar» no se ve en el móvil cuando el carrito está vacío."],
      ["Página 1", "Agregar el envío gratis a partir de $1,500 en la ficha del producto."],
      ["Página 1", "Cambiar el texto de la sección «Mi cuenta» a «Mis pedidos»."],
      ["Página 1", "¿Quién revisa el despliegue del viernes? Pendiente: Ñandú."],
      ["Página 2", "Segunda página"],
      ["Página 2", "Revisar que los pedidos con año 2025 aparezcan en el historial."],
      ["Página 2", "Subir las fotos nuevas de la colección."],
      ["Página 2", "Quitar el banner de verano."],
    ])
  })

  test("Helvetica con acentos en WinAnsi; un # al inicio no se vuelve encabezado", async () => {
    const md = await extractText(
      minimalPdf(["Revisar el catálogo de otoño.", "# no es un título"]),
      PDF,
      "x.pdf",
    )
    expect(passagesOf(md).map((p) => [p.heading, p.text])).toEqual([
      ["Página 1", "Revisar el catálogo de otoño."],
      ["Página 1", "\\# no es un título"],
    ])
  })

  test("un escaneo, un archivo roto y un PDF que no termina se rechazan con por qué", async () => {
    await expect(extractText(fixture("escaneado.pdf"), PDF, "s.pdf")).rejects.toThrow(
      "no tiene texto",
    )
    await expect(
      extractText(new Uint8Array(Buffer.from("%PDF-1.4 roto")), PDF, "r.pdf"),
    ).rejects.toThrow("no es un PDF válido")
    const slow = extractText(fixture("minuta.pdf"), PDF, "m.pdf", 1)
    await expect(slow).rejects.toBeInstanceOf(SourceError)
    await expect(slow).rejects.toThrow("tardó más de")
  })

  test("bloques: viñeta, sangría y cierre de frase abren bloque; un renglón partido no", () => {
    const item = (str: string, x: number, y: number, width: number) => ({
      str,
      transform: [12, 0, 0, 12, x, y],
      width,
      height: 12,
      hasEOL: true,
    })
    expect(
      blocksOf([
        item("La tienda necesita que cada pedido muestre", 72, 700, 450),
        item("su estado y su fecha.", 72, 686, 200),
        item("• Subir fotos", 72, 660, 100),
        item("Quitar el banner", 90, 646, 120),
      ]),
    ).toEqual([
      "La tienda necesita que cada pedido muestre su estado y su fecha.",
      "- Subir fotos",
      "Quitar el banner",
    ])
  })
})
