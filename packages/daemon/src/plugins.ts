/**
 * Host de plugins (ADR-0014 §3): cada intérprete corre en su propio proceso y
 * habla JSON-RPC por stdio. El daemon le pasa los eventos que coinciden con lo
 * que declara, y valida lo que devuelve contra el esquema y los permisos del
 * manifiesto. Hay tiempo límite; si el plugin cae, sólo se pierde su
 * interpretación. El proceso no recibe secretos: su entorno es mínimo.
 */
import type { Database } from "bun:sqlite"
import { createHash } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { isAbsolute, join, resolve } from "node:path"
import {
  matchesToolPattern,
  type PluginManifest,
  PluginManifestSchema,
  validateJsonSchema,
} from "@keel/core"
import { LineDecoder } from "./ipc/framing.js"
import type { SemanticDraft, SemanticProjector, SourceEvent } from "./semantic.js"
import type { EventRow } from "./store/repo.js"

export const PLUGIN_TIMEOUT_MS = 5_000
const MANIFEST = "keel-plugin.json"

type PluginRow = {
  id: string
  version: string
  path: string
  manifest_json: string
  sha256: string
  installed_by: string
  installed_at: string
  uninstalled_at: string | null
}

/** Hash fijo de la instalación: manifiesto más punto de entrada. */
export function pluginHash(dir: string, manifest: PluginManifest): string {
  const h = createHash("sha256").update(readFileSync(join(dir, MANIFEST)))
  for (const a of manifest.entry.args) {
    const f = isAbsolute(a) ? a : join(dir, a)
    if (existsSync(f)) h.update(readFileSync(f))
  }
  const cmd = isAbsolute(manifest.entry.command)
    ? manifest.entry.command
    : join(dir, manifest.entry.command)
  if (existsSync(cmd)) h.update(readFileSync(cmd))
  return h.digest("hex")
}

export function readManifest(dir: string): PluginManifest {
  const path = join(dir, MANIFEST)
  if (!existsSync(path)) throw new Error(`no hay ${MANIFEST} en ${dir}`)
  return PluginManifestSchema.parse(JSON.parse(readFileSync(path, "utf8")))
}

class PluginProcess {
  private proc: ReturnType<typeof Bun.spawn> | null = null
  private next = 1
  private readonly waiting = new Map<
    number,
    (r: { result?: unknown; error?: { message: string } }) => void
  >()
  readonly dir: string
  readonly manifest: PluginManifest
  constructor(dir: string, manifest: PluginManifest) {
    this.dir = dir
    this.manifest = manifest
  }

  private start(): void {
    const { command, args } = this.manifest.entry
    // Sin secretos ni la configuración del usuario: sólo PATH para encontrar su runtime.
    this.proc = Bun.spawn([command, ...args], {
      cwd: this.dir,
      env: { PATH: process.env.PATH ?? "" },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "ignore",
    })
    const decoder = new LineDecoder()
    const proc = this.proc
    void (async () => {
      for await (const chunk of proc.stdout as ReadableStream<Uint8Array>)
        for (const d of decoder.push(chunk))
          if (d.ok)
            try {
              const m = JSON.parse(d.line) as {
                id: number
                result?: unknown
                error?: { message: string }
              }
              this.waiting.get(m.id)?.(m)
              this.waiting.delete(m.id)
            } catch {
              // Una línea rota del plugin se ignora; su petición vencerá.
            }
    })()
    void proc.exited.then(() => {
      if (this.proc === proc) this.proc = null
      for (const [, w] of this.waiting) w({ error: { message: "el plugin terminó" } })
      this.waiting.clear()
    })
  }

  async request(method: string, params: unknown): Promise<unknown> {
    if (!this.proc) this.start()
    const proc = this.proc as NonNullable<typeof this.proc>
    const id = this.next++
    const answer = new Promise<{ result?: unknown; error?: { message: string } }>((resolve) =>
      this.waiting.set(id, resolve),
    )
    const stdin = proc.stdin as { write(s: string): void; flush(): void }
    stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`)
    stdin.flush()
    const timeout = new Promise<{ result?: unknown; error?: { message: string } }>((resolve) =>
      setTimeout(() => resolve({ error: { message: "tiempo agotado" } }), PLUGIN_TIMEOUT_MS),
    )
    const r = await Promise.race([answer, timeout])
    this.waiting.delete(id)
    if (r.error) {
      // Si no contestó o cayó, se mata: la próxima vez se lanza de nuevo.
      this.stop()
      throw new Error(r.error.message)
    }
    return r.result
  }

  stop(): void {
    this.proc?.kill()
    this.proc = null
  }
}

export type PluginHostDeps = {
  db: Database
  projector: SemanticProjector
  /** Evento del sistema (rechazos, caídas): para que se vea qué pasó. */
  emit: (row: EventRow, kind: string, payload: unknown) => void
}

export class PluginHost {
  private readonly deps: PluginHostDeps
  private readonly running = new Map<string, PluginProcess>()
  readonly status = new Map<string, string>()
  constructor(deps: PluginHostDeps) {
    this.deps = deps
  }

  installed(): PluginRow[] {
    return this.deps.db
      .query<PluginRow, []>("SELECT * FROM plugins WHERE uninstalled_at IS NULL ORDER BY id")
      .all()
  }

  install(dir: string, actor: string): PluginRow {
    const abs = resolve(dir)
    const manifest = readManifest(abs)
    const sha = pluginHash(abs, manifest)
    this.uninstall(manifest.id)
    this.deps.db
      .query(
        "INSERT OR REPLACE INTO plugins(id, version, path, manifest_json, sha256, installed_by, uninstalled_at) VALUES (?,?,?,?,?,?,NULL)",
      )
      .run(manifest.id, manifest.version, abs, JSON.stringify(manifest), sha, actor)
    this.status.set(manifest.id, "ok")
    return this.installed().find((p) => p.id === manifest.id) as PluginRow
  }

  uninstall(id: string): boolean {
    this.running.get(id)?.stop()
    this.running.delete(id)
    const r = this.deps.db
      .query(
        "UPDATE plugins SET uninstalled_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ? AND uninstalled_at IS NULL",
      )
      .run(id)
    return r.changes > 0
  }

  stopAll(): void {
    for (const p of this.running.values()) p.stop()
    this.running.clear()
  }

  view(p: PluginRow) {
    return {
      id: p.id,
      version: p.version,
      path: p.path,
      sha256: p.sha256,
      manifest: JSON.parse(p.manifest_json) as PluginManifest,
      status: this.status.get(p.id) ?? "ok",
    }
  }

  /** ¿Le interesa este evento al plugin? Por nombre de tool o por tipo de evento. */
  private matches(m: PluginManifest, e: SourceEvent): boolean {
    if (m.recognizes.event_kinds.includes(e.kind)) return true
    let tool: string | null = null
    if (e.kind === "hook.PostToolUse" || e.kind === "hook.PostToolUseFailure")
      tool = String(e.payload.tool_name ?? "")
    else if (e.kind === "codex.app.item/completed") {
      const item = (e.payload.item ?? {}) as { type?: string; server?: string; tool?: string }
      if (item.type === "mcpToolCall") tool = `mcp__${item.server}__${item.tool}`
    }
    return tool !== null && m.recognizes.tools.some((p) => matchesToolPattern(p, tool as string))
  }

  /** Un evento recién guardado: a cada plugin que lo reconoce. Nunca lanza. */
  async onEvent(row: EventRow): Promise<number> {
    let stored = 0
    let source: SourceEvent | null = null
    for (const p of this.installed()) {
      const manifest = JSON.parse(p.manifest_json) as PluginManifest
      source ??= this.deps.projector.sourceOf(row)
      if (!this.matches(manifest, source)) continue
      // La instalación es con hash fijo: si el plugin cambió en disco, no corre.
      if (pluginHash(p.path, manifest) !== p.sha256) {
        this.status.set(
          p.id,
          "el plugin cambió desde que se instaló; reinstálalo para confiar en él",
        )
        this.deps.emit(row, "plugin.rejected", {
          plugin: p.id,
          reason: "hash distinto del instalado",
        })
        continue
      }
      let proc = this.running.get(p.id)
      if (!proc) {
        proc = new PluginProcess(p.path, manifest)
        this.running.set(p.id, proc)
      }
      let result: { events?: SemanticDraft[] }
      try {
        result = ((await proc.request("interpret", {
          keel_api: manifest.keel_api,
          event: {
            id: source.id,
            kind: source.kind,
            run_id: source.run_id,
            payload: source.payload,
          },
        })) ?? {}) as { events?: SemanticDraft[] }
        this.status.set(p.id, "ok")
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e)
        this.status.set(p.id, `falló: ${reason}`)
        this.deps.emit(row, "plugin.failed", { plugin: p.id, reason })
        continue
      }
      for (const d of result.events ?? []) {
        const problem = this.check(manifest, d)
        if (problem) {
          this.deps.emit(row, "plugin.rejected", {
            plugin: p.id,
            kind: d?.kind ?? null,
            reason: problem,
          })
          continue
        }
        if (
          this.deps.projector.storeExternal(
            { name: p.id, version: p.version },
            row,
            {
              key: `${row.id}:${String(d.key)}`,
              kind: d.kind,
              coverage: d.coverage === "inferred" ? "inferred" : "observed",
              payload: d.payload,
              source_event_ids: [row.id],
              tool_use_id:
                typeof source.payload.tool_use_id === "string" ? source.payload.tool_use_id : null,
            },
            manifest.emits.find((x) => x.kind === d.kind)?.schema_version ?? 1,
          )
        )
          stored++
      }
    }
    return stored
  }

  /** Lo que devuelve un plugin vale sólo si declaró ese tipo, tiene permiso y valida. */
  private check(m: PluginManifest, d: SemanticDraft | undefined): string | null {
    if (!d || typeof d.kind !== "string") return "evento sin kind"
    if (!m.permissions.includes("events:emit")) return "el plugin no tiene permiso events:emit"
    const declared = m.emits.find((x) => x.kind === d.kind)
    if (!declared) return `el plugin no declara ${d.kind}`
    if (d.coverage === "instrumented") return "un plugin no puede declarar cobertura instrumented"
    return validateJsonSchema(declared.schema, d.payload)
  }
}
