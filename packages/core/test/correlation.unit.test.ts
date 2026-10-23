import { describe, expect, test } from "bun:test"
import {
  type CorrelatorOptions,
  createCorrelator,
  encodeUlid,
  type HookLine,
  toolCallLabel,
  ulidTime,
} from "../src/index.ts"

let seq = 0
function line(raw: Record<string, unknown>, at: string, id?: string): HookLine {
  seq += 1
  return {
    id: id ?? `01TEST${String(seq).padStart(20, "0")}`,
    received_at: at,
    hook_event_name: typeof raw.hook_event_name === "string" ? raw.hook_event_name : null,
    cwd: typeof raw.cwd === "string" ? raw.cwd : null,
    session_id: typeof raw.session_id === "string" ? raw.session_id : null,
    raw,
  }
}

function correlator(opts: Partial<CorrelatorOptions> = {}) {
  let n = 0
  return createCorrelator({
    newRunId: () => `run-${String(++n).padStart(3, "0")}`,
    ...opts,
  })
}

const T0 = "2026-08-24T10:00:00.000Z"
const T1 = "2026-08-24T10:00:01.000Z"
const T2 = "2026-08-24T10:00:02.000Z"

describe("runs", () => {
  test("SessionStart abre; source compact continua el MISMO run; resume abre uno nuevo ligado", () => {
    const c = correlator()
    const e1 = c.ingest(
      line({ session_id: "s", hook_event_name: "SessionStart", source: "startup" }, T0),
    )
    const e2 = c.ingest(
      line({ session_id: "s", hook_event_name: "PreCompact", trigger: "manual" }, T1),
    )
    const e3 = c.ingest(
      line({ session_id: "s", hook_event_name: "SessionStart", source: "compact" }, T2),
    )
    const e4 = c.ingest(
      line(
        { session_id: "s", hook_event_name: "SessionStart", source: "resume" },
        "2026-08-24T10:00:03.000Z",
      ),
    )
    expect(e2.run_id).toBe(e1.run_id)
    expect(e3.run_id).toBe(e1.run_id) // compact NO abre run (ADR-008 p.6)
    expect(e4.run_id).not.toBe(e1.run_id)
    const snap = c.snapshot()
    expect(snap.runs).toHaveLength(2)
    expect(snap.runs[0]?.compaction_seq).toBe(1)
    expect(snap.runs[0]?.end_reason).toBe("replaced")
    expect(snap.runs[1]?.previous_run_id).toBe(e1.run_id)
  })

  test("SessionEnd cierra; el siguiente evento abre run nuevo ligado", () => {
    const c = correlator()
    const e1 = c.ingest(
      line({ session_id: "s", hook_event_name: "SessionStart", source: "startup" }, T0),
    )
    c.ingest(line({ session_id: "s", hook_event_name: "SessionEnd", reason: "other" }, T1))
    const e3 = c.ingest(line({ session_id: "s", hook_event_name: "UserPromptSubmit" }, T2))
    expect(e3.run_id).not.toBe(e1.run_id)
    const runs = c.snapshot().runs
    expect(runs[0]?.end_reason).toBe("session_end")
    expect(runs[1]?.previous_run_id).toBe(e1.run_id)
  })

  test("inactividad > timeout parte el run; el gap corto no", () => {
    const c = correlator({ runTimeoutMs: 60_000 })
    const e1 = c.ingest(line({ session_id: "s", hook_event_name: "UserPromptSubmit" }, T0))
    const e2 = c.ingest(
      line({ session_id: "s", hook_event_name: "Stop" }, "2026-08-24T10:00:59.000Z"),
    )
    const e3 = c.ingest(
      line({ session_id: "s", hook_event_name: "UserPromptSubmit" }, "2026-08-24T10:02:00.000Z"),
    )
    expect(e2.run_id).toBe(e1.run_id)
    expect(e3.run_id).not.toBe(e1.run_id)
    expect(c.snapshot().runs[0]?.end_reason).toBe("timeout")
  })

  test("primer evento de sesion no vista abre run aunque no sea SessionStart", () => {
    const c = correlator()
    const e = c.ingest(
      line(
        { session_id: "s", hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "t1" },
        T0,
      ),
    )
    expect(e.run_id).toBe("run-001")
  })
})

describe("agentes", () => {
  test("sin agent_id = root del run; con agent_id = nodo propio; '' se normaliza a null", () => {
    const c = correlator()
    const root = c.ingest(line({ session_id: "s", hook_event_name: "UserPromptSubmit" }, T0))
    expect(root.agent_id).toBe(`root:${root.run_id}`)
    c.ingest(
      line(
        { session_id: "s", hook_event_name: "SubagentStop", agent_id: "a1", agent_type: "" },
        T1,
      ),
    )
    const agent = c.snapshot().agents.find((a) => a.agent_id === "a1")
    expect(agent?.agent_type).toBeNull()
  })

  test("padre por tool_response.agentId, en ambos ordenes de llegada", () => {
    const c = correlator()
    // orden real: SubagentStart llega antes que el PostToolUse(Agent) con agentId
    c.ingest(
      line(
        {
          session_id: "s",
          hook_event_name: "SubagentStart",
          agent_id: "hijo1",
          agent_type: "Explore",
        },
        T0,
      ),
    )
    c.ingest(
      line(
        {
          session_id: "s",
          hook_event_name: "PostToolUse",
          tool_name: "Agent",
          tool_use_id: "t1",
          tool_response: { agentId: "hijo1", status: "async_launched" },
        },
        T1,
      ),
    )
    // orden invertido: el link llega antes de conocer al hijo
    c.ingest(
      line(
        {
          session_id: "s",
          hook_event_name: "PostToolUse",
          tool_name: "Agent",
          tool_use_id: "t2",
          tool_response: { agentId: "hijo2" },
        },
        T1,
      ),
    )
    c.ingest(
      line(
        {
          session_id: "s",
          hook_event_name: "SubagentStart",
          agent_id: "hijo2",
          agent_type: "Explore",
        },
        T2,
      ),
    )
    const agents = c.snapshot().agents
    const h1 = agents.find((a) => a.agent_id === "hijo1")
    const h2 = agents.find((a) => a.agent_id === "hijo2")
    expect(h1?.parent_agent_id).toBe(`root:${agents[0]?.run_id}`)
    expect(h1?.parent_pending).toBe(false)
    expect(h2?.parent_agent_id).toBe(`root:${agents[0]?.run_id}`)
    expect(h2?.parent_pending).toBe(false)
  })

  test("subagente sin señal de lanzamiento queda parent_pending, nunca se descarta", () => {
    const c = correlator()
    c.ingest(
      line(
        {
          session_id: "s",
          hook_event_name: "PreToolUse",
          agent_id: "wf1",
          agent_type: "workflow-subagent",
          tool_name: "Read",
          tool_use_id: "t1",
        },
        T0,
      ),
    )
    const a = c.snapshot().agents.find((x) => x.agent_id === "wf1")
    expect(a?.parent_agent_id).toBeNull()
    expect(a?.parent_pending).toBe(true)
    expect(a?.classification).toBe("worker")
  })

  test("utilitario: SubagentStop sin SubagentStart y sin tool events (ADR-008 p.9)", () => {
    const c = correlator()
    c.ingest(
      line(
        {
          session_id: "s",
          hook_event_name: "SubagentStop",
          agent_id: "util1",
          agent_type: "",
          last_assistant_message: "titulo de la sesion",
        },
        T0,
      ),
    )
    expect(c.snapshot().agents.find((a) => a.agent_id === "util1")?.classification).toBe("utility")
  })

  test("NO es utilitario si su start/tools cayeron en un run anterior (hechos globales)", () => {
    const c = correlator({ runTimeoutMs: 60_000 })
    c.ingest(
      line(
        {
          session_id: "s",
          hook_event_name: "SubagentStart",
          agent_id: "a1",
          agent_type: "Explore",
        },
        T0,
      ),
    )
    // gap > timeout: el stop cae en un run nuevo
    c.ingest(
      line(
        { session_id: "s", hook_event_name: "SubagentStop", agent_id: "a1", agent_type: "" },
        "2026-08-24T10:10:00.000Z",
      ),
    )
    const agents = c.snapshot().agents.filter((a) => a.agent_id === "a1")
    expect(agents.some((a) => a.classification === "utility")).toBe(false)
  })
})

describe("ADR-010: canales de padre y semantica de run", () => {
  test("canal prompt: SubagentStart hereda el ultimo PreToolUse(Agent|Workflow) del turno", () => {
    const c = correlator()
    c.ingest(
      line(
        {
          session_id: "s",
          prompt_id: "p1",
          hook_event_name: "PreToolUse",
          tool_name: "Agent",
          tool_use_id: "t1",
        },
        T0,
      ),
    )
    c.ingest(
      line(
        {
          session_id: "s",
          prompt_id: "p1",
          hook_event_name: "SubagentStart",
          agent_id: "h1",
          agent_type: "Explore",
        },
        T1,
      ),
    )
    const h1 = c.snapshot().agents.find((a) => a.agent_id === "h1")
    expect(h1?.parent_pending).toBe(false)
    expect(h1?.parent_source).toBe("prompt")
    expect(h1?.parent_kind).toBe("agent")
    expect(h1?.parent_agent_id?.startsWith("root:")).toBe(true)
  })

  test("canal transcript pisa a prompt sin discrepancia (cadena compatible root->wf->hijo)", () => {
    const c = correlator()
    c.ingest(
      line(
        {
          session_id: "s",
          prompt_id: "p1",
          hook_event_name: "PreToolUse",
          tool_name: "Workflow",
          tool_use_id: "t1",
        },
        T0,
      ),
    )
    c.ingest(
      line(
        {
          session_id: "s",
          prompt_id: "p1",
          hook_event_name: "PostToolUse",
          tool_name: "Workflow",
          tool_use_id: "t1",
          tool_response: { runId: "wf_abc123-9x", taskId: "tsk123456" },
        },
        T0,
      ),
    )
    c.ingest(
      line(
        {
          session_id: "s",
          prompt_id: "p1",
          hook_event_name: "SubagentStart",
          agent_id: "h1",
          agent_type: "workflow-subagent",
        },
        T1,
      ),
    )
    c.ingest(
      line(
        {
          session_id: "s",
          prompt_id: "p1",
          hook_event_name: "SubagentStop",
          agent_id: "h1",
          agent_type: "",
          agent_transcript_path: "/x/subagents/workflows/wf_abc123-9x/agent-h1.jsonl",
        },
        T2,
      ),
    )
    const snap = c.snapshot()
    const h1 = snap.agents.find((a) => a.agent_id === "h1")
    expect(h1?.parent_agent_id).toBe("wf_abc123-9x")
    expect(h1?.parent_kind).toBe("workflow")
    expect(h1?.parent_source).toBe("transcript")
    expect(h1?.parent_discrepancy).toBe(false)
    const wf = snap.tasks.find((t) => t.wf_run_id === "wf_abc123-9x")
    expect(wf?.task_type).toBe("workflow")
    expect(wf?.task_id).toBe("tsk123456")
    expect(wf?.parent_agent_id?.startsWith("root:")).toBe(true)
  })

  test("discrepancia real entre canales se registra y gana la mayor precedencia", () => {
    const c = correlator()
    c.ingest(
      line(
        {
          session_id: "s",
          hook_event_name: "SubagentStart",
          agent_id: "h1",
          agent_type: "Explore",
        },
        T0,
      ),
    )
    c.ingest(
      line(
        {
          session_id: "s",
          hook_event_name: "PostToolUse",
          tool_name: "Agent",
          tool_use_id: "t1",
          tool_response: { agentId: "h1" },
        },
        T1,
      ),
    )
    // transcript apunta a un workflow cuyo lanzador NO es el padre previo: discrepa
    c.ingest(
      line(
        {
          session_id: "s",
          hook_event_name: "SubagentStop",
          agent_id: "h1",
          agent_type: "",
          agent_transcript_path: "/x/subagents/workflows/wf_otro9-9z/agent-h1.jsonl",
        },
        T2,
      ),
    )
    const h1 = c.snapshot().agents.find((a) => a.agent_id === "h1")
    expect(h1?.parent_agent_id).toBe("wf_otro9-9z")
    expect(h1?.parent_source).toBe("transcript")
    expect(h1?.parent_discrepancy).toBe(true)
  })

  test("administrativos se adhieren al run vecino y no abren run", () => {
    const c = correlator()
    const e1 = c.ingest(line({ session_id: "s", hook_event_name: "UserPromptSubmit" }, T0))
    c.ingest(line({ session_id: "s", hook_event_name: "SessionEnd", reason: "clear" }, T1))
    const e3 = c.ingest(line({ session_id: "s", hook_event_name: "ConfigChange" }, T2))
    expect(e3.run_id).toBe(e1.run_id) // se adhiere al run cerrado, no fabrica uno nuevo
    expect(c.snapshot().runs).toHaveLength(1)
  })

  test("SessionStart varado: el trabajo que llega tras una pausa larga cae en SU run", () => {
    const c = correlator({ runTimeoutMs: 30 * 60_000 })
    const e1 = c.ingest(
      line({ session_id: "s", hook_event_name: "SessionStart", source: "resume" }, T0),
    )
    const e2 = c.ingest(
      line({ session_id: "s", hook_event_name: "UserPromptSubmit" }, "2026-08-24T10:45:00.000Z"),
    )
    expect(e2.run_id).toBe(e1.run_id) // sin actividad previa no hay reloj que expirar
    expect(c.snapshot().runs[0]?.administrative).toBe(false)
  })

  test("una sesion sin actividad queda como un unico run administrative", () => {
    const c = correlator()
    c.ingest(line({ session_id: "s", hook_event_name: "SessionStart", source: "startup" }, T0))
    c.ingest(line({ session_id: "s", hook_event_name: "InstructionsLoaded" }, T1))
    c.ingest(line({ session_id: "s", hook_event_name: "SessionEnd", reason: "other" }, T2))
    const runs = c.snapshot().runs
    expect(runs).toHaveLength(1)
    expect(runs[0]?.administrative).toBe(true)
    expect(runs[0]?.end_reason).toBe("session_end")
  })

  test("default de 60 min: una pausa de 45 min ya no corta el run", () => {
    const c = correlator()
    const e1 = c.ingest(line({ session_id: "s", hook_event_name: "UserPromptSubmit" }, T0))
    const e2 = c.ingest(
      line({ session_id: "s", hook_event_name: "UserPromptSubmit" }, "2026-08-24T10:45:00.000Z"),
    )
    expect(e2.run_id).toBe(e1.run_id)
  })
})

describe("proyecto (backlog E)", () => {
  test("project_slug sale del transcript_path; sin transcript queda null", () => {
    const c = correlator()
    c.ingest(
      line(
        {
          session_id: "s",
          hook_event_name: "UserPromptSubmit",
          transcript_path: "/home/u/.claude/projects/-home-u-projects-acme-tienda/abc.jsonl",
        },
        T0,
      ),
    )
    c.ingest(line({ session_id: "s2", hook_event_name: "UserPromptSubmit" }, T0))
    const runs = c.snapshot().runs
    expect(runs.find((r) => r.session_id === "s")?.project_slug).toBe(
      "-home-u-projects-acme-tienda",
    )
    expect(runs.find((r) => r.session_id === "s2")?.project_slug).toBeNull()
  })
})

describe("F1/F2/F3: reglas de la revision externa", () => {
  test("F1: workflow-subagents del mismo turno van al mismo wf_, nunca a un agente", () => {
    const c = correlator()
    c.ingest(
      line(
        {
          session_id: "s",
          prompt_id: "p1",
          hook_event_name: "PreToolUse",
          tool_name: "Workflow",
          tool_use_id: "t1",
        },
        T0,
      ),
    )
    c.ingest(
      line(
        {
          session_id: "s",
          prompt_id: "p1",
          hook_event_name: "PostToolUse",
          tool_name: "Workflow",
          tool_use_id: "t1",
          tool_response: { runId: "wf_evid1-9x", taskId: "tsk999999" },
        },
        T0,
      ),
    )
    // replica de la evidencia: varios SubagentStart compartiendo prompt_id, sin transcript
    for (const id of ["wa1", "wa2", "wa3"]) {
      c.ingest(
        line(
          {
            session_id: "s",
            prompt_id: "p1",
            hook_event_name: "SubagentStart",
            agent_id: id,
            agent_type: "workflow-subagent",
          },
          T1,
        ),
      )
    }
    const snap = c.snapshot()
    for (const id of ["wa1", "wa2", "wa3"]) {
      const a = snap.agents.find((x) => x.agent_id === id)
      expect(a?.parent_agent_id).toBe("wf_evid1-9x")
      expect(a?.parent_kind).toBe("workflow")
      expect(a?.parent_source).toBe("prompt")
    }
  })

  test("F1: el canal launch tampoco puede colgar un workflow-subagent de un agente", () => {
    const c = correlator()
    c.ingest(
      line(
        {
          session_id: "s",
          hook_event_name: "SubagentStart",
          agent_id: "wa1",
          agent_type: "workflow-subagent",
        },
        T0,
      ),
    )
    c.ingest(
      line(
        {
          session_id: "s",
          hook_event_name: "PostToolUse",
          tool_name: "Agent",
          tool_use_id: "t1",
          tool_response: { agentId: "wa1" },
        },
        T1,
      ),
    )
    const a = c.snapshot().agents.find((x) => x.agent_id === "wa1")
    expect(a?.parent_agent_id).toBeNull()
    expect(a?.parent_pending).toBe(true)
  })

  test("F1: sin workflow conocido en el turno, el workflow-subagent queda pendiente (no root)", () => {
    const c = correlator()
    c.ingest(
      line(
        {
          session_id: "s",
          prompt_id: "p1",
          hook_event_name: "PreToolUse",
          tool_name: "Agent",
          tool_use_id: "t1",
        },
        T0,
      ),
    )
    c.ingest(
      line(
        {
          session_id: "s",
          prompt_id: "p1",
          hook_event_name: "SubagentStart",
          agent_id: "wa1",
          agent_type: "workflow-subagent",
        },
        T1,
      ),
    )
    const a = c.snapshot().agents.find((x) => x.agent_id === "wa1")
    expect(a?.parent_pending).toBe(true)
  })

  test("F2: StopFailure marca al agente y a la causa del run; una actividad posterior la limpia del run", () => {
    const c = correlator()
    c.ingest(line({ session_id: "s", hook_event_name: "UserPromptSubmit", prompt_id: "p1" }, T0))
    c.ingest(line({ session_id: "s", hook_event_name: "StopFailure", error: "rate_limit" }, T1))
    let snap = c.snapshot()
    expect(snap.agents.find((a) => a.classification === "root")?.stop_failure_error).toBe(
      "rate_limit",
    )
    expect(snap.runs[0]?.stop_failure_error).toBe("rate_limit")
    // el trabajo continua: la causa del run deja de ser el fallo
    c.ingest(line({ session_id: "s", hook_event_name: "UserPromptSubmit", prompt_id: "p2" }, T2))
    snap = c.snapshot()
    expect(snap.runs[0]?.stop_failure_error).toBeNull()
  })

  test("F2: StopFailure de un subagente cae en su agente, no en root", () => {
    const c = correlator()
    c.ingest(
      line(
        {
          session_id: "s",
          hook_event_name: "SubagentStart",
          agent_id: "a1",
          agent_type: "Explore",
        },
        T0,
      ),
    )
    c.ingest(
      line(
        {
          session_id: "s",
          hook_event_name: "StopFailure",
          agent_id: "a1",
          agent_type: "Explore",
          error: "server_error",
        },
        T1,
      ),
    )
    const snap = c.snapshot()
    expect(snap.agents.find((a) => a.agent_id === "a1")?.stop_failure_error).toBe("server_error")
    expect(
      snap.agents.find((a) => a.classification === "root")?.stop_failure_error ?? null,
    ).toBeNull()
  })

  test("F3: wall_ms es pre->cierre; duration_ms queda como dispatch", () => {
    const c = correlator()
    c.ingest(
      line(
        {
          session_id: "s",
          hook_event_name: "PreToolUse",
          tool_name: "AskUserQuestion",
          tool_use_id: "t1",
          tool_input: { questions: [] },
        },
        T0,
      ),
    )
    c.ingest(
      line(
        {
          session_id: "s",
          hook_event_name: "PostToolUse",
          tool_name: "AskUserQuestion",
          tool_use_id: "t1",
          duration_ms: 2,
        },
        "2026-08-24T10:27:00.000Z",
      ),
    )
    const tc = c.snapshot().tool_calls[0]
    expect(tc?.wall_ms).toBe(27 * 60_000)
    expect(tc?.duration_ms).toBe(2)
  })

  test("A: etiquetas por tool desde tool_input", () => {
    const c = correlator()
    const cases: [string, Record<string, unknown>, string][] = [
      ["Bash", { command: "ls -la", description: "Listar ficheros" }, "Listar ficheros"],
      ["Read", { file_path: "/a/b.ts" }, "/a/b.ts"],
      ["Grep", { pattern: "foo.*bar" }, "foo.*bar"],
      ["Skill", { skill: "code-review" }, "code-review"],
      ["Agent", { subagent_type: "Explore", description: "buscar X" }, "Explore: buscar X"],
    ]
    cases.forEach(([tool, input], i) => {
      c.ingest(
        line(
          {
            session_id: "s",
            hook_event_name: "PreToolUse",
            tool_name: tool,
            tool_use_id: `t${i}`,
            tool_input: input,
          },
          T0,
        ),
      )
    })
    const byId = new Map(c.snapshot().tool_calls.map((tc) => [tc.tool_use_id, tc.label]))
    cases.forEach(([, , expected], i) => {
      expect(byId.get(`t${i}`)).toBe(expected)
    })
  })
})

describe("etiquetas de rutas (corrida real de la Fase 1, 2026-10-23)", () => {
  const wt =
    "/tmp/claude-1000/scratchpad/real-run/state/keel/worktrees/01M5K6/repo/KEEL-1/01M5K6WVY8/root"
  test("con el cwd del run, la ruta se muestra relativa al worktree", () => {
    expect(toolCallLabel("Read", { file_path: `${wt}/src/calc.ts` }, wt)).toBe("src/calc.ts")
    expect(toolCallLabel("Edit", { file_path: `${wt}/README.md` }, `${wt}/`)).toBe("README.md")
    expect(toolCallLabel("Read", { file_path: "C:\\w\\root\\src\\a.ts" }, "C:\\w\\root")).toBe(
      "src\\a.ts",
    )
  })
  test("una ruta larga fuera del cwd conserva el final, no el principio", () => {
    const label = toolCallLabel("Read", {
      file_path: `${wt}/src/muy/profundo/archivo-con-nombre-largo.ts`,
    })
    expect(label?.length).toBe(120)
    expect(label?.startsWith("…")).toBe(true)
    expect(label?.endsWith("archivo-con-nombre-largo.ts")).toBe(true)
  })
  test("un prefijo que no es un directorio no se recorta", () => {
    expect(toolCallLabel("Read", { file_path: `${wt}-otro/x.ts` }, wt)).toBe(`${wt}-otro/x.ts`)
  })
})

describe("F6/F7/D: ventana de gates, live y model/effort", () => {
  test("F6: un gate caducado no marca una llamada identica horas despues", () => {
    const c = correlator({ gateMatchWindowMs: 60_000 })
    c.ingest(
      line(
        {
          session_id: "s",
          hook_event_name: "PermissionRequest",
          tool_name: "Bash",
          tool_input: { command: "x" },
        },
        T0,
      ),
    )
    // la misma llamada 2 horas despues: el gate ya caduco
    c.ingest(
      line(
        {
          session_id: "s",
          hook_event_name: "PreToolUse",
          tool_name: "Bash",
          tool_use_id: "t1",
          tool_input: { command: "x" },
        },
        "2026-08-24T12:00:00.000Z",
      ),
    )
    expect(c.snapshot().tool_calls.find((t) => t.tool_use_id === "t1")?.gated_heuristic).toBe(false)
  })

  test("F6: un gate reciente si empareja (aprobacion humana lenta dentro de la ventana)", () => {
    const c = correlator({ gateMatchWindowMs: 15 * 60_000 })
    c.ingest(
      line(
        {
          session_id: "s",
          hook_event_name: "PermissionRequest",
          tool_name: "Bash",
          tool_input: { command: "x" },
        },
        T0,
      ),
    )
    c.ingest(
      line(
        {
          session_id: "s",
          hook_event_name: "PreToolUse",
          tool_name: "Bash",
          tool_use_id: "t1",
          tool_input: { command: "x" },
        },
        "2026-08-24T10:10:00.000Z",
      ),
    )
    expect(c.snapshot().tool_calls.find((t) => t.tool_use_id === "t1")?.gated_heuristic).toBe(true)
  })

  test("F6: un PermissionRequest no marca una llamada pendiente arrancada horas antes", () => {
    const c = correlator({
      gateMatchWindowMs: 60_000,
      orphanTimeoutMs: 24 * 3_600_000,
      runTimeoutMs: 24 * 3_600_000,
    })
    c.ingest(
      line(
        {
          session_id: "s",
          hook_event_name: "PreToolUse",
          tool_name: "Bash",
          tool_use_id: "t1",
          tool_input: { command: "x" },
        },
        T0,
      ),
    )
    c.ingest(
      line(
        {
          session_id: "s",
          hook_event_name: "PermissionRequest",
          tool_name: "Bash",
          tool_input: { command: "x" },
        },
        "2026-08-24T13:00:00.000Z",
      ),
    )
    expect(c.snapshot().tool_calls.find((t) => t.tool_use_id === "t1")?.gated_heuristic).toBe(false)
  })

  test("F7: live exige eventos recientes respecto al reloj inyectado, no solo 'sin cerrar'", () => {
    const c = correlator({ runTimeoutMs: 60 * 60_000 })
    c.ingest(line({ session_id: "s", hook_event_name: "UserPromptSubmit" }, T0))
    expect(c.snapshot(Date.parse(T0) + 5 * 60_000).runs[0]?.live).toBe(true)
    expect(c.snapshot(Date.parse(T0) + 5 * 3_600_000).runs[0]?.live).toBe(false)
    // cerrado nunca es live
    c.ingest(line({ session_id: "s", hook_event_name: "SessionEnd", reason: "other" }, T1))
    expect(c.snapshot(Date.parse(T1)).runs[0]?.live).toBe(false)
  })

  test("F7/D: start_source, model y effort quedan en el run", () => {
    const c = correlator()
    c.ingest(
      line(
        {
          session_id: "s",
          hook_event_name: "SessionStart",
          source: "resume",
          model: "claude-fable-5",
        },
        T0,
      ),
    )
    c.ingest(
      line(
        { session_id: "s", hook_event_name: "UserPromptSubmit", effort: { level: "xhigh" } },
        T1,
      ),
    )
    const run = c.snapshot().runs[0]
    expect(run?.start_source).toBe("resume")
    expect(run?.model).toBe("claude-fable-5")
    expect(run?.effort_level).toBe("xhigh")
    // un run abierto por actividad no inventa source
    const c2 = correlator()
    c2.ingest(line({ session_id: "s2", hook_event_name: "UserPromptSubmit" }, T0))
    expect(c2.snapshot().runs[0]?.start_source).toBeNull()
  })
})

describe("tool calls", () => {
  test("pre+post = done con duration_ms; pre+failure = failed", () => {
    const c = correlator()
    c.ingest(
      line(
        {
          session_id: "s",
          hook_event_name: "PreToolUse",
          tool_name: "Bash",
          tool_use_id: "t1",
          tool_input: { command: "x" },
        },
        T0,
      ),
    )
    c.ingest(
      line(
        {
          session_id: "s",
          hook_event_name: "PostToolUse",
          tool_name: "Bash",
          tool_use_id: "t1",
          duration_ms: 42,
        },
        T1,
      ),
    )
    c.ingest(
      line(
        { session_id: "s", hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "t2" },
        T1,
      ),
    )
    c.ingest(
      line(
        {
          session_id: "s",
          hook_event_name: "PostToolUseFailure",
          tool_name: "Bash",
          tool_use_id: "t2",
          error: "boom",
        },
        T2,
      ),
    )
    const calls = c.snapshot().tool_calls
    expect(calls.find((x) => x.tool_use_id === "t1")).toMatchObject({
      state: "done",
      duration_ms: 42,
    })
    expect(calls.find((x) => x.tool_use_id === "t2")?.state).toBe("failed")
  })

  test("orphan: pending sin cierre tras el timeout, medido contra el ultimo evento del run", () => {
    const c = correlator({ orphanTimeoutMs: 60_000, runTimeoutMs: 3_600_000 })
    c.ingest(
      line(
        { session_id: "s", hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "t1" },
        T0,
      ),
    )
    expect(c.snapshot().tool_calls[0]?.state).toBe("pending")
    c.ingest(line({ session_id: "s", hook_event_name: "Stop" }, "2026-08-24T10:05:00.000Z"))
    expect(c.snapshot().tool_calls[0]?.state).toBe("orphan")
  })

  test("run cerrado: todo call sin cierre es orphan aunque no pase el timeout", () => {
    const c = correlator()
    c.ingest(
      line(
        { session_id: "s", hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "t1" },
        T0,
      ),
    )
    c.ingest(line({ session_id: "s", hook_event_name: "SessionStart", source: "resume" }, T1))
    const call = c.snapshot().tool_calls.find((x) => x.tool_use_id === "t1")
    expect(call?.state).toBe("orphan")
  })

  test("PostToolBatch NO genera tool calls (ADR-008 p.3)", () => {
    const c = correlator()
    c.ingest(
      line(
        { session_id: "s", hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "t1" },
        T0,
      ),
    )
    c.ingest(
      line(
        { session_id: "s", hook_event_name: "PostToolUse", tool_name: "Bash", tool_use_id: "t1" },
        T1,
      ),
    )
    const batch = c.ingest(
      line(
        {
          session_id: "s",
          hook_event_name: "PostToolBatch",
          tool_calls: [{ tool_name: "Bash", tool_use_id: "t1", tool_response: "x" }],
        },
        T2,
      ),
    )
    expect(batch.tool_use_id).toBeNull()
    expect(c.snapshot().tool_calls).toHaveLength(1)
  })

  test("post sin pre (fuera de orden) se ingiere igual", () => {
    const c = correlator()
    c.ingest(
      line(
        { session_id: "s", hook_event_name: "PostToolUse", tool_name: "Bash", tool_use_id: "t9" },
        T0,
      ),
    )
    expect(c.snapshot().tool_calls.find((x) => x.tool_use_id === "t9")).toMatchObject({
      state: "done",
      started_at: null,
    })
  })

  test("gate heuristico en ambos ordenes: gate->pre y pre->gate (ADR-008 p.8)", () => {
    const c = correlator()
    // orden real: el gate llega antes del pre
    c.ingest(
      line(
        {
          session_id: "s",
          hook_event_name: "PermissionRequest",
          tool_name: "Bash",
          tool_input: { command: "rm x" },
        },
        T0,
      ),
    )
    c.ingest(
      line(
        {
          session_id: "s",
          hook_event_name: "PreToolUse",
          tool_name: "Bash",
          tool_use_id: "t1",
          tool_input: { command: "rm x" },
        },
        T1,
      ),
    )
    // orden inverso
    c.ingest(
      line(
        {
          session_id: "s",
          hook_event_name: "PreToolUse",
          tool_name: "Write",
          tool_use_id: "t2",
          tool_input: { file_path: "/a" },
        },
        T1,
      ),
    )
    c.ingest(
      line(
        {
          session_id: "s",
          hook_event_name: "PermissionRequest",
          tool_name: "Write",
          tool_input: { file_path: "/a" },
        },
        T2,
      ),
    )
    // input distinto: no empareja
    c.ingest(
      line(
        {
          session_id: "s",
          hook_event_name: "PreToolUse",
          tool_name: "Edit",
          tool_use_id: "t3",
          tool_input: { file_path: "/b" },
        },
        T2,
      ),
    )
    const calls = c.snapshot().tool_calls
    expect(calls.find((x) => x.tool_use_id === "t1")?.gated_heuristic).toBe(true)
    expect(calls.find((x) => x.tool_use_id === "t2")?.gated_heuristic).toBe(true)
    expect(calls.find((x) => x.tool_use_id === "t3")?.gated_heuristic).toBe(false)
  })
})

describe("background tasks y tolerancia", () => {
  test("cinco taxonomias; el cierre observable es desaparecer de la lista (ADR-008 p.2)", () => {
    const c = correlator()
    c.ingest(
      line(
        {
          session_id: "s",
          hook_event_name: "Stop",
          background_tasks: [
            { id: "aaaaaaaa1", type: "subagent", status: "running" },
            { id: "bbbbbbbb1", type: "workflow", status: "running" },
          ],
        },
        T0,
      ),
    )
    c.ingest(
      line(
        {
          session_id: "s",
          hook_event_name: "Stop",
          background_tasks: [{ id: "bbbbbbbb1", type: "workflow", status: "running" }],
        },
        T1,
      ),
    )
    const tasks = c.snapshot().tasks
    expect(tasks.find((t) => t.task_id === "aaaaaaaa1")?.gone_at).toBe(T1)
    expect(tasks.find((t) => t.task_id === "bbbbbbbb1")?.gone_at).toBeNull()
  })

  test("tasks con el mismo orphan que los tool calls: run cerrado u observacion rancia", () => {
    const c = correlator({ orphanTimeoutMs: 60_000, runTimeoutMs: 3_600_000 })
    c.ingest(
      line(
        {
          session_id: "s",
          hook_event_name: "Stop",
          background_tasks: [{ id: "mmmmmmmm1", type: "monitor", status: "running" }],
        },
        T0,
      ),
    )
    expect(c.snapshot().tasks[0]?.state).toBe("running")
    // observacion rancia en run abierto (reloj inyectado)
    expect(c.snapshot(Date.parse(T0) + 120_000).tasks[0]?.state).toBe("orphan")
    // el run se cierra sin que la task desaparezca de la lista: orphan
    c.ingest(line({ session_id: "s", hook_event_name: "SessionEnd", reason: "other" }, T1))
    expect(c.snapshot().tasks[0]?.state).toBe("orphan")
    // una task que desaparecio de la lista es gone, no orphan
    const c2 = correlator()
    c2.ingest(
      line(
        {
          session_id: "s",
          hook_event_name: "Stop",
          background_tasks: [{ id: "ssssssss1", type: "shell", status: "running" }],
        },
        T0,
      ),
    )
    c2.ingest(line({ session_id: "s", hook_event_name: "Stop", background_tasks: [] }, T1))
    expect(c2.snapshot().tasks[0]?.state).toBe("gone")
  })

  test("kind desconocido y raw no-objeto se ingieren sin romper (ADR-002)", () => {
    const c = correlator()
    const e1 = c.ingest(
      line({ session_id: "s", hook_event_name: "EventoDelFuturo2030", campo_nuevo: { x: 1 } }, T0),
    )
    expect(e1.kind).toBe("EventoDelFuturo2030")
    const e2 = c.ingest({
      id: "01TESTRAWSTRING000000000ate",
      received_at: T1,
      hook_event_name: null,
      cwd: null,
      session_id: null,
      raw: "basura",
    })
    expect(e2.kind).toBe("(sin hook_event_name)")
    expect(e2.session_id).toBe("(sin session_id)")
  })
})

describe("ulid puro", () => {
  test("codifica tiempo y entropia inyectada; decodifica el tiempo", () => {
    const bytes = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
    const id = encodeUlid(1_755_700_000_000, bytes)
    expect(id).toHaveLength(26)
    expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/)
    expect(ulidTime(id)).toBe(1_755_700_000_000)
    expect(encodeUlid(1_755_700_000_000, bytes)).toBe(id)
    expect(encodeUlid(1_755_700_000_001, bytes) > id).toBe(true)
  })
})
