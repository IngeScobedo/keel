/**
 * La correlacion contra los 6,721 eventos reales redactados (ADR-008 + ADR-010 + F1-F3).
 * Los numeros pineados salen de un oraculo independiente en Python sobre el snapshot
 * crudo, no de esta implementacion: si divergen, el bug es del codigo, no del test.
 */
import { beforeAll, describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import {
  type AgentEvent,
  type CorrelationSnapshot,
  createCorrelator,
  type HookLine,
  hookLineSchema,
} from "../src/index.ts"

const FIXTURES = resolve(import.meta.dir, "..", "__fixtures__")
const BIG_SESSION = "28d4a9bf-8064-eb49-3db2-23e2fefcf816" // fc807786 redactada: 5,672 eventos
const COMPACT_SESSION = "6411e415-36f1-8936-66a4-1713017bc1f0" // [fork, resume, compact]

let lines: HookLine[] = []
let envelopes: AgentEvent[] = []
let snap: CorrelationSnapshot
let NOW = 0

function newCorrelator() {
  let n = 0
  return createCorrelator({ newRunId: () => `run-${String(++n).padStart(4, "0")}` })
}

beforeAll(() => {
  const files = readdirSync(FIXTURES)
    .filter((f) => f.endsWith(".ndjson"))
    .sort()
  expect(files).toHaveLength(4)
  for (const f of files) {
    for (const text of readFileSync(join(FIXTURES, f), "utf8").split("\n")) {
      if (text.trim().length === 0) continue
      const parsed = hookLineSchema.safeParse(JSON.parse(text))
      if (!parsed.success) throw new Error(`fixture invalido en ${f}: ${parsed.error.message}`)
      lines.push(parsed.data)
    }
  }
  lines = [...lines].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  const c = newCorrelator()
  envelopes = lines.map((l) => c.ingest(l))
  const last = lines[lines.length - 1]
  NOW = Date.parse(last ? last.received_at : "2026-08-24T23:00:00.000Z") + 3_600_000
  snap = c.snapshot(NOW)
})

describe("ingesta completa", () => {
  test("6,721 eventos entran; ninguno se descarta; todos con run_id y kind", () => {
    expect(envelopes).toHaveLength(6721)
    for (const e of envelopes) {
      expect(e.run_id.length).toBeGreaterThan(0)
      expect(e.kind.length).toBeGreaterThan(0)
    }
  })

  test("determinista: dos pasadas dan el mismo snapshot", () => {
    const c2 = newCorrelator()
    for (const l of lines) c2.ingest(l)
    expect(c2.snapshot(NOW)).toEqual(snap)
  })
})

describe("tool calls (oraculo: 2004 pre; 1961 done; 35 failed; 8 sin cierre)", () => {
  test("total 2004 — PostToolBatch (1622) no genera ni duplica (ADR-008 p.3)", () => {
    expect(snap.tool_calls).toHaveLength(2004)
    const batches = envelopes.filter((e) => e.kind === "PostToolBatch")
    expect(batches).toHaveLength(1622)
    for (const e of batches) expect(e.tool_use_id).toBeNull()
  })

  test("estados: 1961 done, 35 failed, 8 orphan, 0 pending", () => {
    const byState = { pending: 0, done: 0, failed: 0, orphan: 0 }
    for (const tc of snap.tool_calls) byState[tc.state] += 1
    expect(byState).toEqual({ pending: 0, done: 1961, failed: 35, orphan: 8 })
  })

  test("tool_use_id vino siempre: sin sintesis (ADR-008 p.4)", () => {
    for (const e of envelopes) {
      if (e.kind === "PreToolUse" || e.kind === "PostToolUse" || e.kind === "PostToolUseFailure") {
        expect(e.tool_use_id).not.toBeNull()
      }
    }
  })

  test("gates: los 31 PermissionRequest emparejan por heuristica", () => {
    expect(envelopes.filter((e) => e.kind === "PermissionRequest")).toHaveLength(31)
    expect(snap.tool_calls.filter((tc) => tc.gated_heuristic)).toHaveLength(31)
  })

  test("F3: wall time real vs dispatch — el AskUserQuestion de 27 minutos deja de mentir", () => {
    const ask = snap.tool_calls
      .filter((tc) => tc.tool_name === "AskUserQuestion" && tc.wall_ms !== null)
      .sort((a, b) => (b.wall_ms ?? 0) - (a.wall_ms ?? 0))
    const worst = ask[0]
    expect(worst).toBeDefined()
    // 27.4 minutos de pared frente a 2 ms de dispatch interno
    expect(worst?.wall_ms).toBeGreaterThan(1_600_000)
    expect(worst?.duration_ms).toBeLessThanOrEqual(10)
  })

  test("A: 1953/2004 tool calls llevan etiqueta derivada de tool_input", () => {
    expect(snap.tool_calls.filter((tc) => tc.label !== null)).toHaveLength(1953)
    const bash = snap.tool_calls.find((tc) => tc.tool_name === "Bash" && tc.label !== null)
    expect(bash?.label?.length).toBeGreaterThan(0)
  })
})

describe("agentes (oraculo: 97 no-root; 60 utilitarios; 37 workers)", () => {
  test("97 no-root: 60 utility, 37 worker; agent_type '' nunca sobrevive", () => {
    const nonRoot = snap.agents.filter((a) => a.classification !== "root")
    expect(new Set(nonRoot.map((a) => a.agent_id)).size).toBe(97)
    expect(
      new Set(nonRoot.filter((a) => a.classification === "utility").map((a) => a.agent_id)).size,
    ).toBe(60)
    expect(
      new Set(nonRoot.filter((a) => a.classification === "worker").map((a) => a.agent_id)).size,
    ).toBe(37)
    for (const a of snap.agents) expect(a.agent_type).not.toBe("")
  })

  test("los utilitarios no tienen tool calls", () => {
    for (const a of snap.agents.filter((x) => x.classification === "utility")) {
      expect(a.tool_calls).toEqual({ pending: 0, done: 0, failed: 0, orphan: 0 })
    }
  })

  test("73% de los tool calls ocurren en subagentes (1466/2004)", () => {
    expect(snap.tool_calls.filter((tc) => !tc.agent_id.startsWith("root:"))).toHaveLength(1466)
  })

  test("ADR-010: resolucion de padres 35/37, sin discrepancias", () => {
    const workers = snap.agents.filter((a) => a.classification === "worker")
    // 2 pendientes: workflow-subagents sin transcript aun y sin workflow conocido en su
    // turno — el modelo los deja pendientes, jamas colgados de un agente (F1)
    expect(workers.filter((a) => a.parent_pending)).toHaveLength(2)
    expect(workers.filter((a) => a.parent_discrepancy)).toHaveLength(0)
    const bySource = { transcript: 0, launch: 0, prompt: 0 }
    for (const a of workers) {
      if (a.parent_source !== null) bySource[a.parent_source] += 1
    }
    expect(bySource).toEqual({ transcript: 26, launch: 2, prompt: 7 })
  })

  test("F1: ningun workflow-subagent cuelga de un agente; los del mismo turno van al mismo wf_", () => {
    const wfSubs = snap.agents.filter((a) => a.agent_type === "workflow-subagent")
    expect(wfSubs.length).toBeGreaterThan(0)
    for (const a of wfSubs) {
      expect(a.parent_kind).not.toBe("agent")
    }
    // la evidencia de la revision: subagentes resueltos a su wf_ por turno (canal prompt)
    expect(
      wfSubs.filter((a) => a.parent_source === "prompt" && a.parent_kind === "workflow"),
    ).toHaveLength(3)
    // y todos los resueltos del mismo turno comparten wf_: por construccion del canal,
    // verificado aqui agrupando por (run, source=prompt)
    const byRun = new Map<string, Set<string>>()
    for (const a of wfSubs.filter((x) => x.parent_source === "prompt")) {
      const set = byRun.get(a.run_id) ?? new Set()
      if (a.parent_agent_id !== null) set.add(a.parent_agent_id)
      byRun.set(a.run_id, set)
    }
    for (const set of byRun.values()) expect(set.size).toBe(1)
  })

  test("ADR-010: cada padre-workflow tiene su nodo-task en el run", () => {
    const wfParents = snap.agents.filter((a) => a.parent_kind === "workflow")
    expect(wfParents).toHaveLength(29)
    for (const a of wfParents) {
      const task = snap.tasks.find(
        (t) => t.run_id === a.run_id && t.wf_run_id === a.parent_agent_id,
      )
      expect(task).toBeDefined()
      expect(task?.task_type).toBe("workflow")
    }
  })

  test("F2: StopFailure es terminal con razon — 6 agentes, razones del CLI legibles", () => {
    const failed = snap.agents.filter((a) => a.stop_failure_error !== null)
    expect(failed).toHaveLength(6)
    expect(new Set(failed.map((a) => a.stop_failure_error))).toEqual(
      new Set(["rate_limit", "server_error"]),
    )
    for (const a of failed) expect(a.stop_failure_at).not.toBeNull()
  })

  test("C: peticion y respuesta de subagentes expuestas", () => {
    const workers = snap.agents.filter((a) => a.classification === "worker")
    expect(workers.filter((a) => a.request_prompt !== null)).toHaveLength(2) // solo Agent trae prompt
    expect(
      new Set(snap.agents.filter((a) => a.last_assistant_message !== null).map((a) => a.agent_id))
        .size,
    ).toBe(71)
    expect(
      new Set(
        snap.agents.filter((a) => a.structured_output_event_id !== null).map((a) => a.agent_id),
      ).size,
    ).toBe(21)
  })
})

describe("runs (ADR-010)", () => {
  test("26 runs: 14 administrativos, 3 por timeout; la sesion grande son 6 encadenados", () => {
    expect(snap.runs).toHaveLength(26)
    expect(snap.runs.filter((r) => r.administrative)).toHaveLength(14)
    expect(snap.runs.filter((r) => r.end_reason === "timeout")).toHaveLength(3)
    const runs = snap.runs.filter((r) => r.session_id === BIG_SESSION)
    expect(runs).toHaveLength(6)
    expect(runs.reduce((acc, r) => acc + r.event_count, 0)).toBe(5672)
    for (let i = 1; i < runs.length; i++) {
      expect(runs[i]?.previous_run_id).toBe(runs[i - 1]?.run_id ?? null)
    }
  })

  test("F2: la causa real del final gana a la inferencia — 3 runs con stop_failure", () => {
    const failed = snap.runs.filter((r) => r.stop_failure_error !== null)
    expect(failed.map((r) => r.stop_failure_error).sort()).toEqual([
      "rate_limit",
      "rate_limit",
      "server_error",
    ])
  })

  test("SessionStart(compact) NO abre run; resume/fork SI (8 aperturas)", () => {
    const sourceOf = (e: AgentEvent) =>
      typeof e.raw === "object" && e.raw !== null
        ? String((e.raw as Record<string, unknown>).source)
        : ""
    const compacts = envelopes.filter((e) => e.kind === "SessionStart" && sourceOf(e) === "compact")
    expect(compacts).toHaveLength(1)
    for (const cs of compacts) {
      const prev = [...envelopes]
        .reverse()
        .find((e) => e.session_id === cs.session_id && e.id < cs.id)
      expect(prev?.run_id).toBe(cs.run_id)
    }
    const opens = envelopes.filter(
      (e) => e.kind === "SessionStart" && ["resume", "fork"].includes(sourceOf(e)),
    )
    expect(opens).toHaveLength(8)
    for (const o of opens) {
      const prev = [...envelopes]
        .reverse()
        .find((e) => e.session_id === o.session_id && e.id < o.id)
      if (prev) expect(prev.run_id).not.toBe(o.run_id)
    }
  })

  test("la sesion [fork,resume,compact] registra compaction_seq=1", () => {
    const runs = snap.runs.filter((r) => r.session_id === COMPACT_SESSION)
    expect(runs.reduce((acc, r) => acc + r.compaction_seq, 0)).toBe(1)
  })

  test("gap > 60 min entre ACTIVIDADES reales implica run distinto", () => {
    const ACTIVITY = new Set([
      "UserPromptSubmit",
      "PreToolUse",
      "PostToolUse",
      "PostToolUseFailure",
      "SubagentStart",
      "SubagentStop",
      "PermissionRequest",
    ])
    const bySession = new Map<string, AgentEvent[]>()
    for (const e of envelopes) {
      if (!ACTIVITY.has(e.kind)) continue
      const list = bySession.get(e.session_id) ?? []
      list.push(e)
      bySession.set(e.session_id, list)
    }
    for (const events of bySession.values()) {
      for (let i = 1; i < events.length; i++) {
        const prev = events[i - 1]
        const cur = events[i]
        if (!prev || !cur) continue
        if (Date.parse(cur.received_at) - Date.parse(prev.received_at) > 60 * 60_000) {
          expect(cur.run_id).not.toBe(prev.run_id)
        }
      }
    }
  })

  test("F7/D: live honesto, start_source y model/effort medidos", () => {
    // NOW es ultimo evento + 1h: solo el run que contiene ese ultimo evento queda en el
    // borde exacto de la ventana de 60 min; todo lo demas esta inactivo aunque "abierto"
    expect(snap.runs.filter((r) => r.ended_at === null)).toHaveLength(6)
    expect(snap.runs.filter((r) => r.live)).toHaveLength(1)
    const bySource = new Map<string, number>()
    for (const r of snap.runs) {
      const k = r.start_source ?? "(actividad)"
      bySource.set(k, (bySource.get(k) ?? 0) + 1)
    }
    expect(Object.fromEntries(bySource)).toEqual({
      startup: 11,
      resume: 7,
      fork: 1,
      "(actividad)": 7,
    })
    expect([...new Set(snap.runs.map((r) => r.model).filter((m) => m !== null))].sort()).toEqual([
      "claude-fable-5",
      "claude-opus-5[1m]",
    ])
    expect([...new Set(snap.runs.map((r) => r.effort_level).filter((e) => e !== null))]).toEqual([
      "xhigh",
    ])
  })

  test("backlog E: dos proyectos distinguibles por project_slug (7 + 18 runs, 1 nulo)", () => {
    const bySlug = new Map<string, number>()
    for (const r of snap.runs) {
      const key = r.project_slug ?? "(null)"
      bySlug.set(key, (bySlug.get(key) ?? 0) + 1)
    }
    const counts = [...bySlug.values()].sort((a, b) => a - b)
    expect(bySlug.size).toBe(3) // cc-ui, monorepo del cliente, y la linea sin transcript
    expect(counts).toEqual([1, 7, 18])
  })

  test("transcript_path 1:1 con session_id (15, mas la linea sin sesion)", () => {
    const sessions = new Set(snap.runs.map((r) => r.session_id))
    expect(sessions.size).toBe(16) // 15 reales + "(sin session_id)" de la linea basura
    const withPath = snap.runs.filter((r) => r.transcript_path !== null)
    expect(new Set(withPath.map((r) => r.transcript_path)).size).toBe(15)
  })
})

describe("background tasks (oraculo: 24 ids en bt + 1 wf materializada; 5 taxonomias)", () => {
  test("25 tareas distintas, 5 taxonomias, 6 nodos workflow", () => {
    expect(new Set(snap.tasks.map((t) => t.task_id)).size).toBe(25)
    expect([...new Set(snap.tasks.map((t) => t.task_type))].sort()).toEqual([
      "monitor",
      "shell",
      "subagent",
      "teammate",
      "workflow",
    ])
    expect(snap.tasks.filter((t) => t.wf_run_id !== null)).toHaveLength(6)
  })

  test("estados de task: nada finge running en un dataset congelado", () => {
    const byState = { running: 0, gone: 0, orphan: 0 }
    for (const t of snap.tasks) byState[t.state] += 1
    expect(byState).toEqual({ running: 0, gone: 16, orphan: 13 })
  })
})
