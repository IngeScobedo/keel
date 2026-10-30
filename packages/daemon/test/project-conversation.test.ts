/**
 * ADR-0024: la conversación del proyecto. Daemon, git y SQLite reales; el proveedor
 * es un guion por run que actúa como el agente por la puerta de agentes con el token
 * de su run, igual que el puente MCP.
 */
import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Options, PermissionResult, SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import { conversationHeader } from "../src/daemon.ts"
import { Daemon, IpcClient, type QueryFn } from "../src/index.ts"
import { initRepo } from "./git-fixture.ts"
import { firstPrompt } from "./replay.ts"

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
const meta = () => ({ request_id: "r", idempotency_key: `conv-${++n}` })

type Turn = {
  run_id: string
  options: Options
  prompt: string
  agent: IpcClient
  use: (tool: string, input: Record<string, unknown>) => Promise<PermissionResult | undefined>
}
type Script = (t: Turn) => Promise<void>
type View = { id: string; display_id: string; title: string; priority?: string }
type RunView = { id: string; parent_run_id: string | null; purpose: string; status: string }

async function boot() {
  const dir = mkdtempSync(join(tmpdir(), "keel-conv-"))
  dirs.push(dir)
  const repoDir = initRepo(join(dir, "repo"))
  const scripts: Script[] = []
  const seen: Turn[] = []
  let daemon: Daemon
  const queryFn: QueryFn = ({ prompt, options }) => {
    const script = scripts.shift() ?? (async () => {})
    return (async function* () {
      const runId = String((options.env as Record<string, string>).KEEL_RUN_ID)
      const run = daemon.repo.getRun(runId)
      const { file } = daemon.agentTokens.issue({
        run_id: runId,
        project_id: run?.project_id as string,
        work_item_id: run?.work_item_id as string,
      })
      const agent = await IpcClient.connect(daemon.agentServer.path)
      clients.push(agent)
      await agent.call("session.bind_agent", { token: readFileSync(file, "utf8") })
      yield {
        type: "system",
        subtype: "init",
        session_id: `s-${runId}`,
        model: "sonnet",
        uuid: `i-${runId}`,
      } as never
      const turn: Turn = {
        run_id: runId,
        options,
        prompt: firstPrompt(prompt),
        agent,
        use: async (tool, input) =>
          (await options.canUseTool?.(tool, input, {
            signal: new AbortController().signal,
            suggestions: [],
          } as never)) ?? undefined,
      }
      seen.push(turn)
      await script(turn)
      yield {
        type: "result",
        subtype: "success",
        uuid: `r-${runId}`,
        session_id: `s-${runId}`,
        is_error: false,
        result: "ok",
        total_cost_usd: 0.001,
        usage: { input_tokens: 1, output_tokens: 1 },
      } as unknown as SDKMessage
    })()
  }
  daemon = new Daemon({
    dbPath: join(dir, "keel.sqlite"),
    socketPath: join(dir, "keel.sock"),
    rootPath: repoDir,
    worktreesDir: join(dir, "worktrees"),
    adapterDeps: { queryFn, binary: "/fake/claude" },
    mcpBridge: false,
  })
  daemon.start()
  daemons.push(daemon)
  const human = await IpcClient.connect(daemon.server.path)
  clients.push(human)
  const settled = async (runId: string) => {
    const end = Date.now() + 10_000
    while (
      !["completed", "failed", "cancelled"].includes(daemon.repo.getRun(runId)?.status ?? "")
    ) {
      if (Date.now() > end) throw new Error("el run no terminó")
      await Bun.sleep(15)
    }
    await daemon.idle()
  }
  return { daemon, human, scripts, seen, repoDir, settled }
}

describe("ADR-0024: la conversación del proyecto", () => {
  test("una tarea oculta: se crea una vez, no está en las listas y no se come un KEEL-n", async () => {
    const { human } = await boot()
    const a = (await human.call("conversation.open", {})) as { work_item: View; run: null }
    const b = (await human.call("conversation.open", {})) as { work_item: View }
    expect(a.work_item.display_id).toBe("CHAT")
    expect(b.work_item.id).toBe(a.work_item.id)
    expect(a.run).toBeNull()
    const created = (await human.call("work_items.create", {
      ...meta(),
      title: "Primera tarea",
      kind: "feature",
    })) as View
    expect(created.display_id).toBe("KEEL-1")
    const list = (await human.call("work_items.list", {})) as { items: View[] }
    expect(list.items.map((w) => w.display_id)).toEqual(["KEEL-1"])
  })

  test("pregunta en sólo lectura y de lo que encuentra nace una tarea urgente ligada a la conversación", async () => {
    const { human, scripts, seen, settled, daemon } = await boot()
    let edit: PermissionResult | undefined
    let born: View | undefined
    scripts.push(async (t) => {
      edit = await t.use("Edit", { file_path: "src/a.ts", old_string: "a", new_string: "b" })
      born = (await t.agent.call("work_items.create", {
        ...meta(),
        title: "Export de pedidos sin requireRoles",
        kind: "bug",
        priority: "urgent",
        spec_markdown: "`orders/export.ts:41` no pide rol: cualquier sesión exporta pedidos.",
      })) as View
      await t.agent.call("notes.add", {
        ...meta(),
        work_item_id: daemon.repo.getRun(t.run_id)?.work_item_id as string,
        content_markdown: "Los exports viven en orders/export.ts y usan streams.",
      })
    })
    const asked = (await human.call("conversation.ask", {
      ...meta(),
      text: "¿Quién puede exportar pedidos?",
    })) as { delivered: string; run: RunView }
    expect(asked.delivered).toBe("started")
    expect(asked.run.purpose).toBe("plan")
    await settled(asked.run.id)

    const turn = seen[0] as Turn
    // Con el puente MCP, el prompt empieza con este encabezado (sin puente, no hay tools de Keel).
    // ADR-0042: el agente de la conversación es el orquestador, en sólo lectura.
    expect(conversationHeader()).toContain("Eres el orquestador del proyecto")
    expect(conversationHeader()).toContain("en sólo lectura: no editas archivos")
    expect(conversationHeader()).toContain("task_create")
    expect(turn.prompt).toContain("¿Quién puede exportar pedidos?")
    expect(turn.options.permissionMode).toBe("plan")
    // Sólo lectura: un Edit se niega sin preguntar.
    expect(edit?.behavior).toBe("deny")

    expect(born?.priority).toBe("urgent")
    const open = (await human.call("conversation.open", {})) as {
      work_item: View
      run: RunView
      born: View[]
      notes: { content_markdown: string }[]
    }
    expect(open.run.id).toBe(asked.run.id)
    expect(open.born.map((w) => w.title)).toEqual(["Export de pedidos sin requireRoles"])
    expect(open.notes.map((x) => x.content_markdown)).toContain(
      "Los exports viven en orders/export.ts y usan streams.",
    )
    const detail = (await human.call("work_items.get", { work_item_id: born?.id })) as {
      item: { origin_work_item_id: string }
      spec_markdown: string
      notes: { content_markdown: string }[]
    }
    expect(detail.item.origin_work_item_id).toBe(open.work_item.id)
    expect(detail.spec_markdown).toContain("orders/export.ts:41")
    expect(detail.notes[0]?.content_markdown).toContain("Nació de la conversación del proyecto")

    // «Trabajar» empieza su brief con la especificación que dejó el agente.
    scripts.push(async () => {})
    const work = (await human.call("tasks.work", { ...meta(), work_item_id: born?.id })) as {
      flow: { stage: string }
      run: RunView
    }
    expect(work.flow.stage).toBe("brief")
    await settled(work.run.id)
    expect(seen[1]?.prompt).toContain("Export de pedidos sin requireRoles")

    // La nota de la conversación se encuentra desde otra tarea.
    const found = (await human.call("context.search", { query: "streams" })) as {
      results: { kind: string; snippet: string }[]
    }
    expect(found.results.some((r) => r.snippet.includes("streams"))).toBe(true)
  })

  test("seguir la conversación retoma la sesión; «Nueva conversación» empieza sin padre", async () => {
    const { human, settled } = await boot()
    const first = (await human.call("conversation.ask", { ...meta(), text: "hola" })) as {
      run: RunView
    }
    await settled(first.run.id)
    const second = (await human.call("conversation.ask", { ...meta(), text: "¿y luego?" })) as {
      delivered: string
      run: RunView
    }
    expect(second.delivered).toBe("continued")
    expect(second.run.parent_run_id).toBe(first.run.id)
    await settled(second.run.id)
    const fresh = (await human.call("conversation.ask", {
      ...meta(),
      text: "otro tema",
      fresh: true,
    })) as { delivered: string; run: RunView }
    expect(fresh.delivered).toBe("started")
    expect(fresh.run.parent_run_id).toBeNull()
    await settled(fresh.run.id)
  })
})
