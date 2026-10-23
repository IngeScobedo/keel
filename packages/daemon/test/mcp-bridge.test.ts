/**
 * ADR-0009: el puente `keel mcp`, el actor `agent` y la capacidad de un solo
 * uso. El puente corre como proceso real (`main.ts mcp`) contra un daemon real;
 * el agente es este test hablando MCP por stdio.
 */
import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Daemon, IpcClient, type QueryFn } from "../src/index.ts"
import { LineDecoder } from "../src/ipc/framing.ts"
import { initRepo } from "./git-fixture.ts"
import { replayQuery } from "./replay.ts"

const MAIN = join(import.meta.dir, "..", "src", "main.ts")
const dirs: string[] = []
const daemons: Daemon[] = []
const procs: Bun.Subprocess[] = []
afterEach(async () => {
  for (const p of procs.splice(0)) p.kill()
  for (const d of daemons.splice(0)) {
    await d.idle()
    d.stop()
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

let n = 0
const key = () => `mcp-${++n}`
const meta = () => ({ request_id: "r", idempotency_key: key() })

function boot(queryFn?: QueryFn) {
  const dir = mkdtempSync(join(tmpdir(), "keel-mcp-"))
  dirs.push(dir)
  initRepo(join(dir, "repo"))
  const daemon = new Daemon({
    dbPath: join(dir, "keel.sqlite"),
    socketPath: join(dir, "keel.sock"),
    rootPath: join(dir, "repo"),
    worktreesDir: join(dir, "worktrees"),
    adapterDeps: { queryFn: queryFn ?? replayQuery(), binary: "/fake/claude" },
  })
  daemon.start()
  daemons.push(daemon)
  const pid = daemon.project.project_id
  const item = daemon.repo.createWorkItem({
    project_id: pid,
    title: "tarea del run",
    kind: "chore",
  })
  const other = daemon.repo.createWorkItem({ project_id: pid, title: "otra tarea", kind: "chore" })
  const run = daemon.repo.createRun({ project_id: pid, work_item_id: item.id, purpose: "plan" })
  const issue = () =>
    daemon.agentTokens.issue({ run_id: run.id, project_id: pid, work_item_id: item.id })
  return { dir, daemon, item, other, run, issue }
}

/** Un agente MCP mínimo sobre el stdio del puente. */
function bridge(env: Record<string, string>) {
  const proc = Bun.spawn([process.execPath, MAIN, "mcp"], {
    env: { ...process.env, ...env },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  })
  procs.push(proc)
  const waiting = new Map<number, (m: unknown) => void>()
  const decoder = new LineDecoder()
  void (async () => {
    for await (const chunk of proc.stdout as ReadableStream<Uint8Array>)
      for (const d of decoder.push(chunk))
        if (d.ok) {
          const m = JSON.parse(d.line) as { id: number }
          waiting.get(m.id)?.(m)
        }
  })()
  let id = 0
  const rpc = (method: string, params: unknown = {}) => {
    const my = ++id
    const p = new Promise<{ result?: unknown; error?: { message: string } }>((resolve) =>
      waiting.set(my, resolve as (m: unknown) => void),
    )
    proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: my, method, params })}\n`)
    proc.stdin.flush()
    return p
  }
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await rpc("tools/call", { name, arguments: args })) as {
      result: { structuredContent?: unknown; isError?: boolean; content: { text: string }[] }
    }
    return r.result
  }
  const initialize = () =>
    rpc("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "0" },
    })
  return { proc, rpc, call, initialize }
}

describe("ADR-0009: puente keel mcp", () => {
  test("el puente se vincula antes de responder initialize, borra el token y opera sobre la tarea del run", async () => {
    const { daemon, item, run, issue } = boot()
    const { file } = issue()
    const b = bridge({ KEEL_RUN_TOKEN_FILE: file, KEEL_SOCKET: daemon.server.path })

    const init = (await b.initialize()) as { result: { serverInfo: { name: string } } }
    expect(init.result.serverInfo.name).toBe("keel")
    expect(existsSync(file)).toBe(false)

    const tools = (await b.rpc("tools/list")) as { result: { tools: { name: string }[] } }
    expect(tools.result.tools.map((t) => t.name)).toEqual([
      "task_current",
      "tasks_list",
      "task_get",
      "task_create",
      "note_add",
      "handoff_request",
      "evidence_attach",
      "git_status",
      "git_diff",
      "git_propose",
      "git_plan_status",
      "context_search",
      "resources_list",
      "db_schema",
      "db_query",
      "ssh_run",
      "iac_plan",
      "iac_apply",
      "research_hypothesis_add",
      "research_finding_add",
      "research_conclusion_propose",
      "research_claims",
      "run_request",
    ])

    const current = (await b.call("task_current")).structuredContent as {
      item: { id: string }
    }
    expect(current.item.id).toBe(item.id)

    const note = (await b.call("note_add", { content_markdown: "avance" })).structuredContent as {
      author: string
    }
    expect(note.author).toBe(`agent:${run.id}`)

    const created = (await b.call("task_create", { title: "hallazgo" })).structuredContent as {
      id: string
      lifecycle: string
    }
    expect(created.lifecycle).toBe("triage")
    const source = daemon.store.db
      .query<{ source: string }, [string]>("SELECT source FROM work_items WHERE id = ?")
      .get(created.id)
    expect(source?.source).toBe("agent")

    const handoff = (
      await b.call("handoff_request", {
        title: "seguir con X",
        summary_markdown: "lo que falta",
      })
    ).structuredContent as { work_item: { lifecycle: string } }
    expect(handoff.work_item.lifecycle).toBe("triage")
    const bound = daemon.repo
      .eventsAfter(0, null, 1000)
      .filter((e) => e.kind === "session.agent_bound")
    expect(bound).toHaveLength(1)

    b.proc.stdin.end()
    expect(await b.proc.exited).toBe(0)
  })

  test("un token sirve una sola vez: el segundo puente no se vincula y sale sin servir", async () => {
    const { daemon, issue } = boot()
    const { file } = issue()
    const token = readFileSync(file, "utf8")
    const first = bridge({ KEEL_RUN_TOKEN_FILE: file, KEEL_SOCKET: daemon.server.path })
    await first.initialize()

    writeFileSync(file, token)
    const second = bridge({ KEEL_RUN_TOKEN_FILE: file, KEEL_SOCKET: daemon.server.path })
    const init = await second.initialize()
    expect(init.error?.message).toContain("token")
    expect(await second.proc.exited).toBe(1)
  })

  test("sin token, el puente pide emparejamiento y no sirve nada hasta que el humano aprueba", async () => {
    const { daemon, item } = boot()
    const b = bridge({ KEEL_SOCKET: daemon.server.path, KEEL_CLIENT_NAME: "claude-code a mano" })
    // responde initialize en el acto: el agente debe poder decirle al humano qué aprobar
    await b.initialize()
    const pending = await b.call("task_current")
    expect(pending.isError).toBe(true)
    const [pairing] = daemon.repo.listPairings("pending")
    expect(pairing?.client_name).toBe("claude-code a mano")
    expect(pending.content[0]?.text).toContain(pairing?.code as string)

    const human = await IpcClient.connect(daemon.server.path)
    await human.call("session.pair_resolve", {
      ...meta(),
      pairing_id: pairing?.id,
      decision: "approve",
      work_item_id: item.id,
    })
    const current = (await b.call("task_current")).structuredContent as { item: { id: string } }
    expect(current.item.id).toBe(item.id)
    const note = (await b.call("note_add", { content_markdown: "desde fuera" }))
      .structuredContent as {
      author: string
    }
    expect(note.author).toBe(`agent:ext:${pairing?.id}`)

    // el vínculo dura lo que dura la conexión
    b.proc.stdin.end()
    await b.proc.exited
    for (
      let i = 0;
      i < 50 && daemon.repo.getPairing(pairing?.id as string)?.state !== "closed";
      i++
    )
      await Bun.sleep(10)
    expect(daemon.repo.getPairing(pairing?.id as string)?.state).toBe("closed")
    human.close()
  })

  test("ADR-0017: el agente pide su contexto como recurso; sin vínculo no obtiene tarea", async () => {
    const { daemon, item } = boot()
    // Una sesión externa: hasta que el humano aprueba, no hay recurso de tarea.
    const b = bridge({ KEEL_SOCKET: daemon.server.path, KEEL_CLIENT_NAME: "externa" })
    const init = (await b.initialize()) as { result: { capabilities: { resources?: unknown } } }
    expect(init.result.capabilities.resources).toBeDefined()
    const before = await b.rpc("resources/read", { uri: "keel://task/current" })
    expect(before.error?.message).toContain("no está aprobada")
    const [pairing] = daemon.repo.listPairings("pending")
    const human = await IpcClient.connect(daemon.server.path)
    await human.call("notes.add", {
      ...meta(),
      work_item_id: item.id,
      content_markdown: "ojo con el cuadre",
    })
    await human.call("session.pair_resolve", {
      ...meta(),
      pairing_id: pairing?.id,
      decision: "approve",
      work_item_id: item.id,
    })
    const list = (await b.rpc("resources/list")) as { result: { resources: { uri: string }[] } }
    expect(list.result.resources.map((r) => r.uri)).toEqual([
      "keel://task/current",
      "keel://project/context",
    ])
    const read = (await b.rpc("resources/read", { uri: "keel://task/current" })) as {
      result: { contents: { text: string; mimeType: string }[] }
    }
    const text = read.result.contents[0]?.text ?? ""
    expect(text).toContain("tarea del run")
    expect(text).toContain("ojo con el cuadre")
    const found = await b.call("context_search", { query: "cuadre" })
    expect(found.structuredContent).toMatchObject({ mode: "lexical" })
    human.close()
  })

  test("el actor agent sólo pide lo suyo y su capacidad caduca con el run", async () => {
    const { daemon, other, run, issue } = boot()
    const { file } = issue()
    const client = await IpcClient.connect(daemon.server.path)
    await client.call("session.bind_agent", { token: readFileSync(file, "utf8") })

    for (const [method, params] of [
      ["work_items.transition", { ...meta(), work_item_id: other.id, to: "planned" }],
      ["runs.start", { ...meta(), work_item_id: other.id, purpose: "plan" }],
      ["approvals.resolve", { ...meta(), approval_id: "x", decision: "approved" }],
      ["approvals.list", {}],
      ["projects.set_vcs", { ...meta(), vcs: "none" }],
      ["events.subscribe", { after_event_seq: 0 }],
    ] as const)
      await expect(client.call(method, params)).rejects.toThrow("un agente no puede usar")

    await expect(
      client.call("notes.add", { ...meta(), work_item_id: other.id, content_markdown: "x" }),
    ).rejects.toThrow("sólo añade notas a la tarea que tiene vinculada")
    await expect(client.call("work_items.list", { project_id: "otro-proyecto" })).rejects.toThrow(
      "sólo opera en el proyecto",
    )
    await expect(client.call("session.bind_agent", { token: "x".repeat(20) })).rejects.toThrow(
      "ya está vinculada",
    )

    daemon.repo.updateRun(run.id, { status: "completed" })
    await expect(client.call("work_items.list", {})).rejects.toThrow("caducó")
    client.close()
  })

  test("el proveedor recibe el puente con la ruta del token, nunca su valor, y el token se revoca al terminar", async () => {
    let seen: { options: Record<string, unknown>; token: string } | null = null
    const capture: QueryFn = (args) => {
      const servers = args.options.mcpServers as Record<string, { env: Record<string, string> }>
      const file = servers.keel?.env.KEEL_RUN_TOKEN_FILE as string
      seen = { options: args.options as Record<string, unknown>, token: readFileSync(file, "utf8") }
      return replayQuery()(args)
    }
    const { daemon, run } = boot(capture)
    // El run de la fixture no cuenta para el límite de concurrencia de este test.
    daemon.repo.updateRun(run.id, { status: "cancelled" })
    const client = await IpcClient.connect(daemon.server.path)
    const w = (await client.call("work_items.create", {
      ...meta(),
      title: "con puente",
      kind: "chore",
    })) as { id: string }
    await client.call("runs.start", { ...meta(), work_item_id: w.id, purpose: "plan" })
    await daemon.idle()
    client.close()

    expect(seen).not.toBeNull()
    const { options, token } = seen as unknown as {
      options: Record<string, unknown>
      token: string
    }
    expect(options.strictMcpConfig).toBe(true)
    expect(options.allowedTools).toContain("mcp__keel")
    const keel = (options.mcpServers as Record<string, Record<string, unknown>>).keel
    expect(keel).toMatchObject({ type: "stdio", alwaysLoad: true })
    expect(token.length).toBeGreaterThan(20)
    expect(JSON.stringify(options)).not.toContain(token)
    // revocado al terminar: el archivo ya no existe y el token no vincula
    const file = (keel as { env: Record<string, string> }).env.KEEL_RUN_TOKEN_FILE as string
    expect(existsSync(file)).toBe(false)
    const late = await IpcClient.connect(daemon.server.path)
    await expect(late.call("session.bind_agent", { token })).rejects.toThrow("token")
    late.close()
  })
})
