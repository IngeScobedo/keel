/**
 * Caminos de fallo del Claude Agent SDK bajo Bun (ADR-0003 §1.2 del handoff).
 *
 *   bun src/failure-probes.ts cancel          AbortController a mitad de un tool call
 *   bun src/failure-probes.ts sigkill         SIGKILL al proceso "daemon" con un run vivo
 *   bun src/failure-probes.ts late-permission hook y canUseTool que responden tarde
 *   bun src/failure-probes.ts concurrent      tres sesiones a la vez, sin cruces
 *   bun src/failure-probes.ts lag             escritura grande en bun:sqlite con hook pendiente
 *   bun src/failure-probes.ts all
 *
 * Mismas reglas que claude-probe.ts: binario del usuario, sin credenciales,
 * settingSources vacío, modelo haiku, herramientas mínimas.
 */

import { Database } from "bun:sqlite"
import { existsSync, mkdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import {
  type HookCallback,
  type HookCallbackMatcher,
  type HookInput,
  type Options,
  type PreToolUseHookInput,
  query,
} from "@anthropic-ai/claude-agent-sdk"
import { capturesDir, now, openCapture } from "./capture.js"

const here = dirname(fileURLToPath(import.meta.url))
const spikeDir = join(here, "..")
const claudePath = [
  join(process.env.HOME ?? "", ".local/bin/claude"),
  "/usr/local/bin/claude",
].find((p) => existsSync(p))
if (!claudePath) {
  console.error("No encuentro `claude`.")
  process.exit(2)
}
const baseOptions = (): Options => ({
  pathToClaudeCodeExecutable: claudePath,
  model: "haiku",
  cwd: spikeDir,
  settingSources: [],
  maxTurns: 6,
  permissionMode: "default",
  env: { ...process.env },
})

type Proc = { pid: number; ppid: number; etimes: number; args: string; cwd: string | null }
function claudeProcesses(): Proc[] {
  const out = Bun.spawnSync(["ps", "-eo", "pid,ppid,etimes,args"]).stdout.toString()
  const procs: Proc[] = []
  for (const line of out.split("\n").slice(1)) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/)
    if (!m) continue
    const args = m[4] ?? ""
    if (!/claude/.test(args) || /failure-probes|ps -eo/.test(args)) continue
    let cwd: string | null = null
    try {
      cwd = readlinkSync(`/proc/${m[1]}/cwd`)
    } catch {}
    procs.push({
      pid: Number(m[1]),
      ppid: Number(m[2]),
      etimes: Number(m[3]),
      args: args.slice(0, 160),
      cwd,
    })
  }
  return procs
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const reportPath = join(capturesDir, "report-failures.json")
function saveReport(name: string, data: object) {
  mkdirSync(capturesDir, { recursive: true })
  const all = existsSync(reportPath) ? JSON.parse(readFileSync(reportPath, "utf8")) : {}
  all[name] = { ran_at: now(), ...data }
  writeFileSync(reportPath, `${JSON.stringify(all, null, 2)}\n`)
  console.log(`\n=== ${name}\n${JSON.stringify(all[name], null, 2)}`)
}

/** Sólo permite `sleep N` y `echo …` en Bash: el probe no ejecuta nada más. */
const onlySleepOrEcho: HookCallback = async (input) => {
  const pre = input as PreToolUseHookInput
  if (pre.tool_name !== "Bash") return {}
  const cmd = String((pre.tool_input as { command?: string })?.command ?? "")
  if (/^(sleep \d+|echo [\w ]+)$/.test(cmd.trim())) {
    return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" } }
  }
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: "probe",
    },
  }
}

// ---------------------------------------------------------------------------
async function probeCancel() {
  const cap = openCapture("failure-cancel")
  const ac = new AbortController()
  const timeline: Record<string, number> = {}
  const t0 = Date.now()
  const mark = (k: string) => {
    timeline[k] = Date.now() - t0
  }
  const hooks: Record<string, HookCallbackMatcher[]> = {
    PreToolUse: [
      { matcher: "Bash", hooks: [onlySleepOrEcho] },
      {
        hooks: [
          async (input) => {
            mark(`PreToolUse:${(input as PreToolUseHookInput).tool_name}`)
            setTimeout(() => {
              mark("abort()")
              ac.abort()
            }, 1500)
            return {}
          },
        ],
      },
    ],
    PostToolUse: [{ hooks: [async () => (mark("PostToolUse"), {})] }],
    PostToolUseFailure: [{ hooks: [async () => (mark("PostToolUseFailure"), {})] }],
    Stop: [{ hooks: [async () => (mark("Stop"), {})] }],
    SessionEnd: [{ hooks: [async () => (mark("SessionEnd"), {})] }],
  }
  const before = claudeProcesses().map((p) => p.pid)
  let result: Record<string, unknown> | null = null
  let thrown: string | null = null
  let last: string | null = null
  let count = 0
  try {
    for await (const m of query({
      prompt: "Ejecuta con Bash el comando `sleep 20` y luego responde solo: done",
      options: { ...baseOptions(), allowedTools: ["Bash"], abortController: ac, hooks },
    })) {
      count++
      last = (m as { type: string }).type
      cap.write({ received_at: now(), ...(m as object) })
      if ((m as { type: string }).type === "result") result = m as Record<string, unknown>
    }
    mark("generator-done")
  } catch (e) {
    thrown = e instanceof Error ? `${e.name}: ${e.message}` : String(e)
    mark("throw")
  }
  await sleep(2000)
  const after = claudeProcesses().filter((p) => !before.includes(p.pid))
  for (const p of after) process.kill(p.pid, "SIGKILL")
  saveReport("cancel", {
    timeline_ms: timeline,
    messages: count,
    last_message_type: last,
    result_subtype: result?.subtype ?? null,
    result_is_error: result?.is_error ?? null,
    result_errors: result?.errors ?? null,
    thrown,
    claude_processes_left_after_2s: after,
    capture: cap.path,
  })
}

// ---------------------------------------------------------------------------
async function childLongRun() {
  const marker = process.env.KEEL_PROBE_MARKER ?? ""
  for await (const m of query({
    prompt: "Ejecuta con Bash el comando `sleep 45` y luego responde solo: done",
    options: {
      ...baseOptions(),
      allowedTools: ["Bash"],
      hooks: {
        PreToolUse: [
          { matcher: "Bash", hooks: [onlySleepOrEcho] },
          {
            hooks: [
              async (input: HookInput) => {
                writeFileSync(marker, JSON.stringify({ session_id: input.session_id, at: now() }))
                return {}
              },
            ],
          },
        ],
      },
    },
  })) {
    const mm = m as { type: string; subtype?: string; session_id?: string }
    console.log(
      `[child] ${now()} ${mm.type}${mm.subtype ? `/${mm.subtype}` : ""} ${mm.session_id ?? ""}`,
    )
  }
}

/** Todos los procesos cuyo árbol de ancestros pasa por `root` (snapshot de `ps`). */
function descendantsOf(root: number): Proc[] {
  const out = Bun.spawnSync(["ps", "-eo", "pid,ppid,etimes,args"]).stdout.toString()
  const all: Proc[] = []
  for (const line of out.split("\n").slice(1)) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/)
    if (m)
      all.push({
        pid: Number(m[1]),
        ppid: Number(m[2]),
        etimes: Number(m[3]),
        args: (m[4] ?? "").slice(0, 160),
        cwd: null,
      })
  }
  const byPid = new Map(all.map((p) => [p.pid, p]))
  const isDesc = (p: Proc): boolean => {
    let cur: Proc | undefined = p
    for (let i = 0; i < 32 && cur; i++) {
      if (cur.ppid === root) return true
      cur = byPid.get(cur.ppid)
    }
    return false
  }
  return all.filter(isDesc).map((p) => {
    try {
      p.cwd = readlinkSync(`/proc/${p.pid}/cwd`)
    } catch {}
    return p
  })
}

async function probeSigkill() {
  const marker = join(capturesDir, "sigkill.marker")
  rmSync(marker, { force: true })
  const childLog = join(capturesDir, "sigkill-child.log")
  const t0 = Date.now()
  const child = Bun.spawn(["bun", join(here, "failure-probes.ts"), "child-long-run"], {
    env: { ...process.env, KEEL_PROBE_MARKER: marker },
    stdout: Bun.file(childLog),
    stderr: Bun.file(childLog),
  })
  while (!existsSync(marker) && Date.now() - t0 < 60000) await sleep(200)
  const markerData = existsSync(marker) ? JSON.parse(readFileSync(marker, "utf8")) : null
  await sleep(1500) // deja que el `sleep 45` arranque de verdad
  // Sólo el subárbol de NUESTRO proceso hijo: nunca se juzga ni se mata por nombre.
  const tree = descendantsOf(child.pid)
  child.kill("SIGKILL")
  await child.exited
  const killedAt = Date.now() - t0
  await sleep(3000)
  const survivors = tree.filter((p) => existsSync(`/proc/${p.pid}`))
  const detail = survivors.map((p) => {
    let ppidNow = -1
    try {
      ppidNow = Number(readFileSync(`/proc/${p.pid}/stat`, "utf8").split(") ")[1]?.split(" ")[1])
    } catch {}
    return {
      pid: p.pid,
      args: p.args,
      cwd: p.cwd,
      ppid_now: ppidNow,
      reparented: ppidNow !== child.pid,
      reconcilable_by_cwd: p.cwd === spikeDir,
      has_session_id_in_args: markerData ? p.args.includes(markerData.session_id) : false,
    }
  })
  for (const p of survivors) {
    try {
      process.kill(p.pid, "SIGKILL")
    } catch {}
  }
  await sleep(500)
  saveReport("sigkill", {
    marker: markerData,
    child_pid: child.pid,
    killed_at_ms: killedAt,
    subtree_while_alive: tree.map((p) => ({ pid: p.pid, args: p.args.slice(0, 90) })),
    survivors_after_3s: detail,
    survivors_left_after_cleanup: survivors.filter((p) => existsSync(`/proc/${p.pid}`)).length,
    child_log: childLog,
  })
}

// ---------------------------------------------------------------------------
async function probeLatePermission() {
  const cap = openCapture("failure-late-permission")
  const t0 = Date.now()
  const events: { at: number; what: string; detail?: unknown }[] = []
  const log = (what: string, detail?: unknown) => events.push({ at: Date.now() - t0, what, detail })
  // Caso A: hook PreToolUse con timeout de 3 s que tarda 8 s en responder "allow".
  const slowHook: HookCallback = async (_input, _id, { signal }) => {
    log("slowHook:start")
    await new Promise((r) => setTimeout(r, 8000))
    log("slowHook:done", { aborted: signal.aborted })
    return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" } }
  }
  // Caso B: canUseTool que responde "allow" 8 s después (sin hook; herramienta fuera de allowedTools).
  const results: Record<string, unknown> = {}
  for (const variant of ["hook-timeout", "canUseTool-late"] as const) {
    const opts: Options = {
      ...baseOptions(),
      allowedTools: variant === "hook-timeout" ? ["Bash"] : [],
      hooks:
        variant === "hook-timeout"
          ? {
              PreToolUse: [
                { matcher: "Bash", hooks: [onlySleepOrEcho] },
                { matcher: "Bash", hooks: [slowHook], timeout: 3 },
              ],
            }
          : { PreToolUse: [{ matcher: "Bash", hooks: [onlySleepOrEcho] }] },
      ...(variant === "canUseTool-late"
        ? {
            canUseTool: async (
              toolName: string,
              input: Record<string, unknown>,
              { signal }: { signal: AbortSignal },
            ) => {
              log("canUseTool:start", { toolName })
              await new Promise((r) => setTimeout(r, 8000))
              log("canUseTool:answer", { aborted: signal.aborted })
              return { behavior: "allow" as const, updatedInput: input }
            },
          }
        : {}),
    }
    let result: Record<string, unknown> | null = null
    const toolResults: unknown[] = []
    log(`${variant}:query`)
    try {
      for await (const m of query({
        prompt: "Ejecuta con Bash el comando `echo probe` y responde solo: done",
        options: opts,
      })) {
        cap.write({ received_at: now(), variant, ...(m as object) })
        const mm = m as {
          type: string
          message?: { content?: { type: string; content?: unknown; is_error?: boolean }[] }
        }
        if (mm.type === "user" && mm.message?.content)
          for (const b of mm.message.content)
            if (b.type === "tool_result")
              toolResults.push({
                is_error: b.is_error,
                content: String(JSON.stringify(b.content)).slice(0, 200),
              })
        if (mm.type === "result") result = m as Record<string, unknown>
      }
    } catch (e) {
      log(`${variant}:throw`, e instanceof Error ? e.message : String(e))
    }
    results[variant] = {
      result_subtype: result?.subtype ?? null,
      result_text: String(result?.result ?? "").slice(0, 200),
      permission_denials: result?.permission_denials ?? null,
      tool_results: toolResults,
    }
    log(`${variant}:end`)
  }
  saveReport("late-permission", { events, results, capture: cap.path })
}

// ---------------------------------------------------------------------------
async function probeConcurrent() {
  const cap = openCapture("failure-concurrent")
  const words = ["alpha", "bravo", "charlie"]
  const perRun = words.map(() => ({
    init_session: null as string | null,
    hook_sessions: new Set<string>(),
    msg_sessions: new Set<string>(),
    echoed: null as string | null,
    hook_count: 0,
  }))
  await Promise.all(
    words.map(async (w, i) => {
      const slot = perRun[i]!
      const hook: HookCallback = async (input) => {
        slot.hook_count++
        slot.hook_sessions.add(input.session_id)
        return {}
      }
      for await (const m of query({
        prompt: `Ejecuta con Bash el comando \`echo ${w}\` y responde solo con la palabra que imprimió.`,
        options: {
          ...baseOptions(),
          allowedTools: ["Bash"],
          hooks: {
            PreToolUse: [{ matcher: "Bash", hooks: [onlySleepOrEcho] }, { hooks: [hook] }],
            PostToolUse: [{ hooks: [hook] }],
            Stop: [{ hooks: [hook] }],
          },
        },
      })) {
        const mm = m as { type: string; subtype?: string; session_id?: string; result?: string }
        cap.write({ received_at: now(), run: w, ...(m as object) })
        if (mm.session_id) slot.msg_sessions.add(mm.session_id)
        if (mm.type === "system" && mm.subtype === "init") slot.init_session = mm.session_id ?? null
        if (mm.type === "result")
          slot.echoed = String(mm.result ?? "")
            .trim()
            .slice(0, 40)
      }
    }),
  )
  const summary = perRun.map((s, i) => ({
    word: words[i],
    init_session: s.init_session,
    hook_count: s.hook_count,
    hook_sessions: [...s.hook_sessions],
    msg_sessions: [...s.msg_sessions],
    echoed: s.echoed,
    isolated:
      s.hook_sessions.size === 1 &&
      s.msg_sessions.size === 1 &&
      [...s.hook_sessions][0] === s.init_session,
    answer_matches: s.echoed?.toLowerCase().includes(words[i]!) ?? false,
  }))
  const sessions = new Set(summary.map((s) => s.init_session))
  saveReport("concurrent", {
    distinct_sessions: sessions.size,
    all_isolated: summary.every((s) => s.isolated && s.answer_matches),
    runs: summary,
    capture: cap.path,
  })
}

// ---------------------------------------------------------------------------
async function probeLag() {
  const dbPath = join(capturesDir, "lag-probe.sqlite")
  rmSync(dbPath, { force: true })
  const db = new Database(dbPath)
  db.exec(
    "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE ev(id INTEGER PRIMARY KEY, seq INTEGER, payload TEXT)",
  )
  // Medidor de lag del event loop: un setInterval de 10 ms; el lag es el mayor
  // hueco entre dos ticks consecutivos menos los 10 ms esperados.
  const ticks: number[] = [performance.now()]
  const ticker = setInterval(() => ticks.push(performance.now()), 10)
  const maxGap = () => {
    let g = 0
    for (let i = 1; i < ticks.length; i++)
      g = Math.max(g, (ticks[i] ?? 0) - (ticks[i - 1] ?? 0) - 10)
    return g
  }
  const payload = JSON.stringify({ raw: "x".repeat(2000) })
  const bigWrite = (rows: number) => {
    const t = performance.now()
    const ins = db.prepare("INSERT INTO ev(seq,payload) VALUES (?,?)")
    db.transaction(() => {
      for (let i = 0; i < rows; i++) ins.run(i, payload)
    })()
    return performance.now() - t
  }
  const timeline: Record<string, unknown> = {}
  const hook: HookCallback = async () => {
    timeline.max_loop_gap_before_hook_ms = Math.round(maxGap())
    timeline.hook_started_ms = Math.round(performance.now())
    const writeMs = bigWrite(50000) // 50k filas de 2 KB en una transacción, síncrono, en el hilo del hook
    timeline.sqlite_write_50k_rows_ms = Math.round(writeMs)
    return {}
  }
  let result: Record<string, unknown> | null = null
  const t0 = Date.now()
  for await (const m of query({
    prompt: "Ejecuta con Bash el comando `echo lag` y responde solo: done",
    options: {
      ...baseOptions(),
      allowedTools: ["Bash"],
      hooks: {
        PreToolUse: [
          { matcher: "Bash", hooks: [onlySleepOrEcho] },
          { matcher: "Bash", hooks: [hook] },
        ],
      },
    },
  })) {
    if ((m as { type: string }).type === "result") result = m as Record<string, unknown>
  }
  clearInterval(ticker)
  timeline.max_loop_gap_during_run_ms = Math.round(maxGap())
  const sizeMb = Math.round((Bun.file(dbPath).size / 1e6) * 10) / 10
  db.close()
  // Referencia: la misma escritura en un Worker no bloquea el hilo principal.
  const worker = new Worker(new URL("./lag-worker.ts", import.meta.url))
  let workerLag = 0
  let wl = performance.now()
  const wt = setInterval(() => {
    const t = performance.now()
    workerLag = Math.max(workerLag, t - wl - 10)
    wl = t
  }, 10)
  const workerMs = await new Promise<number>((resolve) => {
    worker.onmessage = (e) => resolve(e.data as number)
    worker.postMessage({ dbPath: `${dbPath}.worker`, rows: 50000 })
  })
  clearInterval(wt)
  worker.terminate()
  saveReport("lag", {
    ...timeline,
    db_size_mb: sizeMb,
    run_wall_ms: Date.now() - t0,
    result_subtype: result?.subtype ?? null,
    tool_ran: String(result?.result ?? "")
      .toLowerCase()
      .includes("done"),
    reference_worker: {
      sqlite_write_50k_rows_ms: Math.round(workerMs),
      max_main_thread_lag_ms: Math.round(workerLag),
    },
  })
}

const which = process.argv[2] ?? "all"
const probes: Record<string, () => Promise<void>> = {
  cancel: probeCancel,
  sigkill: probeSigkill,
  "late-permission": probeLatePermission,
  concurrent: probeConcurrent,
  lag: probeLag,
  "child-long-run": childLongRun,
}
if (which === "all") {
  for (const name of ["cancel", "sigkill", "late-permission", "concurrent", "lag"])
    await probes[name]!()
} else if (probes[which]) await probes[which]!()
else {
  console.error(`probe desconocido: ${which}`)
  process.exit(2)
}
