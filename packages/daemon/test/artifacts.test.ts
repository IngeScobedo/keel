/**
 * ADR-0012: artefactos direccionados por contenido, evidencia con procedencia,
 * respaldo con hashes y `cursor_expired`. Daemon, git y SQLite reales.
 */
import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ArtifactStore, backupStore, Daemon, IpcClient, restoreStore } from "../src/index.ts"
import { initRepo } from "./git-fixture.ts"
import { replayQuery } from "./replay.ts"

const dirs: string[] = []
const daemons: Daemon[] = []
const clients: IpcClient[] = []
afterEach(async () => {
  for (const c of clients.splice(0)) c.close()
  for (const d of daemons.splice(0)) {
    await d.idle()
    d.stop()
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
const meta = () => ({ request_id: "r", idempotency_key: crypto.randomUUID() })

async function boot() {
  const dir = mkdtempSync(join(tmpdir(), "keel-art-"))
  dirs.push(dir)
  initRepo(join(dir, "repo"))
  const daemon = new Daemon({
    dbPath: join(dir, "keel.sqlite"),
    socketPath: join(dir, "keel.sock"),
    rootPath: join(dir, "repo"),
    worktreesDir: join(dir, "worktrees"),
    artifactsDir: join(dir, "artifacts"),
    adapterDeps: { queryFn: replayQuery(), binary: "/fake/claude" },
    mcpBridge: false,
  })
  daemon.start()
  daemons.push(daemon)
  const human = await IpcClient.connect(daemon.server.path)
  clients.push(human)
  return { dir, daemon, human }
}
const files = (root: string): string[] =>
  existsSync(root)
    ? readdirSync(root, { recursive: true, withFileTypes: true })
        .filter((d) => d.isFile())
        .map((d) => d.name)
    : []

describe("ADR-0012: artefactos", () => {
  test("un payload de 1 MiB queda como artefacto; el evento lleva preview válido y el hash coincide", async () => {
    const { dir, daemon, human } = await boot()
    const big = { blob: "x".repeat(1024 * 1024) }
    const e = daemon.repo.appendEvent({
      project_id: daemon.project.project_id,
      run_id: null,
      source: "test",
      source_event_key: "big",
      fidelity: "full",
      adapter_version: "t",
      kind: "test.big",
      occurred_at: null,
      payload_json: JSON.stringify(big),
    })
    const preview = JSON.parse(e?.payload_json ?? "{}") as {
      keel_preview: number
      body_ref: string
      sha256: string
      bytes: number
    }
    expect(preview.keel_preview).toBe(1)
    expect(preview.body_ref).toStartWith("artifact:sha256:")
    expect(preview.body_ref.slice(16)).toBe(preview.sha256)
    // Se lee por partes y el último trozo confirma la integridad.
    let offset = 0
    const parts: Buffer[] = []
    for (;;) {
      const r = (await human.call("artifacts.read", {
        ref: preview.body_ref,
        offset,
        length: 300_000,
      })) as { data_base64: string; eof: boolean; integrity: string }
      const chunk = Buffer.from(r.data_base64, "base64")
      parts.push(chunk)
      offset += chunk.length
      if (r.eof) {
        expect(r.integrity).toBe("ok")
        break
      }
    }
    expect(Buffer.concat(parts).toString("utf8")).toBe(JSON.stringify(big))
    expect(files(join(dir, "artifacts"))).toHaveLength(1)
  })

  test("el mismo contenido dos veces deja un solo archivo; uno alterado se marca", async () => {
    const { dir, daemon } = await boot()
    const a = daemon.artifacts.put("hola", "text/plain")
    const b = daemon.artifacts.put(Buffer.from("hola"), "text/plain")
    expect(a.ref).toBe(b.ref)
    expect(files(join(dir, "artifacts"))).toHaveLength(1)
    writeFileSync(daemon.artifacts.pathOf(a.sha256), "adiós")
    expect(daemon.artifacts.verify(a.sha256)).toBe("mismatch")
    expect(daemon.artifacts.get(a.sha256)?.integrity).toBe("mismatch")
  })

  test("un respaldo restaurado verifica todos los hashes; uno alterado no se restaura", async () => {
    const { dir, daemon } = await boot()
    daemon.artifacts.put("uno", "text/plain")
    daemon.artifacts.put("dos", "text/plain")
    const { manifestPath, manifest } = backupStore(daemon.store, join(dir, "backup"), {
      artifactsDir: join(dir, "artifacts"),
    })
    expect(manifest.artifacts).toHaveLength(2)
    const report = restoreStore(manifestPath, join(dir, "restored", "keel.sqlite"), {
      artifactsDir: join(dir, "restored", "artifacts"),
    })
    expect(report.artifacts_verified).toBe(2)
    expect(files(join(dir, "restored", "artifacts"))).toHaveLength(2)
    const first = manifest.artifacts?.[0]?.sha256 as string
    const copy = new ArtifactStore(
      join(dir, "backup", `${manifest.file}.artifacts`),
      daemon.store.db,
    )
    writeFileSync(copy.pathOf(first), "alterado")
    expect(() => restoreStore(manifestPath, join(dir, "otra", "keel.sqlite"))).toThrow(
      "no coincide con su hash",
    )
  })
})

describe("ADR-0012: evidencia y retención", () => {
  test("el humano adjunta evidencia sin run; una corrección apunta a la anterior; se lista con procedencia", async () => {
    const { daemon, human } = await boot()
    const w = (await human.call("work_items.create", { ...meta(), title: "t", kind: "chore" })) as {
      id: string
    }
    const first = (await human.call("evidence.attach", {
      ...meta(),
      work_item_id: w.id,
      kind: "document",
      title: "nota",
      content_base64: Buffer.from("v1").toString("base64"),
      media_type: "text/plain",
    })) as { id: string; run_id: string | null; provenance: { actor: { kind: string } } }
    expect(first.run_id).toBeNull()
    expect(first.provenance.actor.kind).toBe("human")
    await human.call("evidence.attach", {
      ...meta(),
      work_item_id: w.id,
      kind: "document",
      content_base64: Buffer.from("v2").toString("base64"),
      supersedes_id: first.id,
    })
    const list = (await human.call("evidence.list", { work_item_id: w.id })) as {
      evidence: { id: string; supersedes_id: string | null; size: number }[]
    }
    expect(list.evidence).toHaveLength(2)
    expect(list.evidence[0]?.supersedes_id).toBe(first.id)
    expect(list.evidence[0]?.size).toBe(2)
    // Append-only: la base no admite borrar evidencia salvo por la purga que la nombra.
    expect(daemon.repo.getEvidence(first.id)).not.toBeNull()
  })

  test("tras purgar, un cursor anterior recibe cursor_expired con el mínimo; lo huérfano se recolecta", async () => {
    const { daemon, human } = await boot()
    const pid = daemon.project.project_id
    // Eventos viejos con su cuerpo grande ya en el almacén (los eventos no se editan).
    for (let i = 0; i < 3; i++) {
      const { json } = daemon.repo.spill(
        JSON.stringify({ blob: `${i}`.repeat(300 * 1024) }),
        `event:old-${i}`,
      )
      daemon.store.db
        .query(
          `INSERT INTO events(id, project_id, run_id, source, source_event_key, fidelity, adapter_version,
             kind, occurred_at, received_at, payload_json)
           VALUES (?, ?, NULL, 'test', ?, 'full', 't', 'test.old', NULL, '2020-01-01T00:00:00.000Z', ?)`,
        )
        .run(`old-${i}`, pid, `e${i}`, json)
    }
    const dry = (await human.call("retention.purge", {
      ...meta(),
      older_than_days: 30,
      dry_run: true,
    })) as {
      events: number
    }
    expect(dry.events).toBe(3)
    const done = (await human.call("retention.purge", { ...meta(), older_than_days: 30 })) as {
      events: number
      artifacts: number
    }
    expect(done).toMatchObject({ events: 3, artifacts: 3 })
    type Rpc = { code: number; details: { min_cursor: number } }
    const err = (await human.call("events.subscribe", { project_id: pid, after_event_seq: 0 }).then(
      () => null,
      (e: { rpc?: Rpc }) => e.rpc ?? null,
    )) as Rpc | null
    expect(err?.code).toBe(-32009)
    const min = err?.details.min_cursor as number
    expect(min).toBeGreaterThan(0)
    const ok = (await human.call("events.subscribe", {
      project_id: pid,
      after_event_seq: min,
    })) as {
      cursor: number
    }
    expect(ok.cursor).toBeGreaterThanOrEqual(min)
  })
})
