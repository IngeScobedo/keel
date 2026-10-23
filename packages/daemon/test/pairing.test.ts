/**
 * ADR-0009 §4 y §5: emparejamiento de sesiones externas y peticiones de run.
 * Daemon, git y SQLite reales; el proveedor es la corrida grabada del spike.
 */
import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
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

let n = 0
const key = () => `pair-${++n}`
const meta = () => ({ request_id: "r", idempotency_key: key() })

async function boot() {
  const dir = mkdtempSync(join(tmpdir(), "keel-pair-"))
  dirs.push(dir)
  initRepo(join(dir, "repo"))
  const daemon = new Daemon({
    dbPath: join(dir, "keel.sqlite"),
    socketPath: join(dir, "keel.sock"),
    rootPath: join(dir, "repo"),
    worktreesDir: join(dir, "worktrees"),
    adapterDeps: { queryFn: replayQuery(), binary: "/fake/claude" },
    // el run del agente que pide y el run aprobado conviven
    limits: { max_concurrent_runs: 2 },
    mcpBridge: false,
  })
  daemon.start()
  daemons.push(daemon)
  const connect = async () => {
    const c = await IpcClient.connect(daemon.server.path)
    clients.push(c)
    return c
  }
  const human = await connect()
  const pid = daemon.project.project_id
  const task = daemon.repo.createWorkItem({ project_id: pid, title: "tarea", kind: "chore" })
  const other = daemon.repo.createWorkItem({ project_id: pid, title: "otra", kind: "chore" })
  /** Un agente de un run de Keel, vinculado con su token. */
  const runAgent = async () => {
    const run = daemon.repo.createRun({ project_id: pid, work_item_id: task.id, purpose: "plan" })
    const { file } = daemon.agentTokens.issue({
      run_id: run.id,
      project_id: pid,
      work_item_id: task.id,
    })
    const c = await connect()
    await c.call("session.bind_agent", { token: readFileSync(file, "utf8") })
    return { client: c, run }
  }
  /** Una sesión externa que pide emparejamiento. */
  const external = async () => {
    const c = await connect()
    const p = (await c.call("session.pair", { client_name: "codex a mano", cwd: "/x" })) as {
      id: string
      code: string
    }
    return { client: c, pairing: p }
  }
  return { daemon, human, task, other, runAgent, external }
}

describe("ADR-0009 §4: emparejamiento de sesiones externas", () => {
  test("mientras espera, la conexión no es humana ni agente: sólo ve su estado", async () => {
    const { external } = await boot()
    const { client, pairing } = await external()
    expect(pairing.code).toMatch(/^[A-Z2-9]{6}$/)
    await expect(client.call("work_items.list", {})).rejects.toThrow("espera la aprobación")
    await expect(
      client.call("work_items.create", { ...meta(), title: "x", kind: "chore" }),
    ).rejects.toThrow("espera la aprobación")
    expect(await client.call("session.pair_status", {})).toMatchObject({ state: "pending" })
  })

  test("aprobada con scopes acotados, la sesión sólo hace lo que esos scopes permiten", async () => {
    const { human, task, external } = await boot()
    const { client, pairing } = await external()
    await human.call("session.pair_resolve", {
      ...meta(),
      pairing_id: pairing.id,
      decision: "approve",
      work_item_id: task.id,
      scopes: ["tasks:read"],
    })
    const list = (await client.call("work_items.list", {})) as { items: unknown[] }
    expect(list.items.length).toBe(2)
    await expect(
      client.call("notes.add", { ...meta(), work_item_id: task.id, content_markdown: "x" }),
    ).rejects.toThrow("scope notes:write")
    await expect(
      client.call("work_items.transition", { ...meta(), work_item_id: task.id, to: "planned" }),
    ).rejects.toThrow("un agente no puede usar")
  })

  test("sin tarea vinculada, la sesión no puede escribir notas ni handoffs", async () => {
    const { human, task, external } = await boot()
    const { client, pairing } = await external()
    await human.call("session.pair_resolve", {
      ...meta(),
      pairing_id: pairing.id,
      decision: "approve",
    })
    await expect(
      client.call("notes.add", { ...meta(), work_item_id: task.id, content_markdown: "x" }),
    ).rejects.toThrow("tarea que tiene vinculada")
    await expect(
      client.call("handoffs.request", { ...meta(), title: "t", summary_markdown: "s" }),
    ).rejects.toThrow("tarea vinculada")
  })

  test("rechazada, la sesión sigue sin poder hacer nada y lo sabe", async () => {
    const { human, external } = await boot()
    const { client, pairing } = await external()
    await human.call("session.pair_resolve", {
      ...meta(),
      pairing_id: pairing.id,
      decision: "reject",
    })
    expect(await client.call("session.pair_status", {})).toMatchObject({ state: "rejected" })
    await expect(client.call("work_items.list", {})).rejects.toThrow("espera la aprobación")
  })

  test("sólo un humano resuelve, y no se aprueba una sesión que ya se fue", async () => {
    const { daemon, human, external, runAgent } = await boot()
    const { client, pairing } = await external()
    const agent = await runAgent()
    await expect(
      agent.client.call("session.pair_resolve", {
        ...meta(),
        pairing_id: pairing.id,
        decision: "approve",
      }),
    ).rejects.toThrow("un agente no puede usar")
    client.close()
    for (let i = 0; i < 50 && daemon.repo.getPairing(pairing.id)?.state !== "closed"; i++)
      await Bun.sleep(10)
    await expect(
      human.call("session.pair_resolve", {
        ...meta(),
        pairing_id: pairing.id,
        decision: "approve",
      }),
    ).rejects.toThrow()
    expect(daemon.repo.getPairing(pairing.id)?.state).toBe("closed")
  })
})

describe("ADR-0009 §5: runs.request", () => {
  test("un agente pide un run, no puede arrancarlo, y el humano lo aprueba con las reglas de runs.start", async () => {
    const { daemon, human, other, runAgent } = await boot()
    const { client } = await runAgent()
    await expect(
      client.call("runs.start", { ...meta(), work_item_id: other.id, purpose: "plan" }),
    ).rejects.toThrow("un agente no puede usar")
    const req = (await client.call("runs.request", {
      ...meta(),
      work_item_id: other.id,
      purpose: "plan",
      reason: "hay que planear la otra",
    })) as { id: string; state: string; requested_by: string }
    expect(req.state).toBe("pending")
    expect(req.requested_by).toStartWith("agent:")
    await expect(
      client.call("runs.request_resolve", {
        ...meta(),
        run_request_id: req.id,
        decision: "approve",
      }),
    ).rejects.toThrow("un agente no puede usar")

    const pending = (await human.call("runs.requests_list", { state: "pending" })) as {
      requests: { id: string }[]
    }
    expect(pending.requests.map((r) => r.id)).toEqual([req.id])
    const done = (await human.call("runs.request_resolve", {
      ...meta(),
      run_request_id: req.id,
      decision: "approve",
    })) as { request: { state: string; run_id: string }; run: { id: string; purpose: string } }
    expect(done.request.state).toBe("started")
    expect(done.run.purpose).toBe("plan")
    expect(done.request.run_id).toBe(done.run.id)
    await daemon.idle()
    expect(daemon.repo.getRun(done.run.id)?.status).toBe("completed")
  })

  test("si la tarea no es elegible, aprobar falla y la petición sigue pendiente", async () => {
    const { daemon, human, other, runAgent } = await boot()
    const { client } = await runAgent()
    // `execute` arranca desde planned; la tarea está en triage
    const req = (await client.call("runs.request", {
      ...meta(),
      work_item_id: other.id,
      purpose: "execute",
      reason: "implementar",
    })) as { id: string }
    await expect(
      human.call("runs.request_resolve", {
        ...meta(),
        run_request_id: req.id,
        decision: "approve",
      }),
    ).rejects.toThrow("arranca desde planned")
    expect(daemon.repo.getRunRequest(req.id)?.state).toBe("pending")
    const rejected = (await human.call("runs.request_resolve", {
      ...meta(),
      run_request_id: req.id,
      decision: "reject",
    })) as { request: { state: string }; run: unknown }
    expect(rejected).toMatchObject({ request: { state: "rejected" }, run: null })
  })

  test("un humano usa runs.start, no runs.request", async () => {
    const { human, other } = await boot()
    await expect(
      human.call("runs.request", {
        ...meta(),
        work_item_id: other.id,
        purpose: "plan",
        reason: "x",
      }),
    ).rejects.toThrow("un humano usa runs.start")
  })
})
