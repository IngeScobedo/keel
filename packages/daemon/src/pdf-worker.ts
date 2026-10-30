/**
 * Worker que lee un PDF (ADR-0040 §5). pdf.js corre en el hilo que lo llama: aquí, si un
 * PDF lo cuelga, el daemon termina este Worker y sigue respondiendo.
 */
import { pdfToMarkdown } from "./pdf-text.js"

declare const self: Worker

self.onmessage = async (e: MessageEvent<Uint8Array>) => {
  try {
    self.postMessage(await pdfToMarkdown(e.data))
  } catch (err) {
    self.postMessage({ ok: false, reason: "invalid", message: (err as Error).message })
  }
}
