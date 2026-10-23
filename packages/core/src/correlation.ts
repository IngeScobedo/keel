/**
 * Correlacion (ADR-008 + ADR-010): de lineas de hook planas a runs, arbol de agentes,
 * tool calls y background tasks.
 *
 * Contrato: determinista y sin efectos. No hay reloj (el tiempo es el de los eventos), no
 * hay entropia (el generador de run_id se inyecta), no hay I/O. Alimentar en orden
 * ascendente de `id` (ULID = orden temporal del bridge); tolera inversiones de milisegundos.
 *
 * Reglas que implementa, con su origen:
 *  - run_id nuestro; `source: 'compact'` NO abre run (ADR-008 p.6). El timeout de
 *    inactividad corre SOLO sobre actividad real; los eventos administrativos se adhieren
 *    al run vecino y no abren run; un run sin actividad queda `administrative`; un
 *    SessionEnd tardio cierra el run anterior (ADR-010 p.3).
 *  - padre por tres canales con precedencia y proveniencia explicitas (ADR-010 p.1):
 *    transcript (agent_transcript_path -> wf) > launch (tool_response.agentId) >
 *    prompt ((session, prompt_id) + ultimo PreToolUse(Agent|Workflow) previo). Sin señal
 *    => parent_pending; discrepancias se registran, nunca se resuelven en silencio.
 *  - arbol de tres niveles con dos clases de nodo: los workflow-subagents cuelgan de la
 *    TASK workflow (wf_run_id), no del root; el nodo-task se materializa aunque nunca
 *    aparezca en background_tasks[] (ADR-010 p.2).
 *  - tool_use_id viene siempre; sin sintesis (ADR-008 p.4). PostToolBatch es compuesto:
 *    se ingiere pero NO genera tool calls (ADR-008 p.3). Gates por heuristica (p.8).
 *  - agent_type "" => null; SubagentStop sin SubagentStart y sin tool events = agente
 *    utilitario (ADR-008 p.9). background_tasks[]: cierre observable = desaparecer de la
 *    lista; orphan con la misma semantica que los tool calls (ADR-008 p.2 + Fase 2).
 */
import type { AgentEvent } from "./envelope.js"
import {
  deriveFields,
  type HookLine,
  rawArray,
  rawNumber,
  rawRecord,
  rawString,
} from "./schemas.js"

export const ADAPTER_VERSION = "hook-adapter/0.3.0"

/** Semilla con la que se pide un run_id: permite generadores deterministas entre reinicios. */
export type RunSeed = { sessionId: string; firstLine: HookLine }

export type CorrelatorOptions = {
  /**
   * Generador de run_id. Inyectado: core no tiene entropia ni reloj. En produccion, un
   * ULID derivado deterministicamente de la semilla (mismo primer evento => mismo run_id
   * tras reconstruir desde el store); en tests, un contador.
   */
  newRunId: (seed: RunSeed) => string
  /** Inactividad REAL que cierra un run. Default 60 min (ADR-010 p.3). */
  runTimeoutMs?: number
  /** Un tool call sin cierre tras esto es orphan. Default 5 min (ADR-003/008). */
  orphanTimeoutMs?: number
  /**
   * Ventana del pareo heuristico de gates (F6): un PermissionRequest solo empareja con
   * tool calls arrancados dentro de la ventana, y un gate sin consumir caduca. Cubre la
   * aprobacion humana lenta sin dejar que un gate rancio marque llamadas horas despues.
   */
  gateMatchWindowMs?: number
}

export type RunEndReason = "session_end" | "timeout" | "replaced" | null

export type RunView = {
  run_id: string
  session_id: string
  previous_run_id: string | null
  transcript_path: string | null
  /**
   * Slug del proyecto en ~/.claude/projects/<slug>/: la identidad de proyecto de la
   * sesion (1:1 con session_id via transcript_path; cwd es volatil — ADR-008 p.5).
   */
  project_slug: string | null
  root_agent_id: string
  started_at: string
  last_event_at: string
  ended_at: string | null
  end_reason: RunEndReason
  /**
   * F7: "abierto" no significa vivo. true solo si el run no cerro Y hubo eventos dentro
   * de la ventana de inactividad respecto al reloj inyectado en snapshot(nowMs).
   */
  live: boolean
  /** source del SessionStart que abrio el run (startup/resume/fork); null si abrio por actividad. */
  start_source: string | null
  /** SessionStart.model del run, si vino (D). */
  model: string | null
  /** Ultimo effort.level observado en el run (D). */
  effort_level: string | null
  /**
   * StopFailure sin actividad posterior: la causa real del final del run (rate_limit, ...).
   * Cuando existe, gana sobre la inferencia de timeout en la presentacion (F2).
   */
  stop_failure_error: string | null
  /** Sin ninguna actividad real: visible y filtrable, nunca descartado (ADR-010 p.3). */
  administrative: boolean
  compaction_seq: number
  event_count: number
  agent_count: number
  tool_call_count: number
}

export type AgentClassification = "root" | "worker" | "utility"

/** Canal que resolvio el padre (ADR-010 p.1), en precedencia transcript > launch > prompt. */
export type ParentSource = "prompt" | "launch" | "transcript"
export type ParentKind = "agent" | "workflow"

export type AgentView = {
  agent_id: string
  run_id: string
  /** agent_id de otro agente, o wf_run_id de una task workflow (parent_kind lo dice). */
  parent_agent_id: string | null
  parent_kind: ParentKind | null
  parent_source: ParentSource | null
  parent_pending: boolean
  /** Dos canales concretos discreparon; gano el de mayor precedencia (ADR-010 p.1). */
  parent_discrepancy: boolean
  agent_type: string | null
  classification: AgentClassification
  first_seen: string
  last_seen: string
  stopped_at: string | null
  /** StopFailure: el agente no termino su turno; razon del CLI (rate_limit, ...). F2. */
  stop_failure_error: string | null
  stop_failure_at: string | null
  /** Que se le pidio (Agent.tool_input.prompt del lanzamiento), si se observo. */
  request_prompt: string | null
  /** Que devolvio (SubagentStop.last_assistant_message), si se observo. */
  last_assistant_message: string | null
  /** Evento PreToolUse(StructuredOutput) del agente: su tool_input es la salida estructurada. */
  structured_output_event_id: string | null
  agent_transcript_path: string | null
  tool_calls: { pending: number; done: number; failed: number; orphan: number }
}

export type ToolCallState = "pending" | "done" | "failed" | "orphan"

export type ToolCallView = {
  tool_use_id: string
  run_id: string
  agent_id: string
  tool_name: string | null
  state: ToolCallState
  started_at: string | null
  ended_at: string | null
  /** Tiempo de pared PreToolUse->cierre: la duracion REAL. duration_ms es solo dispatch (F3). */
  wall_ms: number | null
  /** Dispatch interno del CLI; para tools que bloquean (AskUserQuestion) miente por ordenes. */
  duration_ms: number | null
  /** Etiqueta legible derivada de tool_input (description, file_path, pattern, ...). */
  label: string | null
  /** true = hubo PermissionRequest emparejado por heuristica (ADR-008 p.8), no certeza. */
  gated_heuristic: boolean
  pre_event_id: string | null
  close_event_id: string | null
}

/**
 * Estado derivado de una background task, con la misma semantica de orphan que un tool
 * call: en un run cerrado nada puede volver a observarla, y en uno abierto la ausencia
 * de observacion reciente (reloj inyectado) la marca orphan en vez de fingir "running".
 */
export type TaskState = "running" | "gone" | "orphan"

export type TaskView = {
  task_id: string
  run_id: string
  task_type: string | null
  status: string | null
  description: string | null
  state: TaskState
  /** Identidad del workflow (nodo intermedio del arbol, ADR-010 p.2), si aplica. */
  wf_run_id: string | null
  /** Agente que lanzo la task (conocido para workflows via tool_response). */
  parent_agent_id: string | null
  first_seen: string
  last_seen: string
  /** Momento en que desaparecio de background_tasks[]: el cierre observable (ADR-008 p.2). */
  gone_at: string | null
}

export type CorrelationSnapshot = {
  runs: RunView[]
  agents: AgentView[]
  tool_calls: ToolCallView[]
  tasks: TaskView[]
}

const DEFAULT_RUN_TIMEOUT_MS = 60 * 60_000
const DEFAULT_ORPHAN_TIMEOUT_MS = 5 * 60_000
const TOOL_KINDS = new Set(["PreToolUse", "PostToolUse", "PostToolUseFailure"])
/** Actividad real (ADR-010 p.3): lo unico que abre runs y reinicia el reloj de inactividad. */
const ACTIVITY_KINDS = new Set([
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "SubagentStart",
  "SubagentStop",
  "PermissionRequest",
])
const DEFAULT_GATE_WINDOW_MS = 15 * 60_000
const LAUNCH_TOOLS = new Set(["Agent", "Workflow"])
const PARENT_RANK: Record<ParentSource, number> = { prompt: 1, launch: 2, transcript: 3 }
const WF_IN_TRANSCRIPT = /\/workflows\/(wf_[A-Za-z0-9-]+)\//
const PROJECT_IN_TRANSCRIPT = /\/projects\/([^/]+)\//

type RunState = {
  runId: string
  sessionId: string
  previousRunId: string | null
  transcriptPath: string | null
  rootAgentId: string
  startedAt: string
  lastEventAt: string
  lastEventMs: number
  lastActivityMs: number | null
  endedAt: string | null
  endReason: RunEndReason
  compactionSeq: number
  eventCount: number
  lastBtIds: Set<string>
  lastStopFailureError: string | null
  lastStopFailureMs: number
  startSource: string | null
  model: string | null
  effortLevel: string | null
  /** Gates aun sin emparejar con su PreToolUse (llegan antes del pre). Caducan (F6). */
  openGates: { toolName: string | null; inputJson: string; eventId: string; atMs: number }[]
}

type AgentState = {
  agentId: string
  runId: string
  isRoot: boolean
  agentType: string | null
  parentAgentId: string | null
  parentKind: ParentKind | null
  parentSource: ParentSource | null
  parentDiscrepancy: boolean
  hasStart: boolean
  sawStop: boolean
  toolEventCount: number
  firstSeen: string
  lastSeen: string
  stoppedAt: string | null
  stopFailureError: string | null
  stopFailureAt: string | null
  requestPrompt: string | null
  lastAssistantMessage: string | null
  structuredOutputEventId: string | null
  agentTranscriptPath: string | null
}

type ToolCallInternal = {
  toolUseId: string
  runId: string
  agentId: string
  toolName: string | null
  closed: "done" | "failed" | null
  startedAt: string | null
  startedMs: number
  endedAt: string | null
  durationMs: number | null
  gated: boolean
  inputJson: string | null
  label: string | null
  preEventId: string | null
  closeEventId: string | null
}

type TaskInternal = {
  taskId: string
  runId: string
  taskType: string | null
  status: string | null
  description: string | null
  wfRunId: string | null
  parentAgentId: string | null
  firstSeen: string
  lastSeen: string
  goneAt: string | null
}

type WfInfo = { taskId: string | null; parentAgentId: string | null }

const LABEL_MAX = 120

/**
 * Etiqueta legible de un tool call a partir de tool_input (hallazgo A de la revision).
 * Con `cwd`, las rutas dentro de él se muestran relativas; una ruta larga se recorta
 * por el principio para no perder el archivo (corrida real de la Fase 1, 2026-10-23).
 */
export function toolCallLabel(
  toolName: string | null,
  input: Record<string, unknown> | null,
  cwd: string | null = null,
): string | null {
  if (input === null) return null
  const str = (k: string): string | null =>
    typeof input[k] === "string" ? (input[k] as string) : null
  let label: string | null
  let isPath = false
  switch (toolName) {
    case "Bash":
      label = str("description") ?? str("command")
      break
    case "Read":
    case "Edit":
    case "Write":
      label = str("file_path")
      isPath = true
      break
    case "NotebookEdit":
      label = str("notebook_path")
      isPath = true
      break
    case "Grep":
    case "Glob":
      label = str("pattern")
      break
    case "Skill":
      label = str("skill")
      break
    case "Agent": {
      const t = str("subagent_type")
      const d = str("description") ?? str("prompt")
      label = t !== null && d !== null ? `${t}: ${d}` : (d ?? t)
      break
    }
    default:
      label = str("description") ?? str("file_path") ?? str("pattern") ?? str("query")
  }
  if (label === null) return null
  if (isPath) {
    const rel = relativeTo(label, cwd)
    return rel.length <= LABEL_MAX ? rel : `…${rel.slice(-(LABEL_MAX - 1))}`
  }
  return label.slice(0, LABEL_MAX)
}

/** Ruta relativa a `cwd` si está dentro; si no, la ruta tal cual. Sin I/O: sólo texto. */
function relativeTo(path: string, cwd: string | null): string {
  if (!cwd) return path
  const base = cwd.replace(/[\\/]+$/, "")
  if (path.length > base.length && path.startsWith(base) && /[\\/]/.test(path[base.length] ?? ""))
    return path.slice(base.length + 1)
  return path
}

function agentKey(runId: string, agentId: string): string {
  return `${runId} ${agentId}`
}

export class Correlator {
  private readonly newRunId: (seed: RunSeed) => string
  private readonly runTimeoutMs: number
  private readonly orphanTimeoutMs: number

  private readonly runs: RunState[] = []
  private readonly openRunBySession = new Map<string, RunState>()
  private readonly lastRunBySession = new Map<string, RunState>()
  private readonly agents = new Map<string, AgentState>()
  private readonly toolCalls = new Map<string, ToolCallInternal>()
  private readonly tasks = new Map<string, TaskInternal>()
  /** Canal launch pendiente: hijo aun no visto cuando llego tool_response.agentId. */
  private readonly pendingParent = new Map<
    string,
    { id: string; kind: ParentKind; prompt: string | null }
  >()
  /** Workflow lanzado en cada turno: (session|prompt_id) -> wf_run_id. Para F1. */
  private readonly wfByTurn = new Map<string, string>()
  /** Canal prompt: ultimo PreToolUse(Agent|Workflow) visto por (session, prompt_id). */
  private readonly lastLaunchByTurn = new Map<string, string>()
  /** Workflows conocidos: wf_run_id -> task corta y lanzador (de tool_response). */
  private readonly wfInfo = new Map<string, WfInfo>()
  private readonly taskIdToWf = new Map<string, string>()
  /**
   * Hechos globales por agent_id (cruzan fronteras de run): un subagente cuyo stop cae en
   * un run posterior al de su start no debe clasificarse utilitario (ADR-008 p.9 habla del
   * agente, no del run).
   */
  private readonly agentFacts = new Map<string, { hasStart: boolean; toolEvents: number }>()

  private readonly gateMatchWindowMs: number

  constructor(opts: CorrelatorOptions) {
    this.newRunId = opts.newRunId
    this.runTimeoutMs = opts.runTimeoutMs ?? DEFAULT_RUN_TIMEOUT_MS
    this.orphanTimeoutMs = opts.orphanTimeoutMs ?? DEFAULT_ORPHAN_TIMEOUT_MS
    this.gateMatchWindowMs = opts.gateMatchWindowMs ?? DEFAULT_GATE_WINDOW_MS
  }

  /** Procesa una linea y devuelve su envelope. Nunca lanza por contenido desconocido. */
  ingest(line: HookLine): AgentEvent {
    const f = deriveFields(line)
    const t = Date.parse(line.received_at)
    const ms = Number.isNaN(t) ? 0 : t
    const isActivity = ACTIVITY_KINDS.has(f.kind)

    const run = this.resolveRun(f.sessionId, f.kind, line, ms, isActivity)
    run.eventCount += 1
    if (ms >= run.lastEventMs) {
      run.lastEventMs = ms
      run.lastEventAt = line.received_at
    }
    if (isActivity && ms >= (run.lastActivityMs ?? Number.NEGATIVE_INFINITY)) {
      run.lastActivityMs = ms
    }
    if (run.transcriptPath === null && f.transcriptPath !== null) {
      run.transcriptPath = f.transcriptPath
    }
    if (f.kind === "SessionStart") {
      const model = rawString(line.raw, "model")
      if (model !== null) run.model = model
    }
    const effort = rawRecord(line.raw, "effort")
    if (effort && typeof effort.level === "string") run.effortLevel = effort.level
    if (f.kind === "PreCompact") run.compactionSeq += 1
    if (f.kind === "SessionEnd") {
      if (run.endedAt === null) this.closeRun(run, "session_end", line.received_at)
      else if (run.endReason !== "session_end") {
        // SessionEnd tardio: cierra (re-marca) el run anterior en vez de abrir uno (ADR-010)
        run.endReason = "session_end"
        run.endedAt = line.received_at
      }
    }

    const agent = this.resolveAgent(run, f.agentId, f.agentType, line.received_at)
    if (f.kind === "StopFailure") {
      // F2: el agente no termino su turno; estado terminal con su razon
      const error = rawString(line.raw, "error") ?? "unknown"
      agent.stopFailureError = error
      agent.stopFailureAt = line.received_at
      if (ms >= run.lastStopFailureMs) {
        run.lastStopFailureError = error
        run.lastStopFailureMs = ms
      }
    }
    if (f.agentId !== null) {
      let facts = this.agentFacts.get(f.agentId)
      if (!facts) {
        facts = { hasStart: false, toolEvents: 0 }
        this.agentFacts.set(f.agentId, facts)
      }
      if (f.kind === "SubagentStart") facts.hasStart = true
      if (TOOL_KINDS.has(f.kind)) facts.toolEvents += 1
    }
    if (f.kind === "SubagentStart") {
      agent.hasStart = true
      // canal prompt (precedencia menor): el ultimo lanzamiento previo del mismo turno.
      // F1: un workflow-subagent NUNCA cuelga de un agente; si su turno lanzo un
      // workflow, todos los workflow-subagent de ese prompt_id van al mismo wf_.
      if (f.promptId !== null && !agent.isRoot) {
        if (agent.agentType === "workflow-subagent") {
          const wf = this.wfByTurn.get(`${f.sessionId}|${f.promptId}`)
          if (wf !== undefined) {
            this.ensureWorkflowTask(run, wf, line.received_at)
            this.setParent(agent, wf, "workflow", "prompt")
          }
        } else {
          const launcher = this.lastLaunchByTurn.get(`${f.sessionId}|${f.promptId}`)
          if (launcher !== undefined && launcher !== agent.agentId) {
            this.setParent(agent, launcher, "agent", "prompt")
          }
        }
      }
    }
    if (f.kind === "SubagentStop") {
      agent.sawStop = true
      agent.stoppedAt = line.received_at
      const lam = rawString(line.raw, "last_assistant_message")
      if (lam !== null) agent.lastAssistantMessage = lam
      const atp = rawString(line.raw, "agent_transcript_path")
      if (atp !== null) {
        agent.agentTranscriptPath = atp
        // canal transcript (precedencia mayor): la ruta enlaza directo al workflow
        const wf = WF_IN_TRANSCRIPT.exec(atp)?.[1]
        if (wf !== undefined && !agent.isRoot) {
          this.ensureWorkflowTask(run, wf, line.received_at)
          this.setParent(agent, wf, "workflow", "transcript")
        }
      }
    }
    if (TOOL_KINDS.has(f.kind)) agent.toolEventCount += 1
    if (f.kind === "PreToolUse" && f.toolName === "StructuredOutput" && !agent.isRoot) {
      agent.structuredOutputEventId = line.id
    }
    if (
      f.kind === "PreToolUse" &&
      f.toolName !== null &&
      LAUNCH_TOOLS.has(f.toolName) &&
      f.promptId !== null
    ) {
      this.lastLaunchByTurn.set(`${f.sessionId}|${f.promptId}`, agent.agentId)
    }

    this.applyToolEvent(run, agent, f.kind, f.toolName, f.toolUseId, line)
    this.applyLaunchLinks(run, agent, f.kind, line, f.sessionId, f.promptId)
    this.applyBackgroundTasks(run, line)

    return {
      id: line.id,
      received_at: line.received_at,
      occurred_at: null,
      source: "hook",
      fidelity: "full",
      adapter_version: ADAPTER_VERSION,
      run_id: run.runId,
      session_id: f.sessionId,
      agent_id: agent.agentId,
      parent_agent_id: agent.parentAgentId,
      tool_use_id: f.toolUseId,
      kind: f.kind,
      tool_name: f.toolName,
      raw: line.raw,
    }
  }

  private resolveRun(
    sessionId: string,
    kind: string,
    line: HookLine,
    ms: number,
    isActivity: boolean,
  ): RunState {
    let run = this.openRunBySession.get(sessionId)

    // el timeout solo lo dispara actividad real medida contra actividad real (ADR-010)
    if (
      run &&
      isActivity &&
      run.lastActivityMs !== null &&
      ms - run.lastActivityMs > this.runTimeoutMs
    ) {
      this.closeRun(run, "timeout", run.lastEventAt)
      run = undefined
    }

    const source = kind === "SessionStart" ? rawString(line.raw, "source") : null
    const opensRun = kind === "SessionStart" && source !== "compact"
    if (opensRun && run) {
      // un resume/fork/startup nuevo reemplaza al run abierto de esa sesion
      this.closeRun(run, "replaced", run.lastEventAt)
      run = undefined
    }

    if (!run) {
      const previous = this.lastRunBySession.get(sessionId)
      // administrativos no abren run: se adhieren al ultimo run de su sesion (ADR-010)
      if (!opensRun && !isActivity && previous !== undefined) return previous
      run = {
        runId: this.newRunId({ sessionId, firstLine: line }),
        sessionId,
        previousRunId: previous?.runId ?? null,
        transcriptPath: null,
        rootAgentId: "",
        startedAt: line.received_at,
        lastEventAt: line.received_at,
        lastEventMs: ms,
        lastActivityMs: null,
        endedAt: null,
        endReason: null,
        compactionSeq: 0,
        eventCount: 0,
        lastBtIds: new Set(),
        lastStopFailureError: null,
        lastStopFailureMs: 0,
        startSource: opensRun ? source : null,
        model: null,
        effortLevel: null,
        openGates: [],
      }
      run.rootAgentId = `root:${run.runId}`
      this.runs.push(run)
      this.openRunBySession.set(sessionId, run)
      this.lastRunBySession.set(sessionId, run)
    }
    return run
  }

  private closeRun(run: RunState, reason: Exclude<RunEndReason, null>, endedAt: string): void {
    if (run.endedAt !== null) return
    run.endedAt = endedAt
    run.endReason = reason
    this.openRunBySession.delete(run.sessionId)
  }

  private resolveAgent(
    run: RunState,
    agentId: string | null,
    agentType: string | null,
    at: string,
  ): AgentState {
    const id = agentId ?? run.rootAgentId
    const key = agentKey(run.runId, id)
    let agent = this.agents.get(key)
    if (!agent) {
      agent = {
        agentId: id,
        runId: run.runId,
        isRoot: agentId === null,
        agentType, // en construccion: la regla F1 necesita el tipo antes de aplicar pendientes
        parentAgentId: null,
        parentKind: null,
        parentSource: null,
        parentDiscrepancy: false,
        hasStart: false,
        sawStop: false,
        toolEventCount: 0,
        firstSeen: at,
        lastSeen: at,
        stoppedAt: null,
        stopFailureError: null,
        stopFailureAt: null,
        requestPrompt: null,
        lastAssistantMessage: null,
        structuredOutputEventId: null,
        agentTranscriptPath: null,
      }
      this.agents.set(key, agent)
      const pending = this.pendingParent.get(key)
      if (pending && !agent.isRoot) {
        this.pendingParent.delete(key)
        this.setParent(agent, pending.id, pending.kind, "launch")
        if (agent.requestPrompt === null) agent.requestPrompt = pending.prompt
      }
    }
    agent.lastSeen = at
    if (agent.agentType === null && agentType !== null) agent.agentType = agentType
    return agent
  }

  /**
   * Aplica un canal de resolucion de padre (ADR-010 p.1): gana la mayor precedencia; una
   * discrepancia entre canales concretos se registra, salvo el caso compatible
   * root->wf->subagente (el canal prompt dio el lanzador del workflow, no un padre rival).
   */
  private setParent(agent: AgentState, id: string, kind: ParentKind, source: ParentSource): void {
    // F1: un workflow-subagent nunca puede tener padre de clase agente, venga del canal
    // que venga; su sitio es un nodo workflow o quedarse pendiente
    if (agent.agentType === "workflow-subagent" && kind === "agent") return
    const rank = PARENT_RANK[source]
    const current = agent.parentSource === null ? 0 : PARENT_RANK[agent.parentSource]
    if (agent.parentAgentId !== null && agent.parentAgentId !== id) {
      const compatible =
        (kind === "workflow" && this.wfInfo.get(id)?.parentAgentId === agent.parentAgentId) ||
        (agent.parentKind === "workflow" &&
          this.wfInfo.get(agent.parentAgentId)?.parentAgentId === id)
      if (!compatible) agent.parentDiscrepancy = true
    }
    if (rank <= current) return
    agent.parentAgentId = id
    agent.parentKind = kind
    agent.parentSource = source
  }

  /** El nodo-task del workflow existe aunque nunca aparezca en background_tasks[] (ADR-010). */
  private ensureWorkflowTask(run: RunState, wfRunId: string, at: string): void {
    const shortId = this.wfInfo.get(wfRunId)?.taskId ?? null
    const taskId = shortId ?? wfRunId
    const key = `${run.runId} ${taskId}`
    let task = this.tasks.get(key)
    if (!task) {
      task = {
        taskId,
        runId: run.runId,
        taskType: "workflow",
        status: null,
        description: null,
        wfRunId,
        parentAgentId: this.wfInfo.get(wfRunId)?.parentAgentId ?? null,
        firstSeen: at,
        lastSeen: at,
        goneAt: null,
      }
      this.tasks.set(key, task)
      return
    }
    task.wfRunId ??= wfRunId
    task.parentAgentId ??= this.wfInfo.get(wfRunId)?.parentAgentId ?? null
  }

  private applyToolEvent(
    run: RunState,
    agent: AgentState,
    kind: string,
    toolName: string | null,
    toolUseId: string | null,
    line: HookLine,
  ): void {
    if (kind === "PermissionRequest") {
      // sin tool_use_id ni agent_id (ADR-008 p.8): heuristica por tool_name + tool_input,
      // acotada en el tiempo (F6): un gate no puede marcar una llamada de hace horas
      const gateMs = Date.parse(line.received_at) || 0
      const inputJson = JSON.stringify(rawRecord(line.raw, "tool_input") ?? null)
      const pending = [...this.toolCalls.values()].filter(
        (tc) =>
          tc.runId === run.runId &&
          tc.closed === null &&
          !tc.gated &&
          tc.toolName === toolName &&
          tc.inputJson === inputJson &&
          gateMs - tc.startedMs <= this.gateMatchWindowMs,
      )
      const last = pending[pending.length - 1]
      if (last) last.gated = true
      else run.openGates.push({ toolName, inputJson, eventId: line.id, atMs: gateMs })
      return
    }

    if (toolUseId === null || !TOOL_KINDS.has(kind)) return

    if (kind === "PreToolUse") {
      const existing = this.toolCalls.get(toolUseId)
      if (existing) return // duplicado: gana el primero
      const inputJson = JSON.stringify(rawRecord(line.raw, "tool_input") ?? null)
      const preMs = Date.parse(line.received_at) || 0
      // los gates caducados se retiran; consumo estricto 1:1 dentro de la ventana (F6)
      run.openGates = run.openGates.filter((g) => preMs - g.atMs <= this.gateMatchWindowMs)
      const gateIdx = run.openGates.findIndex(
        (g) => g.toolName === toolName && g.inputJson === inputJson,
      )
      const gated = gateIdx >= 0
      if (gated) run.openGates.splice(gateIdx, 1)
      this.toolCalls.set(toolUseId, {
        toolUseId,
        runId: run.runId,
        agentId: agent.agentId,
        toolName,
        closed: null,
        startedAt: line.received_at,
        startedMs: Date.parse(line.received_at) || 0,
        endedAt: null,
        durationMs: null,
        gated,
        inputJson,
        label: toolCallLabel(toolName, rawRecord(line.raw, "tool_input")),
        preEventId: line.id,
        closeEventId: null,
      })
      return
    }

    // PostToolUse / PostToolUseFailure
    const closed = kind === "PostToolUse" ? "done" : "failed"
    let tc = this.toolCalls.get(toolUseId)
    if (!tc) {
      // llegada sin su pre (fuera de orden): se ingiere igual, nunca se descarta
      tc = {
        toolUseId,
        runId: run.runId,
        agentId: agent.agentId,
        toolName,
        closed: null,
        startedAt: null,
        startedMs: Date.parse(line.received_at) || 0,
        endedAt: null,
        durationMs: null,
        gated: false,
        inputJson: null,
        label: toolCallLabel(toolName, rawRecord(line.raw, "tool_input")),
        preEventId: null,
        closeEventId: null,
      }
      this.toolCalls.set(toolUseId, tc)
    }
    if (tc.closed === null) {
      tc.closed = closed
      tc.endedAt = line.received_at
      tc.durationMs = rawNumber(line.raw, "duration_ms")
      tc.closeEventId = line.id
    }
  }

  private applyLaunchLinks(
    run: RunState,
    parent: AgentState,
    kind: string,
    line: HookLine,
    sessionId: string,
    promptId: string | null,
  ): void {
    if (kind !== "PostToolUse") return
    const tr = rawRecord(line.raw, "tool_response")
    if (!tr) return
    const input = rawRecord(line.raw, "tool_input")
    const requestPrompt = input && typeof input.prompt === "string" ? input.prompt : null

    // canal launch (precedencia intermedia): el tool que lanzo trae el id del hijo
    const childId = typeof tr.agentId === "string" ? tr.agentId : null
    if (childId !== null && childId !== parent.agentId) {
      const key = agentKey(run.runId, childId)
      const child = this.agents.get(key)
      if (child) {
        this.setParent(child, parent.agentId, "agent", "launch")
        if (child.requestPrompt === null) child.requestPrompt = requestPrompt
      } else {
        this.pendingParent.set(key, { id: parent.agentId, kind: "agent", prompt: requestPrompt })
      }
    }

    // workflows: runId (wf_*) + taskId corto identifican el nodo intermedio (ADR-010 p.2)
    const wfRunId = typeof tr.runId === "string" && tr.runId.startsWith("wf_") ? tr.runId : null
    if (wfRunId !== null) {
      const taskId = typeof tr.taskId === "string" ? tr.taskId : null
      const info = this.wfInfo.get(wfRunId) ?? { taskId: null, parentAgentId: null }
      info.taskId ??= taskId
      info.parentAgentId ??= parent.agentId
      this.wfInfo.set(wfRunId, info)
      if (taskId !== null) this.taskIdToWf.set(taskId, wfRunId)
      if (promptId !== null) this.wfByTurn.set(`${sessionId}|${promptId}`, wfRunId)
      this.ensureWorkflowTask(run, wfRunId, line.received_at)
    }
  }

  private applyBackgroundTasks(run: RunState, line: HookLine): void {
    const bt = rawArray(line.raw, "background_tasks")
    if (bt === null) return
    const ids = new Set<string>()
    for (const el of bt) {
      if (el === null || typeof el !== "object" || Array.isArray(el)) continue
      const r = el as Record<string, unknown>
      const id = typeof r.id === "string" ? r.id : null
      if (id === null) continue
      ids.add(id)
      const key = `${run.runId} ${id}`
      let task = this.tasks.get(key)
      if (!task) {
        task = {
          taskId: id,
          runId: run.runId,
          taskType: typeof r.type === "string" ? r.type : null,
          status: null,
          description: typeof r.description === "string" ? r.description : null,
          wfRunId: this.taskIdToWf.get(id) ?? null,
          parentAgentId: null,
          firstSeen: line.received_at,
          lastSeen: line.received_at,
          goneAt: null,
        }
        this.tasks.set(key, task)
      }
      task.lastSeen = line.received_at
      if (typeof r.status === "string") task.status = r.status
      task.wfRunId ??= this.taskIdToWf.get(id) ?? null
      if (task.wfRunId !== null) {
        task.parentAgentId ??= this.wfInfo.get(task.wfRunId)?.parentAgentId ?? null
      }
      task.goneAt = null // reaparecer anula el cierre observado
    }
    for (const prevId of run.lastBtIds) {
      if (ids.has(prevId)) continue
      const task = this.tasks.get(`${run.runId} ${prevId}`)
      if (task && task.goneAt === null) task.goneAt = line.received_at
    }
    run.lastBtIds = ids
  }

  /**
   * Estado derivado. `nowMs` (reloj inyectado, opcional) decide si un pending en un run
   * abierto ya es orphan; sin el, se evalua contra el ultimo evento del run. En un run
   * cerrado todo call sin cierre es orphan: ya no puede llegar su post.
   */
  snapshot(nowMs?: number): CorrelationSnapshot {
    const agentsByRun = new Map<string, AgentState[]>()
    for (const a of this.agents.values()) {
      const list = agentsByRun.get(a.runId) ?? []
      list.push(a)
      agentsByRun.set(a.runId, list)
    }
    const runByIdMap = new Map(this.runs.map((r) => [r.runId, r]))
    const callsByAgent = new Map<string, ToolCallView[]>()
    const callCountByRun = new Map<string, number>()
    const toolCalls: ToolCallView[] = []
    for (const tc of this.toolCalls.values()) {
      const view = this.toolCallView(tc, runByIdMap.get(tc.runId), nowMs)
      toolCalls.push(view)
      const key = agentKey(tc.runId, tc.agentId)
      const list = callsByAgent.get(key) ?? []
      list.push(view)
      callsByAgent.set(key, list)
      callCountByRun.set(tc.runId, (callCountByRun.get(tc.runId) ?? 0) + 1)
    }

    const agents: AgentView[] = []
    for (const a of this.agents.values()) {
      const calls = callsByAgent.get(agentKey(a.runId, a.agentId)) ?? []
      const counts = { pending: 0, done: 0, failed: 0, orphan: 0 }
      for (const c of calls) counts[c.state] += 1
      agents.push({
        agent_id: a.agentId,
        run_id: a.runId,
        parent_agent_id: a.parentAgentId,
        parent_kind: a.parentKind,
        parent_source: a.parentSource,
        parent_pending: !a.isRoot && a.parentAgentId === null,
        parent_discrepancy: a.parentDiscrepancy,
        agent_type: a.agentType,
        classification: this.classify(a),
        first_seen: a.firstSeen,
        last_seen: a.lastSeen,
        stopped_at: a.stoppedAt,
        stop_failure_error: a.stopFailureError,
        stop_failure_at: a.stopFailureAt,
        request_prompt: a.requestPrompt,
        last_assistant_message: a.lastAssistantMessage,
        structured_output_event_id: a.structuredOutputEventId,
        agent_transcript_path: a.agentTranscriptPath,
        tool_calls: counts,
      })
    }

    const runs: RunView[] = this.runs.map((r) => ({
      run_id: r.runId,
      session_id: r.sessionId,
      previous_run_id: r.previousRunId,
      transcript_path: r.transcriptPath,
      project_slug:
        r.transcriptPath === null
          ? null
          : (PROJECT_IN_TRANSCRIPT.exec(r.transcriptPath)?.[1] ?? null),
      root_agent_id: r.rootAgentId,
      started_at: r.startedAt,
      last_event_at: r.lastEventAt,
      ended_at: r.endedAt,
      end_reason: r.endReason,
      live: r.endedAt === null && (nowMs ?? r.lastEventMs) - r.lastEventMs <= this.runTimeoutMs,
      start_source: r.startSource,
      model: r.model,
      effort_level: r.effortLevel,
      stop_failure_error:
        r.lastStopFailureError !== null &&
        r.lastStopFailureMs >= (r.lastActivityMs ?? Number.NEGATIVE_INFINITY)
          ? r.lastStopFailureError
          : null,
      administrative: r.lastActivityMs === null,
      compaction_seq: r.compactionSeq,
      event_count: r.eventCount,
      agent_count: (agentsByRun.get(r.runId) ?? []).length,
      tool_call_count: callCountByRun.get(r.runId) ?? 0,
    }))

    const tasks: TaskView[] = [...this.tasks.values()].map((t) => {
      const run = runByIdMap.get(t.runId)
      let state: TaskState
      if (t.goneAt !== null) state = "gone"
      else if (run && run.endedAt !== null) state = "orphan"
      else {
        const reference = nowMs ?? run?.lastEventMs ?? Date.parse(t.lastSeen) ?? 0
        const lastSeenMs = Date.parse(t.lastSeen) || 0
        state = reference - lastSeenMs > this.orphanTimeoutMs ? "orphan" : "running"
      }
      return {
        task_id: t.taskId,
        run_id: t.runId,
        task_type: t.taskType,
        status: t.status,
        description: t.description,
        state,
        wf_run_id: t.wfRunId,
        parent_agent_id: t.parentAgentId,
        first_seen: t.firstSeen,
        last_seen: t.lastSeen,
        gone_at: t.goneAt,
      }
    })

    return { runs, agents, tool_calls: toolCalls, tasks }
  }

  private classify(a: AgentState): AgentClassification {
    if (a.isRoot) return "root"
    const facts = this.agentFacts.get(a.agentId)
    const hasStart = facts?.hasStart ?? a.hasStart
    const toolEvents = facts?.toolEvents ?? a.toolEventCount
    if (a.sawStop && !hasStart && toolEvents === 0) return "utility"
    return "worker"
  }

  private toolCallView(
    tc: ToolCallInternal,
    run: RunState | undefined,
    nowMs?: number,
  ): ToolCallView {
    let state: ToolCallState
    if (tc.closed !== null) state = tc.closed
    else if (run && run.endedAt !== null) state = "orphan"
    else {
      const reference = nowMs ?? run?.lastEventMs ?? tc.startedMs
      state = reference - tc.startedMs > this.orphanTimeoutMs ? "orphan" : "pending"
    }
    const endedMs = tc.endedAt === null ? Number.NaN : Date.parse(tc.endedAt)
    const wallMs =
      tc.startedAt !== null && !Number.isNaN(endedMs) && endedMs >= tc.startedMs
        ? endedMs - tc.startedMs
        : null
    return {
      tool_use_id: tc.toolUseId,
      run_id: tc.runId,
      agent_id: tc.agentId,
      tool_name: tc.toolName,
      state,
      started_at: tc.startedAt,
      ended_at: tc.endedAt,
      wall_ms: wallMs,
      duration_ms: tc.durationMs,
      label: tc.label,
      gated_heuristic: tc.gated,
      pre_event_id: tc.preEventId,
      close_event_id: tc.closeEventId,
    }
  }
}

export function createCorrelator(opts: CorrelatorOptions): Correlator {
  return new Correlator(opts)
}
