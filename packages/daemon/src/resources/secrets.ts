/**
 * Secretos por referencia (ADR-0013 §1). Keel nunca guarda un valor: guarda
 * dónde está. Se resuelve sólo al ejecutar y se suelta al terminar; lo único
 * que se promete es que vive en memoria el menor tiempo posible (ADR-0003).
 *
 *   env:NOMBRE                      variable de entorno del daemon
 *   keychain:servicio/cuenta        llavero del sistema (libsecret o Keychain)
 *   op://bóveda/item/campo          1Password CLI (`op read`)
 *   vault:ruta#campo                HashiCorp Vault (`vault kv get -field`)
 */
import { spawnSync } from "node:child_process"

export class SecretError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "SecretError"
  }
}

function run(cmd: string, args: string[], what: string): string {
  const r = spawnSync(cmd, args, { encoding: "utf8", timeout: 15_000 })
  if (r.error) throw new SecretError(`${what}: ${cmd} no disponible (${r.error.message})`)
  // Nunca se incluye la salida en el error: podría ser el propio secreto.
  if (r.status !== 0) throw new SecretError(`${what}: ${cmd} terminó con ${r.status}`)
  return r.stdout.replace(/\r?\n$/, "")
}

export function resolveSecret(
  ref: string,
  env: Record<string, string | undefined> = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  if (ref.startsWith("env:")) {
    const v = env[ref.slice(4)]
    if (v === undefined || v === "")
      throw new SecretError(`la variable ${ref.slice(4)} no está definida`)
    return v
  }
  if (ref.startsWith("keychain:")) {
    const [service, account] = ref.slice(9).split("/")
    if (!service || !account) throw new SecretError("keychain:servicio/cuenta")
    if (platform === "darwin")
      return run(
        "security",
        ["find-generic-password", "-s", service, "-a", account, "-w"],
        "llavero",
      )
    if (platform === "linux")
      return run("secret-tool", ["lookup", "service", service, "account", account], "llavero")
    throw new SecretError("el llavero de esta plataforma aún no está soportado")
  }
  if (ref.startsWith("op://")) return run("op", ["read", ref], "1Password")
  if (ref.startsWith("vault:")) {
    const [path, field] = ref.slice(6).split("#")
    if (!path || !field) throw new SecretError("vault:ruta#campo")
    return run("vault", ["kv", "get", `-field=${field}`, path], "Vault")
  }
  throw new SecretError(`referencia de secreto desconocida: ${ref.split(":")[0]}`)
}

const MASK = "[secreto]"

/**
 * Redacción exacta (ADR-0013 §3): cada valor resuelto se borra de la salida
 * antes de guardar o mostrar nada, en cualquier string de la estructura.
 */
export function redactSecrets<T>(value: T, secrets: string[]): T {
  const live = secrets.filter((s) => s.length >= 4)
  if (live.length === 0) return value
  const scrub = (s: string) => live.reduce((acc, sec) => acc.split(sec).join(MASK), s)
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") return scrub(v)
    if (Array.isArray(v)) return v.map(walk)
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {}
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = walk(x)
      return out
    }
    return v
  }
  return walk(value) as T
}
