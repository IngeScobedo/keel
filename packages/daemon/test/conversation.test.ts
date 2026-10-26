/**
 * ADR-0019 §3: conversación con el run. Un mensaje durante el run llega al
 * agente (Claude: entrada en streaming; Codex: `turn/steer`); continuar un run
 * terminado crea un hijo que retoma la sesión y, si ejecuta, el worktree.
 * Daemon, git y SQLite reales; proveedores dobles.
 */
import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Options, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk"
import { Daemon, IpcClient, type QueryFn } from "../src/index.ts"
import { initRepo } from "./git-fixture.ts"

const FAKE = join(import.meta.dir, "fixtures", "fake-codex-app-server.ts")
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
const textOf = (m: IteratorResult<SDKUserMessage>) =>
  m.done ? null : (m.value.message.content as string)

type Seen = { options: Options[]; inputs: (string | null)[] }

/**
 * Un Claude doble que conversa: contesta cada mensaje con «recibí: …» y anota
 * qué le llegó. Si `waitForMore`, tras el primer turno espera otro mensaje antes
 * de cerrar el primer resultado, como cuando el humano escribe mientras trabaja.
 */
function talking(seen: Seen, waitForMore: boolean | "merged"): QueryFn {
  let turn = 0
  return ({ prompt, options }) =>
    (async function* () {
      seen.options.push(options)
      const it = (prompt as AsyncIterable<SDKUserMessage>)[Symbol.asyncIterator]()
      const session = `s-${++turn}`
      const reply = (text: string | null, i: number) => [
        {
          type: "assistant",
          uuid: `${session}-a${i}`,
          session_id: session,
          message: { content: [{ type: "text", text: `recibí: ${text}` }] },
        },
      ]
      const result = (i: number) =>
        ({
          type: "result",
          subtype: "success",
          uuid: `${session}-r${i}`,
          session_id: session,
          is_error: false,
          result: "ok",
          total_cost_usd: 0.001 * i,
          usage: { input_tokens: 1, output_tokens: 1 },
        }) as unknown as SDKMessage
      yield { type: "system", subtype: "init", session_id: session, uuid: `${session}-i` } as never
      const first = textOf(await it.next())
      seen.inputs.push(first)
      for (const m of reply(first, 1)) yield m as never
      if (waitForMore === "merged") {
        // Como Claude Code real: lo que llega durante el turno entra en él y hay un
        // solo `result` para los dos mensajes.
        const second = textOf(await it.next())
        seen.inputs.push(second)
        for (const m of reply(second, 2)) yield m as never
        yield result(1)
      } else if (waitForMore) {
        const second = textOf(await it.next())
        seen.inputs.push(second)
        yield result(1)
        for (const m of reply(second, 2)) yield m as never
        yield result(2)
      } else yield result(1)
      // Sin nada pendiente, la entrada se cierra y el run termina.
      seen.inputs.push(textOf(await it.next()))
    })()
}

async function boot(queryFn: QueryFn) {
  const dir = mkdtempSync(join(tmpdir(), "keel-conv-"))
  dirs.push(dir)
  initRepo(join(dir, "repo"))
  const fakeLog = join(dir, "fake.ndjson")
  const daemon = new Daemon({
    dbPath: join(dir, "keel.sqlite"),
    socketPath: join(dir, "keel.sock"),
    rootPath: join(dir, "repo"),
    worktreesDir: join(dir, "worktrees"),
    adapterDeps: { queryFn, binary: "/fake/claude" },
    mcpBridge: false,
    codex: { subscription_enabled: true },
    codexDeps: {
      appServerLaunch: (args) => ({
        command: process.execPath,
        args: [FAKE, ...args],
        env: { ...(process.env as Record<string, string>), FAKE_LOG: fakeLog },
      }),
    },
  })
  daemon.start()
  daemons.push(daemon)
  const human = await IpcClient.connect(daemon.server.path)
  clients.push(human)
  const task = async (planned: boolean) => {
    const w = (await human.call("work_items.create", { ...meta(), title: "t", kind: "chore" })) as {
      id: string
    }
    if (planned)
      await human.call("work_items.transition", { ...meta(), work_item_id: w.id, to: "planned" })
    return w
  }
  const kinds = (runId: string) =>
    daemon.repo
      .eventsAfter(0, null, 100_000)
      .filter((e) => e.run_id === runId)
      .map((e) => e.kind)
  const until = async (ok: () => boolean) => {
    for (let i = 0; i < 500 && !ok(); i++) await Bun.sleep(10)
    expect(ok()).toBe(true)
  }
  const fake = () =>
    existsSync(fakeLog)
      ? readFileSync(fakeLog, "utf8")
          .trim()
          .split("\n")
          .map((l) => JSON.parse(l) as Record<string, unknown>)
      : []
  return { daemon, human, task, kinds, until, fake }
}

describe("ADR-0019 §3: conversación con Claude", () => {
  test("un mensaje durante el run llega al agente como otro turno y queda con autor humano", async () => {
    const seen: Seen = { options: [], inputs: [] }
    const { daemon, human, task, kinds, until } = await boot(talking(seen, true))
    const w = await task(false)
    const run = (await human.call("runs.start", {
      ...meta(),
      work_item_id: w.id,
      purpose: "plan",
      prompt: "planea",
    })) as { id: string }
    await until(() => kinds(run.id).includes("sdk.assistant"))
    await human.call("runs.message", { ...meta(), run_id: run.id, text: "y añade pruebas" })
    await daemon.idle()
    expect(seen.inputs).toEqual(["planea", "y añade pruebas", null])
    expect(daemon.repo.getRun(run.id)?.status).toBe("completed")
    const msg = daemon.repo.eventsAfter(0, null, 100_000).find((e) => e.kind === "run.user_message")
    expect(JSON.parse(msg?.payload_json ?? "{}")).toMatchObject({
      text: "y añade pruebas",
      actor: { kind: "human" },
    })
    // Un run terminado ya no recibe mensajes: se continúa.
    await expect(
      human.call("runs.message", { ...meta(), run_id: run.id, text: "otra" }),
    ).rejects.toThrow("runs.continue")
  })

  test("si el mensaje entra en el turno en curso, un solo result cierra el run (Claude Code real)", async () => {
    const seen: Seen = { options: [], inputs: [] }
    const { daemon, human, task, kinds, until } = await boot(talking(seen, "merged"))
    const w = await task(false)
    const run = (await human.call("runs.start", {
      ...meta(),
      work_item_id: w.id,
      purpose: "plan",
      prompt: "lee",
    })) as { id: string }
    await until(() => kinds(run.id).includes("sdk.assistant"))
    await human.call("runs.message", { ...meta(), run_id: run.id, text: "y cuenta líneas" })
    await daemon.idle()
    expect(seen.inputs).toEqual(["lee", "y cuenta líneas", null])
    expect(daemon.repo.getRun(run.id)?.status).toBe("completed")
  })

  test("continuar un plan crea un run hijo que retoma la sesión con las mismas opciones", async () => {
    const seen: Seen = { options: [], inputs: [] }
    const { daemon, human, task } = await boot(talking(seen, false))
    const w = await task(false)
    const parent = (await human.call("runs.start", {
      ...meta(),
      work_item_id: w.id,
      purpose: "plan",
      options: { model: "sonnet", max_turns: 30 },
    })) as { id: string }
    await daemon.idle()
    const child = (await human.call("runs.continue", {
      ...meta(),
      run_id: parent.id,
      text: "ahora con detalle",
    })) as { id: string; parent_run_id: string; options: { model: string } }
    await daemon.idle()
    expect(child.parent_run_id).toBe(parent.id)
    expect(child.options.model).toBe("sonnet")
    expect(seen.options[1]).toMatchObject({ resume: "s-1", model: "sonnet", maxTurns: 30 })
    expect(seen.inputs.slice(-2)).toEqual(["ahora con detalle", null])
    expect(daemon.repo.getRun(child.id)?.status).toBe("completed")
  })

  test("continuar una ejecución revisada vuelve a planned y sigue en el mismo worktree", async () => {
    const seen: Seen = { options: [], inputs: [] }
    const { daemon, human, task, kinds } = await boot(talking(seen, false))
    const w = await task(true)
    const parent = (await human.call("runs.start", {
      ...meta(),
      work_item_id: w.id,
      purpose: "execute",
    })) as { id: string }
    await daemon.idle()
    expect(daemon.repo.getWorkItem(w.id)?.lifecycle).toBe("needs_review")
    const parentCwd = seen.options[0]?.cwd
    const child = (await human.call("runs.continue", {
      ...meta(),
      run_id: parent.id,
      text: "corrige el nombre",
    })) as { id: string }
    await daemon.idle()
    expect(kinds(child.id)).toContain("worktree.inherited")
    expect(seen.options[1]?.cwd).toBe(parentCwd)
    expect(seen.options[1]?.resume).toBe("s-1")
    expect(daemon.repo.runWorktrees(child.id)).toHaveLength(1)
    expect(daemon.repo.runWorktrees(parent.id)).toHaveLength(0)
    expect(daemon.repo.getWorkItem(w.id)?.lifecycle).toBe("needs_review")
  })
})

describe("ADR-0019 §3: conversación con Codex (app_server)", () => {
  test("durante el turno el mensaje va por turn/steer; continuar usa thread/resume", async () => {
    const { daemon, human, task, until, fake } = await boot(
      talking({ options: [], inputs: [] }, false),
    )
    const w = await task(true)
    const run = (await human.call("runs.start", {
      ...meta(),
      work_item_id: w.id,
      purpose: "execute",
      profile: "codex",
      prompt: "wait",
    })) as { id: string }
    await until(() => fake().some((e) => "turnStart" in e))
    await human.call("runs.message", { ...meta(), run_id: run.id, text: "usa bun" })
    await daemon.idle()
    const steer = fake().find((e) => "steer" in e)?.steer as Record<string, unknown>
    expect(steer).toMatchObject({
      threadId: "th-fake",
      expectedTurnId: "tu-fake",
      input: [{ type: "text", text: "usa bun" }],
    })
    expect(daemon.repo.getRun(run.id)?.status).toBe("completed")

    const child = (await human.call("runs.continue", {
      ...meta(),
      run_id: run.id,
      text: "y documenta",
    })) as { id: string }
    await daemon.idle()
    expect(fake().find((e) => "threadResume" in e)?.threadResume).toMatchObject({
      threadId: "th-fake",
    })
    expect(daemon.repo.getRun(child.id)?.status).toBe("completed")
  })

  test("ADR-0021: revisar con Codex vuelve el sandbox del turno siguiente a sólo lectura", async () => {
    const { daemon, human, task, until, fake } = await boot(
      talking({ options: [], inputs: [] }, false),
    )
    const w = await task(true)
    const run = (await human.call("runs.start", {
      ...meta(),
      work_item_id: w.id,
      purpose: "execute",
      profile: "codex",
      prompt: "nosteer",
    })) as { id: string }
    await until(() => fake().some((e) => "turnStart" in e))
    // Lo que hace Keel al entrar a revisión con el run vivo.
    expect(await daemon.codex.setMode(run.id, "plan")).toEqual({ applies: "next_turn" })
    await human.call("runs.message", { ...meta(), run_id: run.id, text: "revisa" })
    await daemon.idle()
    const turns = fake().filter((e) => "turnStart" in e)
    expect(turns).toHaveLength(2)
    expect(turns[0]?.sandboxPolicy).toBeNull()
    expect(turns[1]).toMatchObject({ sandboxPolicy: { type: "readOnly" } })
    expect(await daemon.codex.setMode(run.id, "ask")).toMatchObject({ error: expect.any(String) })
  })
})
