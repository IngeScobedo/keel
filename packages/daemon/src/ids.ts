import { encodeUlid } from "@keel/core"

/** ULID con reloj del daemon y entropía del sistema. */
export function ulid(now: number = Date.now()): string {
  const bytes = new Uint8Array(10)
  crypto.getRandomValues(bytes)
  return encodeUlid(now, bytes)
}

export function nowIso(): string {
  return new Date().toISOString()
}

export async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("")
}

/** JSON canónico (claves ordenadas) para hashes de request y de operación. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value))
}
function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys)
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(v as Record<string, unknown>).sort())
      out[k] = sortKeys((v as Record<string, unknown>)[k])
    return out
  }
  return v
}
