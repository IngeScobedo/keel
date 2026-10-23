/**
 * Capacidad de un solo uso para el puente `keel mcp` de un run (ADR-0009 §3).
 *
 * - El daemon guarda sólo el hash del token, en memoria.
 * - El valor viaja en un archivo `0600` dentro de un directorio `0700` del
 *   estado de Keel (en Windows, la ACL del perfil). La configuración MCP del
 *   proveedor lleva sólo la ruta, nunca el valor: la línea de comandos y el
 *   entorno del proveedor los puede leer el propio agente.
 * - Un solo uso: el puente lo lee, lo borra y lo presenta; una segunda
 *   presentación se rechaza. Al terminar el run, se revoca.
 */
import { randomBytes } from "node:crypto"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"

export type AgentBinding = { run_id: string; project_id: string; work_item_id: string }

export class AgentTokens {
  private readonly byHash = new Map<string, AgentBinding & { consumed: boolean }>()
  private readonly dir: string
  constructor(dir: string) {
    this.dir = dir
  }

  /** Emite el token del run y devuelve la ruta del archivo que lo contiene. */
  issue(binding: AgentBinding): { file: string } {
    this.revokeRun(binding.run_id)
    mkdirSync(this.dirFor(binding.run_id), { recursive: true, mode: 0o700 })
    const token = randomBytes(32).toString("base64url")
    const file = this.fileFor(binding.run_id)
    writeFileSync(file, token, { mode: 0o600 })
    this.byHash.set(hash(token), { ...binding, consumed: false })
    return { file }
  }

  /** Consume el token: la primera vez devuelve el vínculo; después, nunca más. */
  consume(token: string): AgentBinding | null {
    const entry = this.byHash.get(hash(token))
    if (!entry || entry.consumed) return null
    entry.consumed = true
    rmSync(this.fileFor(entry.run_id), { force: true })
    return { run_id: entry.run_id, project_id: entry.project_id, work_item_id: entry.work_item_id }
  }

  /** El run terminó: su token deja de servir y su archivo, si quedó, se borra. */
  revokeRun(runId: string): void {
    for (const [h, b] of this.byHash) if (b.run_id === runId) this.byHash.delete(h)
    rmSync(this.dirFor(runId), { recursive: true, force: true })
  }

  /**
   * Una carpeta por run: el sandbox del agente monta sólo la suya, nunca los
   * tokens de otros runs (ADR-0018 §3).
   */
  dirFor(runId: string): string {
    return join(this.dir, runId)
  }

  private fileFor(runId: string): string {
    return join(this.dirFor(runId), "run.token")
  }
}

function hash(token: string): string {
  return new Bun.CryptoHasher("sha256").update(token).digest("hex")
}
