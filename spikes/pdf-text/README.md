# Spike: texto de un PDF para las fuentes del proyecto (ADR-0040 §5)

ADR-0040 pide leer «PDF con texto» por página y bloque, y medir en su spike la
dependencia nueva. Aquí se comparan dos candidatos sobre el mismo motor (pdf.js)
y `pdftotext` (poppler) como referencia: no existe en Windows, así que no es
candidato.

```bash
bun install
bun spikes/pdf-text/src/fixtures.ts   # genera fixtures/ con Chromium de Playwright
bun spikes/pdf-text/src/measure.ts
```

## Fixtures

Chromium (Skia) produce lo mismo que Chrome o «Guardar como PDF»: fuentes CID
con ToUnicode y flujos comprimidos. `fixtures/` está gitignored; `minuta.pdf` y
`escaneado.pdf` se copiaron a `packages/daemon/test/fixtures/`.

| Fixture     | Qué es                                                     | Tamaño  | Estructura                   |
| ----------- | ---------------------------------------------------------- | ------- | ---------------------------- |
| `minuta`    | 2 páginas, títulos, `<ul>`, viñetas «•», acentos, ñ, «»    | 22.1 KB | Flate, Type0/CID, ToUnicode  |
| `minimo`    | Helvetica WinAnsi sin comprimir, TJ con kerning, a mano    | 0.7 KB  | xref clásico, sin compresión |
| `largo`     | 40 páginas, 320 párrafos                                   | 50.9 KB | Flate, Type0/CID, ToUnicode  |
| `escaneado` | Sólo una imagen (texto pintado en un canvas), como escaneo | 5.0 KB  | Flate, sin fuentes           |

Las fuentes CID con ToUnicode descartan un lector propio sin dependencias:
habría que implementar CMaps, fuentes compuestas y, para PDFs de Word, flujos de
objetos. pdf.js ya lo hace.

## Resultados (2026-10-30, WSL2, Bun 1.4.2)

| Medida                                         | `unpdf` 1.9.0   | `pdfjs-dist` 6.4.299 | `pdftotext` |
| ---------------------------------------------- | --------------- | -------------------- | ----------- |
| Peso instalado                                 | 2.6 MB          | 35 MB                | sistema     |
| Dependencias en ejecución                      | 0               | 0                    | —           |
| Primera extracción en frío (import + `minimo`) | 174–176 ms      | 429–494 ms           | —           |
| `minuta`: líneas esperadas                     | 11/11           | 11/11                | 11/11       |
| `minuta`: bloques                              | 11              | 11                   | —           |
| `minimo`: acentos WinAnsi y TJ                 | 3/3             | 3/3                  | 3/3         |
| `largo`: tiempo, bloques                       | 114–154 ms, 360 | 81–104 ms, 360       | 48–60 ms    |
| `escaneado`: caracteres                        | 0               | 0                    | 0           |
| RSS tras 5 extracciones de `largo`             | +6 a +10 MB     | —                    | —           |

- Los dos candidatos dan el mismo texto, carácter por carácter: `unpdf` 1.9.0
  empaqueta pdf.js 6.4.299 sin worker, sin canvas y sin `eval` ni `new Function`
  (contado en `dist/pdfjs.mjs`). pdf.js 6 ya no tiene `isEvalSupported`.
- `largo` da exactamente 360 bloques: 40 títulos y 320 párrafos.
- Un escaneo da 0 caracteres en los tres: sin OCR no hay texto, y se rechaza con
  su porqué.

## Decisión

`unpdf` **1.9.0** fijado exacto en `@keel/daemon`: 13 veces más liviano que
`pdfjs-dist`, arranque 2.5× más rápido y el mismo texto. Es la versión más nueva
con dos semanas publicada (15 oct; 1.9.1 y 2.x son de los últimos días).

## Bloques

pdf.js da ítems con posición; `blocksOf` (en `packages/daemon/src/pdf-text.ts`)
arma líneas por `hasEOL` y abre bloque nuevo con:

- un salto vertical mayor a 1.6 veces la altura de la letra, u otro tamaño;
- una viñeta de texto (`•`, `◦`, `–`…), que pasa a ítem de lista Markdown;
- más sangría que la línea anterior;
- una línea que cierra frase (`.?!:;`) seguida de una que empieza en mayúscula:
  los `<li>` de Chromium dibujan la viñeta, no la escriben, y llegan como líneas
  a la misma `x` sin tocar el margen;
- una línea anterior corta (no llegó al 85 % del margen derecho).

Partir de más sólo da citas más finas; juntar dos pendientes en un pasaje sí
estorba al intake. Límite conocido: en `minimo` dos renglones sueltos sin
puntuación y con interlineado 1.5 quedan en un bloque, igual que un párrafo.

## En el daemon

- `pdf-worker.ts` corre pdf.js en un Worker de Bun: pdf.js trabaja en el hilo
  que lo llama, y un PDF hostil no debe colgar el daemon. Si no contesta en 30
  s, se termina el Worker y la fuente se rechaza.
- Cada página con texto abre `## Página N`, así cada pasaje lleva su página.
- Se rechazan con su porqué: escaneos sin texto (OCR pide su spike), PDFs con
  contraseña y archivos que no son PDF.
