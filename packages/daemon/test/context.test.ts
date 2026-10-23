/**
 * ADR-0017: búsqueda de contexto filtrada por proyecto antes de rankear, que
 * dice su modo, y sin lo `restricted`; el prompt sólo lleva un encabezado.
 */
import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Options, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk"
import { Daemon, IpcClient, type QueryFn } from "../src/index.ts"
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

async function boot(opts: { queryFn?: QueryFn; bridge?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "keel-ctx-"))
  dirs.push(dir)
  const repo = initRepo(join(dir, "repo"))
  const daemon = new Daemon({
    dbPath: join(dir, "keel.sqlite"),
    socketPath: join(dir, "keel.sock"),
    rootPath: repo,
    worktreesDir: join(dir, "worktrees"),
    adapterDeps: { queryFn: opts.queryFn ?? replayQuery(), binary: "/fake/claude" },
    ...(opts.bridge ? {} : { mcpBridge: false as const }),
  })
  daemon.start()
  daemons.push(daemon)
  const human = await IpcClient.connect(daemon.server.path)
  clients.push(human)
  return { dir, repo, daemon, human }
}

type Search = { mode: string; results: { ref: string; kind: string; snippet: string }[] }

describe("ADR-0017: contexto y búsqueda", () => {
  test("busca en tareas, notas y evidencia del proyecto, en modo léxico y lo dice", async () => {
    const { human } = await boot()
    const w = (await human.call("work_items.create", {
      ...meta(),
      title: "Faltan 30 mil pesos",
      kind: "research",
      spec_markdown: "Revisar la conciliación bancaria de octubre.",
    })) as { id: string }
    await human.call("notes.add", {
      ...meta(),
      work_item_id: w.id,
      content_markdown: "La caja chica no cuadra con el banco.",
    })
    await human.call("evidence.attach", {
      ...meta(),
      work_item_id: w.id,
      kind: "sql_result",
      title: "movimientos de conciliación",
      content_base64: Buffer.from("[]").toString("base64"),
    })
    const r = (await human.call("context.search", { query: "conciliación" })) as Search
    expect(r.mode).toBe("lexical")
    expect(r.results.map((x) => x.kind).sort()).toEqual(["evidence", "task"])
    expect(r.results.find((x) => x.kind === "task")?.snippet).toContain("«conciliación»")
    const notes = (await human.call("context.search", {
      query: "caja chica",
      scopes: ["notes"],
    })) as Search
    expect(notes.results).toHaveLength(1)
    expect(notes.results[0]?.ref).toStartWith("keel://note/")
  })

  test("lo restricted no se indexa ni aparece aunque coincida el texto", async () => {
    const { human } = await boot()
    const w = (await human.call("work_items.create", { ...meta(), title: "t", kind: "chore" })) as {
      id: string
    }
    await human.call("evidence.attach", {
      ...meta(),
      work_item_id: w.id,
      kind: "sql_result",
      title: "nómina de producción",
      sensitivity: "restricted",
      content_base64: Buffer.from("[]").toString("base64"),
    })
    const r = (await human.call("context.search", { query: "nómina" })) as Search
    expect(r.results).toHaveLength(0)
  })

  test("un proyecto no ve lo de otro: el filtro va antes de rankear", async () => {
    const { dir, human } = await boot()
    await human.call("work_items.create", { ...meta(), title: "secreto de alfa", kind: "chore" })
    const beta = initRepo(join(dir, "beta"))
    await human.call("projects.open", { path: beta })
    const r = (await human.call("context.search", { query: "secreto" })) as Search
    expect(r.results).toHaveLength(0)
  })

  test("contexto del proyecto: always_read y ADRs; el prompt lleva sólo el encabezado", async () => {
    let prompt = ""
    let options: Options | null = null
    const capture: QueryFn = (args) => {
      options = args.options
      const it = (args.prompt as AsyncIterable<SDKUserMessage>)[Symbol.asyncIterator]()
      return (async function* () {
        const first = await it.next()
        prompt = first.done ? "" : String(first.value.message.content)
        yield* replayQuery()(args) as AsyncIterable<never>
      })()
    }
    const { repo, human } = await boot({ queryFn: capture, bridge: true })
    mkdirSync(join(repo, ".keel"), { recursive: true })
    mkdirSync(join(repo, "docs", "adr"), { recursive: true })
    writeFileSync(
      join(repo, ".keel", "project.toml"),
      '[context]\nalways_read = ["AGENTS.md", "../fuera.md"]\n',
    )
    writeFileSync(join(repo, "AGENTS.md"), "Usa bun.\n")
    writeFileSync(join(repo, "docs", "adr", "0001-algo.md"), "# ADR-0001: Algo\n")
    const ctx = (await human.call("context.project", {})) as {
      always_read: { path: string; text: string; truncated: boolean }[]
      adrs: { path: string; title: string }[]
    }
    // Lo que sale de la carpeta del proyecto no se lee.
    expect(ctx.always_read).toEqual([{ path: "AGENTS.md", text: "Usa bun.\n", truncated: false }])
    expect(ctx.adrs).toEqual([{ path: "docs/adr/0001-algo.md", title: "ADR-0001: Algo" }])

    const w = (await human.call("work_items.create", {
      ...meta(),
      title: "Arreglar x",
      kind: "bug",
    })) as {
      id: string
      display_id: string
    }
    await human.call("runs.start", {
      ...meta(),
      work_item_id: w.id,
      purpose: "plan",
      prompt: "planea",
    })
    for (let i = 0; i < 200 && !prompt; i++) await Bun.sleep(10)
    expect(prompt).toStartWith(`[Keel] Tarea ${w.display_id} «Arreglar x»`)
    expect(prompt).toContain("keel://task/current")
    expect(prompt).toEndWith("\n\nplanea")
    expect(options).not.toBeNull()
  })
})
