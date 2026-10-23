/**
 * Spike del transporte `app_server` de ADR-0008. Un subcomando por prueba de la
 * tabla «Spike del App Server»:
 *
 *   models      initialize + model/list (no gasta turnos)
 *   turn        1. turno completo por stdio con la sesión del usuario
 *   nologin     2. CODEX_HOME vacío: qué devuelve sin sesión (no gasta turnos)
 *   approval    3. el cliente tarda ~20 s y deniega un comando; ¿se ejecutó?
 *   concurrent  4. dos app-server a la vez
 *   interrupt   5. turn/interrupt a mitad de un comando
 *   orphan      6. el padre muere con SIGKILL; ¿quedan app-server o hijos?
 *   sandbox     7. workspace-write sin aprobaciones: escribir fuera, red, socket
 *   dyntool     9. tool dinámica declarada por el cliente (item/tool/call)
 *   sdk        10. transporte @openai/codex-sdk: turno y cancelación
 *
 * Uso: KEEL_SPIKE_DIR=<scratch> KEEL_SPIKE_MODEL=<id> bun src/probe.ts <subcomando>
 * Nunca lee credenciales: usa la sesión que `codex` ya tenga (ADR-0002).
 */
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { AppServerClient, capturesDir, RpcError } from "./client.js"

type Json = Record<string, unknown>

const root = process.env.KEEL_SPIKE_DIR ?? join(tmpdir(), "keel-codex-spike")
const model = process.env.KEEL_SPIKE_MODEL
const effort = process.env.KEEL_SPIKE_EFFORT
mkdirSync(root, { recursive: true })

function report(name: string, data: Json): void {
  mkdirSync(capturesDir, { recursive: true })
  const path = join(capturesDir, `report-${name}.json`)
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`)
  console.log(JSON.stringify(data, null, 2))
  console.log(`→ ${path}`)
}

/** Repo git de prueba con un commit, como el de la corrida real de la Fase 1. */
function makeRepo(name: string): string {
  const dir = join(root, name)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, "README.md"), "# repo de prueba del spike\n")
  const git = (...args: string[]) =>
    spawnSync("git", ["-c", "user.name=spike", "-c", "user.email=spike@keel", ...args], {
      cwd: dir,
    })
  git("init", "-q")
  git("add", ".")
  git("commit", "-q", "-m", "inicial")
  return dir
}

function turnOverrides(): Json {
  const o: Json = {}
  if (model) o.model = model
  if (effort) o.effort = effort
  return o
}

async function startThread(c: AppServerClient, cwd: string, extra: Json = {}): Promise<string> {
  const res = await c.request<{ thread: { id: string } }>("thread/start", {
    cwd,
    sandbox: "workspace-write",
    approvalPolicy: "never",
    ephemeral: true,
    ...(model ? { model } : {}),
    ...extra,
  })
  return res.thread.id
}

async function runTurn(
  c: AppServerClient,
  threadId: string,
  text: string,
  extra: Json = {},
  timeoutMs = 180_000,
): Promise<{ turnId: string; completed: Json }> {
  const res = await c.request<{ turn: { id: string } }>("turn/start", {
    threadId,
    input: [{ type: "text", text }],
    ...turnOverrides(),
    ...extra,
  })
  const turnId = res.turn.id
  const completed = await c.waitFor(
    "turn/completed",
    timeoutMs,
    (p) => (p.turn as Json | undefined)?.id === turnId,
  )
  return { turnId, completed }
}

function turnSummary(completed: Json): Json {
  const turn = (completed.turn ?? {}) as Json
  return { status: turn.status, error: turn.error ?? null, durationMs: turn.durationMs ?? null }
}

function lastAgentMessage(c: AppServerClient): string | null {
  for (let i = c.notifications.length - 1; i >= 0; i--) {
    const n = c.notifications[i]
    if (n?.method !== "item/completed") continue
    const item = n.params.item as Json | undefined
    if (item?.type === "agentMessage") return String(item.text ?? "")
  }
  return null
}

function itemTypes(c: AppServerClient): Record<string, number> {
  const out: Record<string, number> = {}
  for (const n of c.notifications) {
    if (n.method !== "item/completed") continue
    const t = String((n.params.item as Json | undefined)?.type)
    out[t] = (out[t] ?? 0) + 1
  }
  return out
}

function tokenUsage(c: AppServerClient): unknown {
  const last = c.notifications.filter((n) => n.method === "thread/tokenUsage/updated").at(-1)
  return last?.params ?? null
}

function errors(c: AppServerClient): Json[] {
  return c.notifications.filter((n) => n.method === "error").map((n) => n.params)
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function childrenOf(pid: number): number[] {
  const r = spawnSync("ps", ["-o", "pid=", "--ppid", String(pid)], { encoding: "utf8" })
  return r.stdout
    .split("\n")
    .map((s) => Number(s.trim()))
    .filter((n) => n > 0)
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const commands: Record<string, () => Promise<void>> = {
  async models() {
    const c = new AppServerClient({ label: "models" })
    const init = await c.initialize()
    const list = await c.request<{ data: Json[] }>("model/list", {})
    const models = list.data.map((m) => ({
      id: m.id,
      model: m.model,
      isDefault: m.isDefault,
      hidden: m.hidden,
      defaultReasoningEffort: m.defaultReasoningEffort,
      supportedReasoningEfforts: (m.supportedReasoningEfforts as Json[] | undefined)?.map(
        (e) => e.reasoningEffort ?? e,
      ),
    }))
    await c.close()
    report("models", { init, models })
  },

  async turn() {
    const repo = makeRepo("repo-turn")
    const c = new AppServerClient({ label: "turn" })
    const init = await c.initialize()
    const threadId = await startThread(c, repo)
    const { completed } = await runTurn(c, threadId, "Responde exactamente con la palabra: listo")
    await c.close()
    report("turn", {
      apiKeyInEnv: Boolean(process.env.OPENAI_API_KEY || process.env.CODEX_API_KEY),
      init,
      pid: c.pid,
      turn: turnSummary(completed),
      answer: lastAgentMessage(c),
      notificationMethods: c.methodCounts(),
      itemTypes: itemTypes(c),
      tokenUsage: tokenUsage(c),
      serverRequests: c.serverRequests.map((r) => r.method),
    })
  },

  async nologin() {
    const repo = makeRepo("repo-nologin")
    const home = mkdtempSync(join(root, "codex-home-vacio-"))
    const c = new AppServerClient({ label: "nologin", env: { CODEX_HOME: home } })
    const out: Json = { codexHome: "<vacío>" }
    try {
      out.init = await c.initialize()
      try {
        out.account = await c.request("account/read", {})
      } catch (e) {
        out.accountError = e instanceof RpcError ? e.error : String(e)
      }
      const threadId = await startThread(c, repo)
      out.threadStarted = true
      const res = await c.request<{ turn: { id: string } }>("turn/start", {
        threadId,
        input: [{ type: "text", text: "Responde: listo" }],
        ...turnOverrides(),
      })
      out.turnStarted = res.turn.id
      out.completed = turnSummary(await c.waitFor("turn/completed", 60_000))
    } catch (e) {
      out.failure = e instanceof RpcError ? { method: e.method, error: e.error } : String(e)
    }
    out.errors = errors(c)
    out.notificationMethods = c.methodCounts()
    out.serverRequests = c.serverRequests.map((r) => r.method)
    await c.close()
    rmSync(home, { recursive: true, force: true })
    report("nologin", out)
  },

  async approval() {
    const repo = makeRepo("repo-approval")
    const target = join(repo, "keel-approval-probe.txt")
    const delayMs = Number(process.env.KEEL_SPIKE_APPROVAL_DELAY_MS ?? 20_000)
    const timeline: Json[] = []
    const c = new AppServerClient({
      label: "approval",
      onServerRequest: async (method, params) => {
        timeline.push({ at: Date.now(), event: "request", method, command: params.command })
        if (method === "item/commandExecution/requestApproval") {
          await sleep(delayMs)
          timeline.push({ at: Date.now(), event: "decline" })
          return { decision: "decline" }
        }
        if (method === "item/fileChange/requestApproval") return { decision: "decline" }
        return undefined
      },
    })
    await c.initialize()
    const threadId = await startThread(c, repo, { approvalPolicy: "untrusted" })
    const started = Date.now()
    const { completed } = await runTurn(
      c,
      threadId,
      "Ejecuta exactamente este comando de shell y nada más: touch keel-approval-probe.txt",
    )
    await c.close()
    report("approval", {
      delayMs,
      turn: turnSummary(completed),
      fileExists: existsSync(target),
      timeline: timeline.map((t) => ({ ...t, at: Number(t.at) - started })),
      notificationsDuringWait: c.notifications
        .filter((n) => {
          const req = timeline.find((t) => t.event === "request")
          const dec = timeline.find((t) => t.event === "decline")
          return req && dec && n.at > Number(req.at) && n.at < Number(dec.at)
        })
        .map((n) => n.method),
      serverRequests: c.serverRequests.map((r) => r.method),
      commandItems: c.notifications
        .filter((n) => n.method === "item/completed")
        .map((n) => n.params.item as Json)
        .filter((i) => i.type === "commandExecution")
        .map((i) => ({ status: i.status, exitCode: i.exitCode, command: i.command })),
      answer: lastAgentMessage(c),
    })
  },

  async concurrent() {
    const one = async (label: string, word: string) => {
      const repo = makeRepo(`repo-${label}`)
      const c = new AppServerClient({ label })
      await c.initialize()
      const threadId = await startThread(c, repo)
      const { completed } = await runTurn(c, threadId, `Responde exactamente con: ${word}`)
      await c.close()
      const foreign = c.notifications.filter((n) => {
        const t = n.params.threadId
        return typeof t === "string" && t !== threadId
      }).length
      return {
        pid: c.pid,
        threadId,
        turn: turnSummary(completed),
        answer: lastAgentMessage(c),
        notificationsFromOtherThreads: foreign,
      }
    }
    const [a, b] = await Promise.all([one("concurrent-a", "alfa"), one("concurrent-b", "beta")])
    report("concurrent", { a, b, distinctPids: a.pid !== b.pid })
  },

  async interrupt() {
    const repo = makeRepo("repo-interrupt")
    const c = new AppServerClient({ label: "interrupt" })
    await c.initialize()
    const threadId = await startThread(c, repo)
    const res = await c.request<{ turn: { id: string } }>("turn/start", {
      threadId,
      input: [{ type: "text", text: "Ejecuta exactamente este comando de shell: sleep 40" }],
      ...turnOverrides(),
    })
    const turnId = res.turn.id
    const t0 = Date.now()
    let trigger = "timeout"
    try {
      await c.waitFor(
        "item/started",
        90_000,
        (p) => (p.item as Json | undefined)?.type === "commandExecution",
      )
      trigger = "commandExecution started"
    } catch {}
    const sleepPids = spawnSync("pgrep", ["-f", "sleep 40"], { encoding: "utf8" }).stdout.trim()
    const sentAt = Date.now()
    const interruptResult = await c.request("turn/interrupt", { threadId, turnId })
    const completed = await c.waitFor(
      "turn/completed",
      60_000,
      (p) => (p.turn as Json | undefined)?.id === turnId,
    )
    const completedAfterMs = Date.now() - sentAt
    // Con el app-server todavía vivo: ¿el interrupt mató el comando o sólo cerró el turno?
    const procs = () =>
      spawnSync("pgrep", ["-af", "sleep 40"], { encoding: "utf8" })
        .stdout.trim()
        .split("\n")
        .filter((l) => l && !l.includes("pgrep"))
    const afterInterrupt: Json = {}
    for (const s of [1, 5, 10]) {
      await sleep(s === 1 ? 1000 : s === 5 ? 4000 : 5000)
      afterInterrupt[`${s}s`] = procs()
    }
    const appServerAlive = alive(c.pid)
    await c.close()
    await sleep(500)
    report("interrupt", {
      trigger,
      waitedMs: sentAt - t0,
      interruptResult,
      completedAfterMs,
      turn: turnSummary(completed),
      sleepPidsBefore: sleepPids,
      afterInterrupt,
      appServerAliveDuringPolls: appServerAlive,
      afterAppServerExit: procs(),
      notificationMethods: c.methodCounts(),
      lastCommandItem: c.notifications
        .filter((n) => n.method === "item/completed")
        .map((n) => n.params.item as Json)
        .filter((i) => i.type === "commandExecution")
        .map((i) => ({ status: i.status, exitCode: i.exitCode }))
        .at(-1),
    })
  },

  /** Hijo de `orphan`: arranca un app-server, lanza `sleep 60` y espera a morir. */
  async "orphan-child"() {
    const repo = makeRepo("repo-orphan")
    const c = new AppServerClient({ label: "orphan-child" })
    await c.initialize()
    const threadId = await startThread(c, repo)
    await c.request("turn/start", {
      threadId,
      input: [{ type: "text", text: "Ejecuta exactamente este comando de shell: sleep 60" }],
      ...turnOverrides(),
    })
    await c.waitFor(
      "item/started",
      90_000,
      (p) => (p.item as Json | undefined)?.type === "commandExecution",
    )
    console.log(JSON.stringify({ appServerPid: c.pid }))
    await sleep(120_000)
  },

  async orphan() {
    const parent = Bun.spawn(["bun", import.meta.path, "orphan-child"], {
      stdout: "pipe",
      stderr: "inherit",
      env: process.env as Record<string, string>,
    })
    const decoder = new TextDecoder()
    let appServerPid = 0
    let buf = ""
    for await (const chunk of parent.stdout) {
      buf += decoder.decode(chunk)
      const m = buf.match(/"appServerPid":(\d+)/)
      if (m?.[1]) {
        appServerPid = Number(m[1])
        break
      }
    }
    const tree = (pid: number): number[] => {
      const kids = childrenOf(pid)
      return [pid, ...kids.flatMap(tree)]
    }
    const before = tree(appServerPid)
    const describe = (pids: number[]) =>
      pids.map((p) => ({
        pid: p,
        alive: alive(p),
        cmd: spawnSync("ps", ["-o", "args=", "-p", String(p)], { encoding: "utf8" }).stdout.trim(),
      }))
    const beforeDesc = describe(before)
    parent.kill("SIGKILL")
    await parent.exited
    await sleep(2000)
    const after2s = describe(before)
    await sleep(5000)
    const after7s = describe(before)
    const survivors = before.filter(alive)
    for (const p of survivors) process.kill(p, "SIGKILL")
    report("orphan", {
      appServerPid,
      treeBefore: beforeDesc,
      after2s,
      after7s,
      killedSurvivors: survivors,
    })
  },

  async sandbox() {
    const repo = makeRepo("repo-sandbox")
    // Fuera de /tmp a propósito: workspace-write deja /tmp escribible por defecto.
    const outside = mkdtempSync(join(homedir(), ".cache", "keel-spike-outside-"))
    const sock = join(outside, "keel.sock")
    const log = join(outside, "listener.log")
    const listenerCode = [
      "import socket,os,sys",
      `p=${JSON.stringify(sock)}`,
      "s=socket.socket(socket.AF_UNIX); s.bind(p); s.listen(5); s.settimeout(240)",
      "while True:",
      "  try: c,_=s.accept()",
      "  except Exception: break",
      `  open(${JSON.stringify(log)},'a').write('connected\\n'); c.sendall(b'hello'); c.close()`,
    ].join("\n")
    const listener = Bun.spawn(["python3", "-I", "-c", listenerCode], { stderr: "inherit" })
    await sleep(500)
    const outsideFile = join(outside, "escape.txt")
    const tmpEscape = join(root, "tmp-escape.txt")
    rmSync(tmpEscape, { force: true })
    const script = [
      `echo x > ${outsideFile} && echo WRITE_OUT_OK || echo WRITE_OUT_FAIL`,
      `echo x > ${tmpEscape} && echo WRITE_TMP_OK || echo WRITE_TMP_FAIL`,
      "curl -sS -m 8 -o /dev/null https://example.com && echo NET_OK || echo NET_FAIL",
      `python3 -I -c "import socket;s=socket.socket(socket.AF_UNIX);s.connect('${sock}');print('SOCK_OK',s.recv(5))" || echo SOCK_FAIL`,
    ]
    const c = new AppServerClient({ label: "sandbox" })
    await c.initialize()
    const threadId = await startThread(c, repo)
    const { completed } = await runTurn(
      c,
      threadId,
      `Ejecuta estos comandos de shell uno por uno, exactamente como están, sin pedir permisos, y responde con la salida literal de cada uno:\n${script.join("\n")}`,
    )
    await c.close()
    listener.kill()
    const commandItems = c.notifications
      .filter((n) => n.method === "item/completed")
      .map((n) => n.params.item as Json)
      .filter((i) => i.type === "commandExecution")
      .map((i) => ({
        command: i.command,
        exitCode: i.exitCode,
        status: i.status,
        output: String(i.aggregatedOutput ?? "").slice(0, 400),
      }))
    const result = {
      turn: turnSummary(completed),
      writeOutsideHomeExists: existsSync(outsideFile),
      writeTmpExists: existsSync(tmpEscape),
      socketConnections: existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").length : 0,
      commandItems,
      answer: lastAgentMessage(c),
    }
    rmSync(outside, { recursive: true, force: true })
    rmSync(tmpEscape, { force: true })
    report("sandbox", result)
  },

  /** 7b. Socket Unix dentro de una ruta escribible (/tmp): ¿lo bloquea seccomp o el FS? */
  async "socket-tmp"() {
    const repo = makeRepo("repo-socket-tmp")
    // Ruta corta: AF_UNIX admite ~108 bytes y el scratchpad es más largo.
    const dir = mkdtempSync(join("/tmp", "kspk-"))
    const sock = join(dir, "keel.sock")
    const log = join(dir, "listener.log")
    const listenerCode = [
      "import socket",
      `p=${JSON.stringify(sock)}`,
      "s=socket.socket(socket.AF_UNIX); s.bind(p); s.listen(5); s.settimeout(240)",
      "while True:",
      "  try: c,_=s.accept()",
      "  except Exception: break",
      `  open(${JSON.stringify(log)},'a').write('connected\\n'); c.sendall(b'hello'); c.close()`,
    ].join("\n")
    const listener = Bun.spawn(["python3", "-I", "-c", listenerCode], { stderr: "inherit" })
    await sleep(500)
    const c = new AppServerClient({ label: "socket-tmp" })
    await c.initialize()
    const threadId = await startThread(c, repo)
    const { completed } = await runTurn(
      c,
      threadId,
      `Ejecuta exactamente este comando de shell, sin pedir permisos, y responde con su salida literal:\npython3 -I -c "import socket;s=socket.socket(socket.AF_UNIX);s.connect('${sock}');print('SOCK_OK',s.recv(5))" || echo SOCK_FAIL`,
    )
    await c.close()
    listener.kill()
    const result = {
      turn: turnSummary(completed),
      socketConnections: existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").length : 0,
      commandItems: c.notifications
        .filter((n) => n.method === "item/completed")
        .map((n) => n.params.item as Json)
        .filter((i) => i.type === "commandExecution")
        .map((i) => ({
          exitCode: i.exitCode,
          output: String(i.aggregatedOutput ?? "").slice(-300),
        })),
    }
    rmSync(dir, { recursive: true, force: true })
    report("socket-tmp", result)
  },

  async dyntool() {
    const repo = makeRepo("repo-dyntool")
    const calls: Json[] = []
    const c = new AppServerClient({
      label: "dyntool",
      onServerRequest: (method, params) => {
        if (method !== "item/tool/call") return undefined
        calls.push(params)
        return { contentItems: [{ type: "inputText", text: "eco: hola-keel-42" }], success: true }
      },
    })
    await c.initialize(true)
    const threadId = await startThread(c, repo, {
      dynamicTools: [
        {
          type: "function",
          name: "keel_echo",
          description: "Devuelve un eco del texto. Herramienta de prueba de Keel.",
          inputSchema: {
            type: "object",
            properties: { text: { type: "string" } },
            required: ["text"],
            additionalProperties: false,
          },
        },
      ],
    })
    const { completed } = await runTurn(
      c,
      threadId,
      "Llama a la herramienta keel_echo con text='hola' y responde sólo con lo que devuelva.",
    )
    await c.close()
    report("dyntool", {
      turn: turnSummary(completed),
      calls,
      answer: lastAgentMessage(c),
      itemTypes: itemTypes(c),
    })
  },

  async sdk() {
    const { Codex } = await import("@openai/codex-sdk")
    const repo = makeRepo("repo-sdk")
    const env = Object.fromEntries(
      Object.entries(process.env).filter((e): e is [string, string] => typeof e[1] === "string"),
    )
    const codex = new Codex({ env })
    const opts = {
      workingDirectory: repo,
      sandboxMode: "workspace-write" as const,
      approvalPolicy: "never" as const,
      ...(model ? { model } : {}),
      ...(effort ? { modelReasoningEffort: effort as "low" } : {}),
    }
    const types: Record<string, number> = {}
    const t1 = codex.startThread(opts)
    const { events } = await t1.runStreamed("Responde exactamente con la palabra: listo")
    let usage: unknown = null
    let answer: string | null = null
    for await (const ev of events) {
      const e = ev as Json & { type: string }
      types[e.type] = (types[e.type] ?? 0) + 1
      if (e.type === "turn.completed") usage = e.usage
      const item = e.item as Json | undefined
      if (e.type === "item.completed" && item?.type === "agent_message") answer = String(item.text)
    }
    // Cancelación: aborta cuando arranca el comando.
    const ac = new AbortController()
    const t2 = codex.startThread(opts)
    const cancelTypes: string[] = []
    let cancelError: string | null = null
    const t0 = Date.now()
    try {
      const run = await t2.runStreamed("Ejecuta exactamente este comando de shell: sleep 40", {
        signal: ac.signal,
      })
      for await (const ev of run.events) {
        const e = ev as Json & { type: string }
        cancelTypes.push(e.type)
        if (e.type === "item.started" && (e.item as Json | undefined)?.type === "command_execution")
          ac.abort()
      }
    } catch (e) {
      cancelError = String(e)
    }
    await sleep(1000)
    const sleepAfter = spawnSync("pgrep", ["-f", "sleep 40"], { encoding: "utf8" }).stdout.trim()
    report("sdk", {
      eventTypes: types,
      usage,
      answer,
      threadIdAfterRun: t1.id,
      exposesPid: Object.keys(t1)
        .concat(Object.keys(codex))
        .some((k) => /pid|process|child/i.test(k)),
      cancel: { eventTypes: cancelTypes, error: cancelError, ms: Date.now() - t0, sleepAfter },
    })
  },
}

const name = process.argv[2] ?? ""
const cmd = commands[name]
if (!cmd) {
  console.error(`uso: bun src/probe.ts <${Object.keys(commands).join("|")}>`)
  process.exit(2)
}
await cmd()
process.exit(0)
