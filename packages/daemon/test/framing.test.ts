import { describe, expect, test } from "bun:test"
import { LineDecoder, LineWriter } from "../src/index.ts"

const enc = (s: string) => new TextEncoder().encode(s)

describe("K-05: framing NDJSON por bytes (ADR-0005 §2)", () => {
  test("un carácter multibyte partido entre dos chunks se reconstruye intacto", () => {
    for (const text of ["Español", "ñandú 🦀 café", "日本語"]) {
      const bytes = enc(`{"t":"${text}"}\n`)
      // cada posible punto de corte, incluidos los que caen dentro de un carácter
      for (let cut = 1; cut < bytes.length; cut++) {
        const d = new LineDecoder()
        const out = [...d.push(bytes.subarray(0, cut)), ...d.push(bytes.subarray(cut))]
        expect(out).toEqual([{ ok: true, line: `{"t":"${text}"}` }])
      }
    }
  })

  test("varias líneas en un chunk, CRLF y líneas vacías", () => {
    const d = new LineDecoder()
    expect(d.push(enc('{"a":1}\r\n\n  \n{"b":2}\n{"c"'))).toEqual([
      { ok: true, line: '{"a":1}' },
      { ok: true, line: '{"b":2}' },
    ])
    expect(d.pendingBytes).toBe(4)
    expect(d.push(enc(":3}\n"))).toEqual([{ ok: true, line: '{"c":3}' }])
  })

  test("un frame que supera el tope se reporta una vez y se descarta hasta el siguiente salto", () => {
    const d = new LineDecoder(8)
    expect(d.push(enc("12345"))).toEqual([])
    const over = d.push(enc("6789abc"))
    expect(over).toEqual([{ ok: false, reason: "frame_too_large", bytes: 12 }])
    expect(d.push(enc("más basura"))).toEqual([])
    expect(d.push(enc('\n{"ok":1}\n'))).toEqual([{ ok: true, line: '{"ok":1}' }])
  })

  test("UTF-8 inválido es un error de esa línea, no de la conexión", () => {
    const d = new LineDecoder()
    const bad = new Uint8Array([0x7b, 0xc3, 0x28, 0x7d, 0x0a])
    expect(d.push(bad)).toEqual([{ ok: false, reason: "invalid_utf8", bytes: 4 }])
    expect(d.push(enc('{"ok":1}\n'))).toEqual([{ ok: true, line: '{"ok":1}' }])
  })

  test("escrituras parciales avanzan por bytes y no corrompen multibyte", () => {
    const w = new LineWriter()
    const size = w.enqueue('{"t":"ñ🦀"}')
    expect(size).toBe(enc('{"t":"ñ🦀"}\n').length)
    const sink: number[] = []
    // el socket acepta 3 bytes por vez
    while (!w.flush((b) => (sink.push(...b.subarray(0, 3)), Math.min(3, b.length)))) {}
    expect(w.queuedBytes).toBe(0)
    expect(new TextDecoder().decode(new Uint8Array(sink))).toBe('{"t":"ñ🦀"}\n')
  })

  test("un socket cerrado (write → -1) deja la cola intacta", () => {
    const w = new LineWriter()
    w.enqueue("x")
    expect(w.flush(() => -1)).toBe(false)
    expect(w.queuedBytes).toBe(2)
  })
})
