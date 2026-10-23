/**
 * Prueba de viabilidad del Named Pipe de ADR-0005 §1 con Bun.listen/Bun.connect.
 * Se corre en Windows nativo, no en WSL:
 *
 *   bun scripts/probe-windows-pipe.ts
 *
 * Comprueba que una «ñ» partida entre dos escrituras llega intacta y mide la ida
 * y vuelta de 300 frames en el mismo proceso (servidor eco y cliente juntos: no es
 * comparable con la medición entre procesos de bench-phase0.ts).
 */
const path = `\\\\.\\pipe\\keel-probe-${process.pid}`
const enc = new TextEncoder()
let got = ""
const dec = new TextDecoder()
const server = Bun.listen<undefined>({
  unix: path,
  socket: {
    data(s, chunk) {
      s.write(chunk) // eco
    },
  },
})
const samples: number[] = []
await new Promise<void>((resolve, reject) => {
  let pending: (() => void) | null = null
  Bun.connect<undefined>({
    unix: path,
    socket: {
      data(_s, chunk) {
        got += dec.decode(chunk, { stream: true })
        if (got.endsWith("\n")) {
          const p = pending
          pending = null
          p?.()
        }
      },
      error(_s, e) {
        reject(e)
      },
    },
  }).then(async (c) => {
    // ñ partida entre dos escrituras
    const bytes = enc.encode('{"t":"Español"}\n')
    const cut = bytes.indexOf(0xc3) + 1
    got = ""
    await new Promise<void>((r) => {
      pending = r
      c.write(bytes.subarray(0, cut))
      setTimeout(() => c.write(bytes.subarray(cut)), 20)
    })
    console.log("utf8_split_ok", got === '{"t":"Español"}\n')
    for (let i = 0; i < 300; i++) {
      got = ""
      const t = performance.now()
      await new Promise<void>((r) => {
        pending = r
        c.write(`{"i":${i}}\n`)
      })
      samples.push(performance.now() - t)
    }
    c.end()
    resolve()
  }, reject)
})
server.stop(true)
samples.sort((a, b) => a - b)
const q = (x: number) => samples[Math.floor(x * samples.length)]?.toFixed(3)
console.log(
  JSON.stringify({
    bun: Bun.version,
    platform: process.platform,
    n: samples.length,
    p50_ms: q(0.5),
    p95_ms: q(0.95),
    max_ms: samples.at(-1)?.toFixed(3),
  }),
)
