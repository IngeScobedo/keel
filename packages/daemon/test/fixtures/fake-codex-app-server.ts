/**
 * Doble de `codex app-server` para los tests (ADR-0008, transporte
 * `app_server`). Habla JSON-RPC por stdio con las formas que capturó el spike
 * del 2026-10-22 (codex-cli 0.162.1). El escenario sale del texto del turno.
 *
 * FAKE_LOG: archivo NDJSON donde se registran argv y las respuestas del cliente.
 * FAKE_NO_ACCOUNT=1: `account/read` devuelve `account: null` (sin sesión).
 */
import { type ChildProcess, spawn } from "node:child_process"
import { appendFileSync } from "node:fs"

type Json = Record<string, unknown>
const log = (entry: Json) => {
  if (process.env.FAKE_LOG) appendFileSync(process.env.FAKE_LOG, `${JSON.stringify(entry)}\n`)
}
log({ argv: process.argv.slice(2), pid: process.pid })

const send = (msg: Json) => process.stdout.write(`${JSON.stringify(msg)}\n`)
const notify = (method: string, params: Json) => send({ method, params })
const waiting = new Map<string, (result: unknown) => void>()
const ask = (id: string, method: string, params: Json) =>
  new Promise<unknown>((resolve) => {
    waiting.set(id, resolve)
    send({ id, method, params })
  })

const THREAD = "th-fake"
const TURN = "tu-fake"
let child: ChildProcess | null = null
let interrupted: (() => void) | null = null
let steered: ((text: string) => void) | null = null

function turnCompleted(status: string, error: Json | null = null) {
  notify("turn/completed", {
    threadId: THREAD,
    turn: { id: TURN, status, error, items: [], durationMs: 5 },
  })
}

function command(id: string, status: string, extra: Json = {}) {
  return {
    item: {
      type: "commandExecution",
      id,
      command: "/bin/bash -lc 'ls'",
      cwd: "/repo",
      status,
      exitCode: null,
      aggregatedOutput: null,
      durationMs: null,
      ...extra,
    },
    threadId: THREAD,
    turnId: TURN,
  }
}

async function scenario(text: string) {
  if (text.startsWith("ok")) {
    const refresh = await ask("srv-0", "account/chatgptAuthTokens/refresh", {})
    log({ refresh })
    notify("item/started", command("c1", "inProgress"))
    notify("item/completed", command("c1", "completed", { exitCode: 0, aggregatedOutput: "a\n", durationMs: 12 }))
    notify("item/completed", {
      item: {
        type: "fileChange",
        id: "f1",
        status: "completed",
        changes: [{ path: "src/a.ts", kind: { type: "update" }, diff: "+x" }],
      },
      threadId: THREAD,
      turnId: TURN,
    })
    notify("item/agentMessage/delta", { threadId: THREAD, turnId: TURN, itemId: "m1", delta: "lis" })
    notify("thread/tokenUsage/updated", {
      threadId: THREAD,
      turnId: TURN,
      tokenUsage: { total: { inputTokens: 900, outputTokens: 30 }, last: { inputTokens: 900, outputTokens: 30 } },
    })
    notify("account/rateLimits/updated", {
      rateLimits: { primary: { usedPercent: 3, windowDurationMins: 300 }, secondary: { usedPercent: 1, windowDurationMins: 10080 } },
    })
    turnCompleted("completed")
    return
  }
  if (text.startsWith("approval")) {
    notify("item/started", command("c2", "inProgress"))
    const answer = (await ask("srv-1", "item/commandExecution/requestApproval", {
      kind: "command",
      threadId: THREAD,
      turnId: TURN,
      itemId: "c2",
      command: "/bin/bash -lc 'touch x'",
      cwd: "/repo",
      availableDecisions: ["accept", "acceptForSession", "decline", "cancel"],
    })) as { decision: string }
    log({ approval: answer })
    notify("serverRequest/resolved", { threadId: THREAD, requestId: "srv-1" })
    notify("item/completed", command("c2", answer.decision === "accept" ? "completed" : "declined", { exitCode: answer.decision === "accept" ? 0 : null }))
    turnCompleted("completed")
    return
  }
  if (text.startsWith("fail401")) {
    notify("error", {
      error: { message: "Reconnecting... 2/5", codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: 401 } } },
      willRetry: true,
      threadId: THREAD,
      turnId: TURN,
    })
    turnCompleted("failed", {
      message: "unexpected status 401 Unauthorized",
      codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 401 } },
    })
    return
  }
  if (text.startsWith("usage")) {
    turnCompleted("failed", { message: "usage limit", codexErrorInfo: "usageLimitExceeded" })
    return
  }
  if (text.startsWith("hang")) {
    notify("item/started", command("c3", "inProgress"))
    // Como el real: el comando corre en un proceso hijo que sobrevive a `turn/interrupt`.
    child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 300000)"], { stdio: "ignore" })
    log({ child: child.pid })
    await new Promise<void>((resolve) => {
      interrupted = resolve
    })
    turnCompleted("interrupted")
    return
  }
  if (text.startsWith("crash")) process.exit(3)
  if (text.startsWith("wait")) {
    // Espera a que el humano escriba durante el turno (`turn/steer`).
    const said = await new Promise<string>((resolve) => {
      steered = resolve
    })
    notify("item/completed", {
      item: { type: "agentMessage", id: "m-steer", text: `recibido: ${said}` },
      threadId: THREAD,
      turnId: TURN,
    })
    turnCompleted("completed")
    return
  }
  // Cualquier otro texto: un turno que contesta y termina.
  notify("item/completed", {
    item: { type: "agentMessage", id: `m-${Date.now()}`, text: `eco: ${text}` },
    threadId: THREAD,
    turnId: TURN,
  })
  turnCompleted("completed")
}

let buf = ""
process.stdin.on("data", (chunk: Buffer) => {
  buf += chunk.toString("utf8")
  let nl = buf.indexOf("\n")
  while (nl >= 0) {
    const line = buf.slice(0, nl).trim()
    buf = buf.slice(nl + 1)
    if (line) void handle(JSON.parse(line) as Json)
    nl = buf.indexOf("\n")
  }
})
// Al cerrarse stdin el app-server sale, y sus comandos con él (spike, pruebas 5 y 6).
process.stdin.on("end", () => {
  child?.kill("SIGKILL")
  process.exit(0)
})

function startTurn(msg: Json) {
  send({ id: msg.id, result: { turn: { id: TURN, status: "inProgress" } } })
  notify("turn/started", { threadId: THREAD, turn: { id: TURN, status: "inProgress" } })
  const raw = ((msg.params as Json).input as { text: string }[])[0]?.text ?? ""
  // El escenario es lo que pidió el humano, después del encabezado de Keel (ADR-0017 §1).
  const text = raw.startsWith("[Keel]") ? raw.slice(raw.indexOf("\n\n") + 2) : raw
  return scenario(text)
}

async function handle(msg: Json) {
  const id = msg.id as string | number | undefined
  const method = msg.method as string | undefined
  if (method === undefined && id !== undefined) {
    waiting.get(String(id))?.(msg.result ?? { error: msg.error })
    return
  }
  if (id === undefined) return
  const reply = (result: unknown) => send({ id, result })
  switch (method) {
    case "initialize":
      return reply({ userAgent: "fake" })
    case "account/read":
      return reply({
        account: process.env.FAKE_NO_ACCOUNT ? null : { type: "chatgpt" },
        requiresOpenaiAuth: true,
      })
    case "thread/start":
      log({ threadStart: msg.params })
      reply({ thread: { id: THREAD } })
      return notify("thread/started", { thread: { id: THREAD, model: "fake-model" } })
    case "thread/resume":
      log({ threadResume: msg.params })
      return reply({ thread: { id: (msg.params as Json).threadId } })
    case "turn/steer": {
      log({ steer: msg.params })
      reply({ turnId: TURN })
      const text = ((msg.params as Json).input as { text: string }[])[0]?.text ?? ""
      steered?.(text)
      return
    }
    case "turn/start":
      log({ turnStart: (msg.params as Json).input })
      return startTurn(msg)
    case "turn/interrupt":
      log({ interrupt: msg.params })
      reply({})
      interrupted?.()
      return
    default:
      send({ id, error: { code: -32601, message: `fake: ${method}` } })
  }
}
