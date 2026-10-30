/**
 * ADR-0044: la sesión interactiva de Claude Code para Claude Design. Daemon real, tmux
 * real en un servidor propio y un `claude` falso que hace lo que midió el spike: pide
 * confiar en la carpeta, recibe el encargo pegado, publica un diseño en su transcript y
 * termina su turno.
 */
import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Daemon, IpcClient } from "../src/index.ts"
import { writeFakeClaudeDesign } from "./fixtures/fake-claude-design.ts"
import { initRepo } from "./git-fixture.ts"
import { replayQuery } from "./replay.ts"

const socket = `keel-test-design-${process.pid}`
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
afterAll(() => {
  Bun.spawnSync(["tmux", "-L", socket, "kill-server"], { stdout: "ignore", stderr: "ignore" })
})

async function boot() {
  const dir = mkdtempSync(join(tmpdir(), "keel-design-"))
  dirs.push(dir)
  const transcripts = join(dir, "transcripts")
  const daemon = new Daemon({
    dbPath: join(dir, "keel.sqlite"),
    socketPath: join(dir, "keel.sock"),
    rootPath: initRepo(join(dir, "repo")),
    worktreesDir: join(dir, "worktrees"),
    adapterDeps: { queryFn: replayQuery(), binary: "/fake/claude" },
    mcpBridge: false,
    design: {
      claude: writeFakeClaudeDesign(dir, transcripts),
      socket,
      transcripts,
      intervalMs: 150,
    },
  })
  daemon.start()
  daemons.push(daemon)
  const connect = async (path: string) => {
    const c = await IpcClient.connect(path)
    clients.push(c)
    return c
  }
  return { daemon, dir, connect }
}

const kinds = (d: Daemon, workItemId: string) =>
  d.store.db
    .query<{ kind: string; payload_json: string }, [string]>(
      "SELECT kind, payload_json FROM events WHERE kind LIKE 'design.%' AND json_extract(payload_json, '$.work_item_id') = ? ORDER BY event_seq",
    )
    .all(workItemId)

async function until<T>(f: () => T | null | undefined | false, ms = 10_000): Promise<T> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const v = f()
    if (v) return v
    await Bun.sleep(100)
  }
  const names = Bun.spawnSync(["tmux", "-L", socket, "list-sessions", "-F", "#{session_name}"], {
    stdout: "pipe",
  }).stdout.toString()
  const panes = names
    .split("\n")
    .filter(Boolean)
    .map((n) =>
      Bun.spawnSync(["tmux", "-L", socket, "capture-pane", "-p", "-t", n], {
        stdout: "pipe",
      }).stdout.toString(),
    )
  throw new Error(`no llegó a tiempo\n${panes.join("\n---\n")}`)
}

describe.skipIf(Bun.which("tmux") === null)("ADR-0044: sesión de diseño", () => {
  test("el agente encarga, el humano confía en la carpeta desde Keel y el agente recibe el link", async () => {
    const { daemon, dir, connect } = await boot()
    const pid = daemon.project.project_id
    const w = daemon.repo.createWorkItem({
      project_id: pid,
      title: "Propuesta visual",
      kind: "chore",
    })
    const run = daemon.repo.createRun({ project_id: pid, work_item_id: w.id, purpose: "execute" })
    const { file } = daemon.agentTokens.issue({
      run_id: run.id,
      project_id: pid,
      work_item_id: w.id,
    })
    const agent = await connect(daemon.agentServer.path)
    await agent.call("session.bind_agent", { token: readFileSync(file, "utf8") })
    const human = await connect(daemon.server.path)

    expect(await human.call("design.status", { work_item_id: w.id })).toMatchObject({
      available: true,
      session: null,
    })
    const sent = (await agent.call("design.request", {
      brief: "Diseña la tarjeta con descuento",
    })) as {
      session: { name: string; attach: string }
    }
    expect(sent.session.name).toBe(`keel-design-${w.display_id}`)
    expect(sent.session.attach).toBe(`tmux attach -t keel-design-${w.display_id}`)

    // El diálogo de confianza lo ve y lo contesta el humano; Keel no lo contesta solo.
    await until(() => kinds(daemon, w.id).some((e) => e.kind === "design.session.waiting_human"))
    const screen = (await human.call("design.screen", { work_item_id: w.id })) as {
      text: string
      waiting: string
    }
    expect(screen.text).toContain("trust this folder")
    expect(screen.waiting).toBe("trust")
    expect(kinds(daemon, w.id).some((e) => e.kind === "design.delivered")).toBe(false)
    await human.call("design.keys", { work_item_id: w.id, keys: ["Enter"] })

    const published = await until(() =>
      kinds(daemon, w.id).find((e) => e.kind === "design.published"),
    )
    expect(JSON.parse(published.payload_json)).toMatchObject({
      url: "https://claude.ai/artifact/DISENO1",
      title: "Tarjeta",
    })
    const idle = await until(() =>
      kinds(daemon, w.id).find((e) => e.kind === "design.session.idle"),
    )
    expect(JSON.parse(idle.payload_json).urls).toEqual(["https://claude.ai/artifact/DISENO1"])

    // El encargo llegó entero, con la tarea; la sesión no heredó CLAUDECODE.
    const session = daemon.design.get(w.id)
    const brief = readFileSync(join(dir, `brief-${session?.session_id}`), "utf8")
    expect(brief).toContain(`Encargo de Keel para ${w.display_id}`)
    expect(brief).toContain("Diseña la tarjeta con descuento")
    expect(readFileSync(join(dir, `inherited-${session?.session_id}`), "utf8").trim()).toBe("0")

    await human.call("design.close", { work_item_id: w.id })
    expect(kinds(daemon, w.id).at(-1)?.kind).toBe("design.session_closed")
    expect(daemon.design.get(w.id)).toBeNull()
  }, 30_000)

  test("la sesión cuenta contra el límite de runs y sólo un agente usa design.request", async () => {
    const { daemon, connect } = await boot()
    const pid = daemon.project.project_id
    const human = await connect(daemon.server.path)
    await human.call("settings.update", {
      request_id: "r",
      idempotency_key: crypto.randomUUID(),
      limits: { max_concurrent_runs: 1 },
    })
    const a = daemon.repo.createWorkItem({ project_id: pid, title: "a", kind: "chore" })
    const b = daemon.repo.createWorkItem({ project_id: pid, title: "b", kind: "chore" })
    await human.call("design.start", { work_item_id: a.id })
    await expect(human.call("design.start", { work_item_id: b.id })).rejects.toThrow(
      "la sesión de diseño cuenta como un run",
    )
    await expect(human.call("design.request", { brief: "x" })).rejects.toThrow("para agentes")
    await expect(
      human.call("design.open", { url: "https://evil.example/claude.ai/" }),
    ).rejects.toThrow()
    await human.call("design.close", { work_item_id: a.id })
    await human.call("design.start", { work_item_id: b.id })
    await human.call("design.close", { work_item_id: b.id })
  }, 30_000)
})
