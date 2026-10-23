/**
 * Contrato entre el daemon y un proveedor de agentes (ADR-0007 §7).
 *
 * El adaptador traduce el SDK de su proveedor a operaciones de Keel: eventos
 * crudos, proyección de nodos y tool calls, y decisiones de herramientas. Lo
 * que no depende del proveedor lo pone el daemon a través de `RunContext`:
 * dónde se guardan y publican los eventos, la política de aprobación y cómo
 * se termina un run que falla. Un adaptador no importa el store ni el bus.
 *
 * Vive en el daemon hasta que llegue el segundo proveedor (Codex); entonces se
 * mueve a `@keel/agent-runtime` y se corrige con dos casos reales.
 */
import type { CostKind } from "@keel/core"
import type { Repo, RunRow } from "../store/repo.js"

/**
 * Escrituras de proyección que un adaptador puede hacer: nodos de ejecución,
 * tool calls, estado y manifest del run. Las proyecciones se reconstruyen desde
 * `events` (ADR-0004 §4); esto no es la verdad, es su vista.
 */
export type ProjectionStore = Pick<
  Repo,
  | "getRun"
  | "updateRun"
  | "mergeManifest"
  | "upsertAgent"
  | "setAgentState"
  | "agentsOfRun"
  | "openToolCall"
  | "closeToolCall"
  | "openToolCalls"
  | "spill"
>

export type ToolRequest = {
  tool: string
  input: Record<string, unknown>
  /** Se aborta si el run se cancela mientras espera la decisión. */
  signal: AbortSignal
}

export type ToolDecision =
  | { behavior: "allow"; input: Record<string, unknown> }
  | { behavior: "deny"; message: string }

/** Política del daemon para una herramienta que no está auto-aprobada. Una instancia sirve a todos los runs. */
export interface ToolGate {
  decide(ctx: RunContext, req: ToolRequest): Promise<ToolDecision>
}

/** Lo que el daemon le da al adaptador para un run. */
export interface RunContext {
  readonly run: RunRow
  readonly store: ProjectionStore
  /** Decisión del daemon sobre una herramienta no auto-aprobada. */
  decideTool(req: ToolRequest): Promise<ToolDecision>
  /** Persiste un evento crudo del proveedor y lo publica. Devuelve su id, o null si ya existía. */
  record(kind: string, key: string, payload: unknown, occurredAt: string | null): string | null
  /**
   * Borde de la ingesta: redacta secretos (SDD 03 §5), persiste y publica.
   * Devuelve la copia saneada, que es la única que se debe proyectar.
   */
  ingest<T>(
    kind: string,
    key: string,
    payload: T,
    occurredAt: string | null,
  ): { id: string | null; payload: T }
  /** Publica `run.updated` con la vista actual del run. */
  notifyRun(): void
  /** Termina en `failed` un run que no llegó a terminal, con su evento. Si ya es terminal no lo toca. */
  fail(message: string, kind?: string): RunRow
}

export type Preflight = { ok: true } | { ok: false; message: string }

/**
 * Qué ofrece el proveedor, con procedencia medida (spike, FINDINGS). La UI y
 * el scheduler deciden con esto, no con el nombre del proveedor.
 */
export type ProviderCapabilities = {
  auth_modes: readonly string[]
  /** El SDK identifica subagentes y su padre. */
  subagents: boolean
  /** El SDK pregunta antes de usar una herramienta no aprobada. */
  tool_approval: boolean
  /**
   * Qué acciones puede interceptar el gate de Keel, verificado por prueba
   * (ADR-0008 §3): `any_tool`, `command`, `file_change`, `permissions`, `mcp_tool`.
   */
  approval_kinds: readonly string[]
  /** `owned`: Keel lanza el proceso y conoce su pid; `indirect`: el SDK lo lanza (ADR-0008 §5). */
  process_control: "owned" | "indirect"
  /** En qué se mide el presupuesto del run (ADR-0008 §7). */
  budget_unit: "usd" | "tokens"
  /** `process`: cancelar termina el proceso; `turn`: sólo el turno, un comando en curso puede seguir. */
  cancel_scope: "process" | "turn"
  /** Qué tipo de costo reporta (ADR-0002 regla 4). */
  cost_kind: CostKind
  /** Si tras cancelar el SDK emite un mensaje final; si no, el daemon lo sintetiza. */
  cancel_emits_result: boolean
}

export interface ProviderAdapter<Profile> {
  readonly provider: string
  readonly adapterVersion: string
  readonly capabilities: ProviderCapabilities
  readonly activeRuns: number
  /** Comprueba auth, binario y capacidades sin lanzar procesos. */
  preflight(profile: Profile): Preflight
  /**
   * Ejecuta el run hasta un estado terminal y lo devuelve. Los fallos
   * esperables (auth, binario, stream roto, cancelación) terminan el run; no
   * rechaza por ellos.
   */
  execute(ctx: RunContext, prompt: string, profile: Profile): Promise<RunRow>
  cancel(runId: string, reason: string | null): boolean
  /**
   * Un mensaje humano a un run vivo (ADR-0019 §3). Devuelve false si el run ya
   * no acepta mensajes; la entrega real puede ser asíncrona (Codex: `turn/steer`
   * o el turno siguiente).
   */
  sendMessage(runId: string, text: string): boolean
}
