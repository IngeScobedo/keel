/**
 * Framing NDJSON por bytes (ADR-0005 §2): una línea UTF-8 por frame, tope de
 * `MAX_FRAME_BYTES`. Se corta y se mide en bytes, nunca en unidades UTF-16:
 * un carácter multibyte puede llegar partido entre dos chunks del socket y una
 * escritura parcial devuelve bytes, no caracteres.
 *
 * No depende del daemon ni del socket: el servidor, el cliente y cualquier otro
 * proceso que hable el protocolo lo usan igual.
 */
import { MAX_FRAME_BYTES } from "@keel/core"

const NEWLINE = 0x0a
const CARRIAGE_RETURN = 0x0d

export type DecodedLine =
  | { ok: true; line: string }
  | { ok: false; reason: "frame_too_large"; bytes: number }
  | { ok: false; reason: "invalid_utf8"; bytes: number }

/** Acumula chunks y entrega líneas completas ya decodificadas. */
export class LineDecoder {
  private chunks: Uint8Array[] = []
  private size = 0
  /** Tras un frame que excede el tope se descarta hasta el siguiente salto de línea. */
  private discarding = false
  private readonly maxBytes: number
  private readonly utf8 = new TextDecoder("utf-8", { fatal: true })

  constructor(maxBytes: number = MAX_FRAME_BYTES) {
    this.maxBytes = maxBytes
  }

  /** Bytes pendientes de una línea sin terminar. */
  get pendingBytes(): number {
    return this.size
  }

  push(chunk: Uint8Array): DecodedLine[] {
    const out: DecodedLine[] = []
    let start = 0
    while (start <= chunk.length) {
      const nl = chunk.indexOf(NEWLINE, start)
      const end = nl === -1 ? chunk.length : nl
      if (!this.discarding && end > start) {
        if (this.size + (end - start) > this.maxBytes) {
          out.push({ ok: false, reason: "frame_too_large", bytes: this.size + (end - start) })
          this.reset()
          this.discarding = true
        } else {
          // Copia: el runtime puede reutilizar el buffer del chunk tras el callback.
          this.chunks.push(chunk.slice(start, end))
          this.size += end - start
        }
      }
      if (nl === -1) break
      if (this.discarding) this.discarding = false
      else this.emitLine(out)
      start = nl + 1
    }
    return out
  }

  private emitLine(out: DecodedLine[]): void {
    let bytes = this.concat()
    this.reset()
    if (bytes.length > 0 && bytes[bytes.length - 1] === CARRIAGE_RETURN)
      bytes = bytes.subarray(0, -1)
    if (bytes.length === 0) return
    try {
      const line = this.utf8.decode(bytes)
      if (line.trim().length > 0) out.push({ ok: true, line })
    } catch {
      out.push({ ok: false, reason: "invalid_utf8", bytes: bytes.length })
    }
  }

  private concat(): Uint8Array {
    if (this.chunks.length === 1) return this.chunks[0] as Uint8Array
    const all = new Uint8Array(this.size)
    let offset = 0
    for (const c of this.chunks) {
      all.set(c, offset)
      offset += c.length
    }
    return all
  }

  private reset(): void {
    this.chunks = []
    this.size = 0
  }
}

/** Cola de salida en bytes: tolera escrituras parciales y mide lo pendiente para el backpressure. */
export class LineWriter {
  private queue: Uint8Array[] = []
  private queued = 0
  private readonly encoder = new TextEncoder()

  get queuedBytes(): number {
    return this.queued
  }

  /** Encola una línea (sin salto final) y devuelve su tamaño en bytes. */
  enqueue(line: string): number {
    const bytes = this.encoder.encode(`${line}\n`)
    this.queue.push(bytes)
    this.queued += bytes.length
    return bytes.length
  }

  /**
   * Escribe lo que acepte `write` (que devuelve los bytes escritos). Devuelve
   * `true` si la cola quedó vacía; si no, se reintenta en el siguiente `drain`.
   */
  flush(write: (bytes: Uint8Array) => number): boolean {
    while (this.queue.length > 0) {
      const head = this.queue[0] as Uint8Array
      const written = Math.max(0, write(head))
      if (written < head.length) {
        this.queue[0] = head.subarray(written)
        this.queued -= written
        return false
      }
      this.queue.shift()
      this.queued -= head.length
    }
    return true
  }

  clear(): void {
    this.queue = []
    this.queued = 0
  }
}
