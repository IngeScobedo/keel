/**
 * ULID puro: codificacion Crockford base32 (48 bits de tiempo + 80 aleatorios).
 *
 * core no tiene acceso a reloj ni a entropia (contrato: cero I/O, `"types": []`), asi que
 * la aleatoriedad ENTRA como argumento. Quien llama (collector, hook-bridge) pone los 10
 * bytes; esto solo codifica. `ulidTime` decodifica el prefijo para ordenar/depurar.
 */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
const TIME_LEN = 10
const RANDOM_LEN = 16
const RANDOM_BYTES = 10

export function encodeUlid(timeMs: number, randomBytes: ArrayLike<number>): string {
  if (randomBytes.length < RANDOM_BYTES) {
    throw new Error(`encodeUlid necesita ${RANDOM_BYTES} bytes de entropia`)
  }
  let time = ""
  let t = timeMs
  for (let i = 0; i < TIME_LEN; i++) {
    time = (ALPHABET[t % 32] ?? "0") + time
    t = Math.floor(t / 32)
  }
  // 80 bits -> 16 chars de 5 bits
  let acc = 0
  let bits = 0
  let random = ""
  for (let i = 0; i < RANDOM_BYTES; i++) {
    acc = (acc << 8) | (randomBytes[i] ?? 0)
    bits += 8
    while (bits >= 5) {
      bits -= 5
      random += ALPHABET[(acc >> bits) & 31]
      acc &= (1 << bits) - 1
    }
  }
  return (time + random).slice(0, TIME_LEN + RANDOM_LEN)
}

/** Milisegundos codificados en el prefijo de un ULID; NaN si no es un ULID. */
export function ulidTime(id: string): number {
  let t = 0
  for (let i = 0; i < TIME_LEN; i++) {
    const idx = ALPHABET.indexOf(id.charAt(i))
    if (idx < 0) return Number.NaN
    t = t * 32 + idx
  }
  return t
}
