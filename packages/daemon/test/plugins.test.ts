/**
 * ADR-0014: plugins fuera de proceso. El de ejemplo convierte una llamada MCP
 * en un evento semántico; lo que viola su esquema se rechaza; si el proceso
 * cae, el daemon sigue; desinstalar no borra nada; un plugin alterado no corre.
 */
import { afterEach, describe, expect, test } from "bun:test"
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
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
const FIXTURE = join(import.meta.dir, "fixtures", "plugin-pagos")

async function boot() {
  const dir = mkdtempSync(join(tmpdir(), "keel-plug-"))
  dirs.push(dir)
  initRepo(join(dir, "repo"))
  const plugin = join(dir, "plugin")
  cpSync(FIXTURE, plugin, { recursive: true })
  const daemon = new Daemon({
    dbPath: join(dir, "keel.sqlite"),
    socketPath: join(dir, "keel.sock"),
    rootPath: join(dir, "repo"),
    adapterDeps: { queryFn: replayQuery(), binary: "/fake/claude" },
    mcpBridge: false,
  })
  daemon.start()
  daemons.push(daemon)
  const human = await IpcClient.connect(daemon.server.path)
  clients.push(human)
  const pid = daemon.project.project_id
  const w = daemon.repo.createWorkItem({ project_id: pid, title: "pagos", kind: "research" })
  const run = daemon.repo.createRun({ project_id: pid, work_item_id: w.id, purpose: "plan" })
  let n = 0
  const ingest = (input: Record<string, unknown>) => {
    const payload = {
      tool_name: "mcp__pagos__list_charges",
      tool_use_id: `t${++n}`,
      tool_input: input,
      tool_response: {
        content: [
          {
            type: "text",
            text: JSON.stringify([
              { amount: 100, currency: "MXN" },
              { amount: 250, currency: "MXN" },
            ]),
          },
        ],
      },
    }
    const row = daemon.repo.appendEvent({
      project_id: pid,
      run_id: run.id,
      source: "claude-agent-sdk",
      source_event_key: `k${n}`,
      fidelity: "full",
      adapter_version: "t",
      kind: "hook.PostToolUse",
      occurred_at: null,
      payload_json: JSON.stringify(payload),
    })
    if (row)
      daemon.bus.publish({
        event_seq: row.event_seq,
        kind: row.kind,
        project_id: pid,
        run_id: run.id,
        received_at: row.received_at,
        payload,
      })
  }
  const kinds = (k: string) =>
    daemon.repo
      .eventsAfter(0, null, 10_000)
      .filter((e) => e.kind === k)
      .map((e) => JSON.parse(e.payload_json))
  const semantic = async () =>
    (
      (await human.call("semantic.list", { run_id: run.id })) as {
        events: { kind: string; interpreter: string; coverage: string; payload: unknown }[]
      }
    ).events
  return { daemon, human, plugin, ingest, kinds, semantic }
}

describe("ADR-0014: plugins fuera de proceso", () => {
  test("el plugin de ejemplo convierte una llamada MCP en un evento semántico validado", async () => {
    const { daemon, human, plugin, ingest, semantic } = await boot()
    const installed = (await human.call("plugins.install", { ...meta(), path: plugin })) as {
      id: string
      sha256: string
      manifest: { visualizers: unknown[] }
    }
    expect(installed.id).toBe("pagos-demo")
    expect(installed.manifest.visualizers).toHaveLength(1)
    ingest({})
    await daemon.idle()
    expect(await semantic()).toEqual([
      expect.objectContaining({
        kind: "payments.charges.listed",
        interpreter: "pagos-demo@1.0.0",
        coverage: "observed",
        payload: { count: 2, total: 350, currency: "MXN" },
      }),
    ])
  })

  test("un evento que viola su esquema se rechaza y queda constancia", async () => {
    const { daemon, human, plugin, ingest, kinds, semantic } = await boot()
    await human.call("plugins.install", { ...meta(), path: plugin })
    ingest({ bad: true })
    await daemon.idle()
    expect(await semantic()).toHaveLength(0)
    expect(kinds("plugin.rejected")[0]).toMatchObject({
      plugin: "pagos-demo",
      kind: "payments.charges.listed",
    })
    expect(kinds("plugin.rejected")[0].reason).toContain("count")
  })

  test("si el proceso del plugin cae, el daemon sigue y la siguiente vez se relanza", async () => {
    const { daemon, human, plugin, ingest, kinds, semantic } = await boot()
    await human.call("plugins.install", { ...meta(), path: plugin })
    ingest({ crash: true })
    await daemon.idle()
    expect(kinds("plugin.failed")[0]).toMatchObject({ plugin: "pagos-demo" })
    expect((await human.call("daemon.health", {})) as { version: string }).toHaveProperty("version")
    ingest({})
    await daemon.idle()
    expect((await semantic()).map((e) => e.kind)).toEqual(["payments.charges.listed"])
  })

  test("desinstalar no borra lo interpretado; un plugin alterado en disco no corre", async () => {
    const { daemon, human, plugin, ingest, kinds, semantic } = await boot()
    await human.call("plugins.install", { ...meta(), path: plugin })
    ingest({})
    await daemon.idle()
    await human.call("plugins.uninstall", { ...meta(), id: "pagos-demo" })
    expect(await semantic()).toHaveLength(1)
    expect(((await human.call("plugins.list", {})) as { plugins: unknown[] }).plugins).toHaveLength(
      0,
    )

    await human.call("plugins.install", { ...meta(), path: plugin })
    writeFileSync(join(plugin, "interpreter.ts"), "process.exit(0)\n")
    ingest({})
    await daemon.idle()
    expect(kinds("plugin.rejected").at(-1)).toMatchObject({ reason: "hash distinto del instalado" })
    expect(await semantic()).toHaveLength(1)
  })
})
