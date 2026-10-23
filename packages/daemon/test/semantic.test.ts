/**
 * ADR-0011: eventos semánticos como proyección de los de origen, con
 * cobertura declarada y reconstruibles. Daemon y SQLite reales.
 */
import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Daemon, IpcClient } from "../src/index.ts"
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
  const dir = mkdtempSync(join(tmpdir(), "keel-sem-"))
  dirs.push(dir)
  initRepo(join(dir, "repo"))
  const daemon = new Daemon({
    dbPath: join(dir, "keel.sqlite"),
    socketPath: join(dir, "keel.sock"),
    rootPath: join(dir, "repo"),
    worktreesDir: join(dir, "worktrees"),
    adapterDeps: { queryFn: replayQuery(), binary: "/fake/claude" },
    mcpBridge: false,
  })
  daemon.start()
  daemons.push(daemon)
  const human = await IpcClient.connect(daemon.server.path)
  clients.push(human)
  const pid = daemon.project.project_id
  const w = daemon.repo.createWorkItem({ project_id: pid, title: "auditoría", kind: "research" })
  const run = daemon.repo.createRun({ project_id: pid, work_item_id: w.id, purpose: "plan" })
  let n = 0
  /** Un evento de origen como lo guarda el adaptador, y su paso por el bus. */
  const ingest = (kind: string, payload: unknown) => {
    const row = daemon.repo.appendEvent({
      project_id: pid,
      run_id: run.id,
      source: "claude-agent-sdk",
      source_event_key: `k${++n}`,
      fidelity: "full",
      adapter_version: "t",
      kind,
      occurred_at: null,
      payload_json: JSON.stringify(payload),
    })
    if (row)
      daemon.bus.publish({
        event_seq: row.event_seq,
        kind,
        project_id: pid,
        run_id: run.id,
        received_at: row.received_at,
        payload,
      })
  }
  const list = async (q: Record<string, unknown> = {}) =>
    (
      (await human.call("semantic.list", { run_id: run.id, ...q })) as {
        events: {
          kind: string
          coverage: string
          interpreter: string
          payload: Record<string, unknown>
          artifact_refs: string[]
          work_item_id: string
          tool_use_id: string | null
        }[]
      }
    ).events
  return { daemon, human, ingest, list, w, run }
}

describe("ADR-0011: eventos semánticos", () => {
  test("una consulta MCP a PostgreSQL produce database.query.completed observed, con filas y artefacto", async () => {
    const { human, ingest, list, w } = await boot()
    const rows = [
      { id: 1, concepto: "caja", monto: 30000 },
      { id: 2, concepto: "banco", monto: -30000 },
    ]
    ingest("hook.PostToolUse", {
      hook_event_name: "PostToolUse",
      tool_name: "mcp__postgres__query",
      tool_use_id: "toolu_sql1",
      tool_input: { sql: "select * from movimientos where monto <> 0" },
      tool_response: { content: [{ type: "text", text: JSON.stringify(rows) }] },
    })
    const [q] = await list()
    expect(q).toMatchObject({
      kind: "database.query.completed",
      coverage: "observed",
      interpreter: "mcp-sql@1",
      work_item_id: w.id,
      tool_use_id: "toolu_sql1",
      payload: {
        server: "postgres",
        query: "select * from movimientos where monto <> 0",
        row_count: 2,
        columns: ["id", "concepto", "monto"],
      },
    })
    expect(q?.artifact_refs).toHaveLength(1)
    const table = (await human.call("artifacts.read", {
      ref: q?.payload.result_ref as string,
    })) as {
      data_base64: string
      media_type: string
    }
    expect(table.media_type).toBe("application/vnd.keel.table+json")
    expect(JSON.parse(Buffer.from(table.data_base64, "base64").toString()).rows).toEqual([
      [1, "caja", 30000],
      [2, "banco", -30000],
    ])
  })

  test("un psql dentro de Bash produce como mucho un evento inferred, sin filas", async () => {
    const { ingest, list } = await boot()
    ingest("hook.PostToolUse", {
      tool_name: "Bash",
      tool_use_id: "toolu_b1",
      tool_input: { command: `psql "$DATABASE_URL" -c "select sum(monto) from movimientos"` },
      tool_response: { stdout: " sum \n-----\n 0\n(1 row)", stderr: "" },
    })
    const events = await list()
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      kind: "database.query.completed",
      coverage: "inferred",
      payload: { tool: "psql", query: "select sum(monto) from movimientos", row_count: null },
    })
    expect(events.some((e) => e.coverage === "observed")).toBe(false)
  })

  test("git commit y push por shell quedan inferred con lo que dice su salida", async () => {
    const { ingest, list } = await boot()
    ingest("hook.PostToolUse", {
      tool_name: "Bash",
      tool_use_id: "toolu_g1",
      tool_input: { command: "git commit -am 'arregla el cuadre'" },
      tool_response: {
        stdout: "[keel/KEEL-1/x 1a2b3c4] arregla el cuadre\n 1 file changed",
        stderr: "",
      },
    })
    ingest("hook.PostToolUse", {
      tool_name: "Bash",
      tool_use_id: "toolu_g2",
      tool_input: { command: "git push origin keel/KEEL-1/x" },
      tool_response: { stdout: "", stderr: "   1a2b3c4..5d6e7f8  keel/KEEL-1/x -> keel/KEEL-1/x" },
    })
    const kinds = (await list()).map((e) => [e.kind, e.coverage, e.payload])
    expect(kinds).toEqual([
      [
        "git.commit.created",
        "inferred",
        {
          sha: "1a2b3c4",
          message: "arregla el cuadre",
          files: null,
          branch: "keel/KEEL-1/x",
          worktree: null,
        },
      ],
      [
        "git.push.completed",
        "inferred",
        { remote: "origin", ref: "keel/KEEL-1/x", old_sha: "1a2b3c4", new_sha: "5d6e7f8" },
      ],
    ])
  })

  test("borrar la proyección y reconstruirla desde events da el mismo resultado", async () => {
    const { human, ingest, list } = await boot()
    ingest("hook.PostToolUse", {
      tool_name: "mcp__pg__execute",
      tool_use_id: "t1",
      tool_input: { query: "select 1 as uno" },
      tool_response: { content: [{ type: "text", text: '[{"uno":1}]' }] },
    })
    ingest("hook.PostToolUse", {
      tool_name: "Bash",
      tool_use_id: "t2",
      tool_input: { command: "psql -c 'select 2'" },
      tool_response: { stdout: "2" },
    })
    const strip = (es: Awaited<ReturnType<typeof list>>) =>
      es.map(({ ...e }) => {
        const { seq: _s, ...rest } = e as typeof e & { seq: number }
        return rest
      })
    const before = strip(await list())
    expect(before).toHaveLength(2)
    const rebuilt = (await human.call("semantic.rebuild", { ...meta() })) as { events: number }
    expect(rebuilt.events).toBe(2)
    expect(strip(await list())).toEqual(before)
  })

  test("un payload que no valida su esquema se guarda como genérico, nunca se descarta", async () => {
    const { daemon, list, run } = await boot()
    // Un evento de Keel con un kind semántico pero un payload mal formado.
    daemon.repo.appendEvent({
      project_id: daemon.project.project_id,
      run_id: run.id,
      source: "keel",
      source_event_key: "bad",
      fidelity: "full",
      adapter_version: "t",
      kind: "git.push.completed",
      occurred_at: null,
      payload_json: JSON.stringify({ remote: 42 }),
    })
    daemon.semantic.rebuild()
    const [e] = await list()
    expect(e).toMatchObject({
      kind: "generic.unvalidated",
      coverage: "instrumented",
      payload: { intended_kind: "git.push.completed" },
    })
  })
})
