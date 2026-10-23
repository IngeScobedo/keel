/**
 * ADR-0018 §2: dos puertas. Por la de agentes nada es humano: sin vincularse
 * sólo puede vincularse con su token o pedir emparejamiento. Daemon real.
 */
import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { agentDoorPath, Daemon, IpcClient } from "../src/index.ts"
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
  const dir = mkdtempSync(join(tmpdir(), "keel-door-"))
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
  const connect = async (path: string) => {
    const c = await IpcClient.connect(path)
    clients.push(c)
    return c
  }
  return { daemon, connect }
}

describe("ADR-0018 §2: puerta de agentes", () => {
  test("la puerta vive junto a la humana, con permisos sólo del usuario", async () => {
    const { daemon } = await boot()
    expect(daemon.agentServer.path).toBe(agentDoorPath(daemon.server.path))
    expect(daemon.agentServer.path).toEndWith("keel-agent.sock")
    if (process.platform !== "win32")
      expect(statSync(daemon.agentServer.path).mode & 0o777).toBe(0o600)
  })

  test("sin vincularse no es humana: no lee, no muta y no aprueba", async () => {
    const { daemon, connect } = await boot()
    const c = await connect(daemon.agentServer.path)
    for (const [method, params] of [
      ["work_items.list", {}],
      ["work_items.create", { ...meta(), title: "x", kind: "chore" }],
      ["approvals.list", {}],
      ["session.pair_resolve", { ...meta(), pairing_id: "x", decision: "approve" }],
      ["events.subscribe", { after_event_seq: 0 }],
      ["projects.open", { path: "/" }],
    ] as const)
      await expect(c.call(method, params)).rejects.toThrow("puerta de agentes")
    // daemon.health sí, sin exponer más que a un pendiente.
    expect(await c.call("daemon.health", {})).toMatchObject({ version: expect.any(String) })
  })

  test("se vincula con el token del run o pide emparejamiento; luego es agente", async () => {
    const { daemon, connect } = await boot()
    const pid = daemon.project.project_id
    const w = daemon.repo.createWorkItem({ project_id: pid, title: "t", kind: "chore" })
    const run = daemon.repo.createRun({ project_id: pid, work_item_id: w.id, purpose: "plan" })
    const { file } = daemon.agentTokens.issue({
      run_id: run.id,
      project_id: pid,
      work_item_id: w.id,
    })
    const bound = await connect(daemon.agentServer.path)
    expect(
      await bound.call("session.bind_agent", { token: readFileSync(file, "utf8") }),
    ).toMatchObject({
      actor_id: `agent:${run.id}`,
    })
    expect(((await bound.call("work_items.list", {})) as { items: unknown[] }).items).toHaveLength(
      1,
    )
    await expect(
      bound.call("work_items.transition", { ...meta(), work_item_id: w.id, to: "planned" }),
    ).rejects.toThrow("un agente no puede usar")

    const ext = await connect(daemon.agentServer.path)
    const pairing = (await ext.call("session.pair", { client_name: "a mano" })) as { id: string }
    const human = await connect(daemon.server.path)
    await human.call("session.pair_resolve", {
      ...meta(),
      pairing_id: pairing.id,
      decision: "approve",
    })
    expect(await ext.call("session.pair_status", {})).toMatchObject({ state: "approved" })
  })
})
