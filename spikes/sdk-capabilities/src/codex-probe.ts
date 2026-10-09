/**
 * Probe del Codex SDK. Misma pregunta que el de Claude, en su superficie:
 *
 *  1. ¿Con qué se autentica si Keel no toca credenciales? (lo que el CLI
 *     `codex` ya tenga; la SDK inyecta variables sobre el entorno que le damos)
 *  2. ¿Qué trae `usage` en turn.completed? ¿Hay costo en USD?
 *  3. ¿Qué tipos de item emite y traen ids que permitan correlación?
 *
 * Uso: bun src/codex-probe.ts
 */
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { Codex } from "@openai/codex-sdk"
import { now, openCapture, writeReport } from "./capture.js"

const here = dirname(fileURLToPath(import.meta.url))
const events = openCapture("codex-events")

const apiKeyInEnv = Boolean(process.env.OPENAI_API_KEY || process.env.CODEX_API_KEY)
const itemTypes: Record<string, number> = {}
const eventTypes: Record<string, number> = {}
let usage: unknown = null
let threadId: string | null = null
let error: string | null = null
const idFields = new Set<string>()

const startedAt = Date.now()
try {
  const env = Object.fromEntries(
    Object.entries(process.env).filter((e): e is [string, string] => typeof e[1] === "string"),
  )
  const codex = new Codex({ env })
  const thread = codex.startThread({ workingDirectory: join(here, ".."), skipGitRepoCheck: true })
  const { events: stream } = await thread.runStreamed(
    "Lista los archivos de la carpeta src/ de este directorio y responde con una sola línea con los nombres separados por coma. No hagas nada más.",
  )
  for await (const ev of stream) {
    const e = ev as Record<string, unknown> & { type: string }
    eventTypes[e.type] = (eventTypes[e.type] ?? 0) + 1
    events.write({ received_at: now(), ...e })
    const item = e.item as Record<string, unknown> | undefined
    if (item && typeof item.type === "string") {
      itemTypes[item.type] = (itemTypes[item.type] ?? 0) + 1
      for (const k of Object.keys(item)) if (/id$/i.test(k)) idFields.add(`${item.type}.${k}`)
    }
    if (e.type === "turn.completed") usage = e.usage ?? null
    if (typeof e.thread_id === "string") threadId = e.thread_id
  }
  threadId ??= thread.id ?? null
} catch (err) {
  error = err instanceof Error ? err.message : String(err)
  console.error("La corrida de Codex falló:", error)
}

const report = {
  spike: "codex-sdk",
  ran_at: now(),
  wall_ms: Date.now() - startedAt,
  api_key_in_env: apiKeyInEnv,
  thread_id: threadId,
  error,
  usage,
  event_types: eventTypes,
  item_types: itemTypes,
  id_fields_seen: [...idFields].sort(),
  captures: { events: events.path },
}
const reportPath = writeReport("codex", report)
console.log(JSON.stringify(report, null, 2))
console.log(`\nreporte: ${reportPath}`)
