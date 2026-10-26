/** ADR-0027: cerrar a mano una tarea, con su motivo y su evidencia. */
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
const meta = () => ({ request_id: "r", idempotency_key: crypto.randomUUID() })

async function boot() {
  const dir = mkdtempSync(join(tmpdir(), "keel-close-"))
  dirs.push(dir)
  const daemon = new Daemon({
    dbPath: join(dir, "keel.sqlite"),
    socketPath: join(dir, "keel.sock"),
    rootPath: initRepo(join(dir, "repo")),
    worktreesDir: join(dir, "worktrees"),
    adapterDeps: { queryFn: replayQuery(), binary: "/fake/claude" },
    mcpBridge: false,
  })
  daemon.start()
  daemons.push(daemon)
  const human = await IpcClient.connect(daemon.server.path)
  clients.push(human)
  return { daemon, human }
}

describe("ADR-0027: cierre a mano", () => {
  test("una tarea planificada se cierra con motivo y enlace; queda la evidencia", async () => {
    const { daemon, human } = await boot()
    const w = (await human.call("work_items.create", {
      ...meta(),
      title: "Revisar capítulos",
      kind: "bug",
    })) as { id: string; revision: number }
    const planned = (await human.call("work_items.transition", {
      ...meta(),
      work_item_id: w.id,
      to: "planned",
    })) as { revision: number }
    const bad = await human
      .call("work_items.close", { ...meta(), work_item_id: w.id, reason: "hecha", evidence: {} })
      .catch((e: Error) => e.message)
    expect(String(bad)).toContain("params inválidos")
    const closed = (await human.call("work_items.close", {
      ...meta(),
      work_item_id: w.id,
      expected_revision: planned.revision,
      reason: "se hizo fuera de Keel con la PR",
      evidence: { url: "https://github.com/inprodiwebstudio/casa-matte-monorepo/pull/126" },
    })) as { lifecycle: string; board_status: string }
    expect(closed.lifecycle).toBe("done")
    expect(closed.board_status).toBe("completed")
    const ev = (await human.call("evidence.list", { work_item_id: w.id })) as {
      evidence: { kind: string; title: string; provenance: { actor: { kind: string } } }[]
    }
    expect(ev.evidence[0]?.kind).toBe("manual_close")
    expect(ev.evidence[0]?.title).toContain("pull/126")
    expect(ev.evidence[0]?.provenance.actor.kind).toBe("human")
    const closedEvent = daemon.repo
      .eventsAfter(0, null, 10_000)
      .find((e) => e.kind === "task.closed")
    expect(JSON.parse(closedEvent?.payload_json ?? "{}")).toMatchObject({ manual: true })
  })

  test("un agente no cierra; con un run vivo tampoco", async () => {
    const { daemon, human } = await boot()
    const pid = daemon.project.project_id
    const w = daemon.repo.createWorkItem({ project_id: pid, title: "t", kind: "chore" })
    const run = daemon.repo.createRun({ project_id: pid, work_item_id: w.id, purpose: "plan" })
    daemon.repo.updateRun(run.id, { status: "running" })
    const live = await human
      .call("work_items.close", {
        ...meta(),
        work_item_id: w.id,
        reason: "x x x",
        evidence: { text: "afuera" },
      })
      .catch((e: Error) => e.message)
    expect(String(live)).toContain("run vivo")
    const { file } = daemon.agentTokens.issue({
      run_id: run.id,
      project_id: pid,
      work_item_id: w.id,
    })
    const agent = await IpcClient.connect(daemon.agentServer.path)
    clients.push(agent)
    await agent.call("session.bind_agent", { token: readFileSync(file, "utf8") })
    const byAgent = await agent
      .call("work_items.close", {
        ...meta(),
        work_item_id: w.id,
        reason: "x x x",
        evidence: { text: "afuera" },
      })
      .catch((e: Error) => e.message)
    expect(String(byAgent)).not.toBe("")
    expect(daemon.repo.getWorkItem(w.id)?.lifecycle).toBe("triage")
  })
})
