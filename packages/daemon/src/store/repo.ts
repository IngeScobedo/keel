/**
 * Acceso al store (ADR-0004). Sólo el daemon escribe aquí. Cada método es una
 * operación pequeña; las transacciones largas van en un Worker (ADR-0003).
 */
import type { Database } from "bun:sqlite"
import {
  isLive,
  type Lifecycle,
  type LiveRun,
  type NodeState,
  type RunPurpose,
  type RunStatus,
  type VisualState,
  visualForNode,
  visualForRun,
  visualForWorkItem,
} from "@keel/core"
import { nowIso, ulid } from "../ids.js"

export type EventRow = {
  event_seq: number
  id: string
  project_id: string
  run_id: string | null
  source: string
  source_event_key: string
  fidelity: "full" | "partial"
  adapter_version: string
  kind: string
  occurred_at: string | null
  received_at: string
  payload_json: string
}

export type WorkItemRow = {
  id: string
  project_id: string
  display_id: string
  title: string
  lifecycle: Lifecycle
  board_status: string
  revision: number
}
export type RunRow = {
  id: string
  project_id: string
  work_item_id: string
  purpose: RunPurpose
  status: RunStatus
  end_reason: string | null
  context_manifest_json: string
  input_tokens: number
  output_tokens: number
  total_cost_micro_usd: number | null
  cost_kind: "observed" | "estimated" | "unknown"
  started_at: string | null
  ended_at: string | null
}
export type AgentRow = {
  id: string
  run_id: string
  provider: string
  session_id: string
  external_agent_id: string | null
  parent_agent_id: string | null
  parent_source: string | null
  classification: "root" | "worker" | "utility"
  state: NodeState
  agent_type: string | null
  model: string | null
}
export type ToolCallRow = {
  id: string
  run_id: string
  agent_id: string
  tool_use_id: string
  tool_name: string
  label: string
  state: NodeState
  started_at: string
  ended_at: string | null
  wall_ms: number | null
  duration_ms: number | null
  error_message: string | null
}

export type OutboxRow = {
  id: number
  project_id: string
  event_type: string
  aggregate_id: string
  dedupe_key: string
  payload_json: string
  attempts: number
}
export type ProjectRepoRow = { id: string; project_id: string; alias: string; local_path: string }
export type RunWorktreeRow = {
  id: string
  project_id: string
  run_id: string
  project_repo_id: string
  slot: string
  worktree_path: string
  base_sha: string
  head_sha: string | null
  branch_name: string
  access_mode: "read" | "write"
}

export class Repo {
  readonly db: Database
  constructor(db: Database) {
    this.db = db
  }

  // --- workspace / proyecto por defecto ---------------------------------------
  ensureDefaultProject(rootPath: string): { workspace_id: string; project_id: string } {
    const ws = this.db
      .query<{ id: string }, [string]>("SELECT id FROM work_spaces WHERE root_path = ?")
      .get(rootPath)
    const workspaceId = ws?.id ?? ulid()
    if (!ws) {
      this.db
        .query("INSERT INTO work_spaces(id, name, target_id, root_path) VALUES (?, ?, 'local', ?)")
        .run(workspaceId, "default", rootPath)
    }
    const pr = this.db
      .query<{ id: string }, [string]>(
        "SELECT id FROM projects WHERE workspace_id = ? AND slug = 'default'",
      )
      .get(workspaceId)
    const projectId = pr?.id ?? ulid()
    if (!pr)
      this.db
        .query(
          "INSERT INTO projects(id, workspace_id, name, slug) VALUES (?, ?, 'default', 'default')",
        )
        .run(projectId, workspaceId)
    return { workspace_id: workspaceId, project_id: projectId }
  }

  // --- repos del proyecto y worktrees de runs (SDD 03) ----------------------------
  /** Registra (o devuelve) el repo primario del proyecto en `localPath`. */
  ensurePrimaryRepo(p: {
    project_id: string
    local_path: string
    alias: string
    repo_url: string
  }): ProjectRepoRow {
    const existing = this.db
      .query<ProjectRepoRow, [string, string]>(
        "SELECT id, project_id, alias, local_path FROM project_repos WHERE project_id = ? AND local_path = ?",
      )
      .get(p.project_id, p.local_path)
    if (existing) return existing
    const id = ulid()
    this.db
      .query(
        "INSERT INTO project_repos(id, project_id, alias, repo_url, local_path, is_primary) VALUES (?,?,?,?,?,1)",
      )
      .run(id, p.project_id, p.alias, p.repo_url, p.local_path)
    return { id, project_id: p.project_id, alias: p.alias, local_path: p.local_path }
  }
  getProjectRepo(id: string): ProjectRepoRow | null {
    return this.db
      .query<ProjectRepoRow, [string]>(
        "SELECT id, project_id, alias, local_path FROM project_repos WHERE id = ?",
      )
      .get(id)
  }
  addRunWorktree(w: Omit<RunWorktreeRow, "id" | "head_sha">): RunWorktreeRow {
    const id = ulid()
    this.db
      .query(
        "INSERT INTO run_worktrees(id, project_id, run_id, project_repo_id, slot, worktree_path, base_sha, branch_name, access_mode) VALUES (?,?,?,?,?,?,?,?,?)",
      )
      .run(
        id,
        w.project_id,
        w.run_id,
        w.project_repo_id,
        w.slot,
        w.worktree_path,
        w.base_sha,
        w.branch_name,
        w.access_mode,
      )
    return { ...w, id, head_sha: null }
  }
  runWorktrees(runId: string): RunWorktreeRow[] {
    return this.db
      .query<RunWorktreeRow, [string]>(
        "SELECT id, project_id, run_id, project_repo_id, slot, worktree_path, base_sha, head_sha, branch_name, access_mode FROM run_worktrees WHERE run_id = ? ORDER BY created_at",
      )
      .all(runId)
  }
  setWorktreeHead(id: string, headSha: string): void {
    this.db.query("UPDATE run_worktrees SET head_sha = ? WHERE id = ?").run(headSha, id)
  }
  /** Runs de la tarea que tienen worktrees registrados, del más reciente al más antiguo. */
  runsWithWorktrees(workItemId: string): string[] {
    return this.db
      .query<{ id: string }, [string]>(
        "SELECT DISTINCT r.id FROM runs r JOIN run_worktrees w ON w.run_id = r.id WHERE r.work_item_id = ? ORDER BY r.created_at DESC",
      )
      .all(workItemId)
      .map((r) => r.id)
  }

  // --- outbox (SDD 02 §2: entrega al menos una vez, dedupe por clave estable) ------
  /** Encola dentro de la transacción del llamador. Una clave repetida no duplica el mensaje. */
  enqueueOutbox(m: {
    project_id: string
    event_type: string
    aggregate_id: string
    dedupe_key: string
    payload: unknown
  }): void {
    this.db
      .query(
        "INSERT OR IGNORE INTO outbox(project_id, event_type, aggregate_id, dedupe_key, payload_json) VALUES (?,?,?,?,?)",
      )
      .run(m.project_id, m.event_type, m.aggregate_id, m.dedupe_key, JSON.stringify(m.payload))
  }
  pendingOutbox(eventTypes: readonly string[]): OutboxRow[] {
    if (eventTypes.length === 0) return []
    return this.db
      .query<OutboxRow, string[]>(
        `SELECT id, project_id, event_type, aggregate_id, dedupe_key, payload_json, attempts FROM outbox WHERE delivered_at IS NULL AND event_type IN (${eventTypes.map(() => "?").join(",")}) ORDER BY id`,
      )
      .all(...eventTypes)
  }
  hasPendingOutbox(dedupeKey: string): boolean {
    return (
      this.db
        .query<{ n: number }, [string]>(
          "SELECT count(*) n FROM outbox WHERE dedupe_key = ? AND delivered_at IS NULL",
        )
        .get(dedupeKey)?.n === 1
    )
  }
  markOutboxAttempt(id: number): void {
    this.db.query("UPDATE outbox SET attempts = attempts + 1 WHERE id = ?").run(id)
  }
  markOutboxDelivered(id: number): void {
    this.db
      .query("UPDATE outbox SET delivered_at = ? WHERE id = ? AND delivered_at IS NULL")
      .run(nowIso(), id)
  }
  getOutbox(dedupeKey: string): (OutboxRow & { delivered_at: string | null }) | null {
    return this.db
      .query<OutboxRow & { delivered_at: string | null }, [string]>(
        "SELECT id, project_id, event_type, aggregate_id, dedupe_key, payload_json, attempts, delivered_at FROM outbox WHERE dedupe_key = ?",
      )
      .get(dedupeKey)
  }

  // --- eventos (append-only) ---------------------------------------------------
  appendEvent(
    e: Omit<EventRow, "event_seq" | "received_at" | "id"> & { id?: string },
  ): EventRow | null {
    const id = e.id ?? ulid()
    const received_at = nowIso()
    try {
      this.db
        .query(
          "INSERT INTO events(id, project_id, run_id, source, source_event_key, fidelity, adapter_version, kind, occurred_at, received_at, payload_json) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
        )
        .run(
          id,
          e.project_id,
          e.run_id,
          e.source,
          e.source_event_key,
          e.fidelity,
          e.adapter_version,
          e.kind,
          e.occurred_at,
          received_at,
          e.payload_json,
        )
    } catch (err) {
      // UNIQUE(project_id, source, source_event_key): el evento ya está; no es error (ingesta idempotente, ADR-0002 Mirador).
      if (String(err).includes("UNIQUE")) return null
      throw err
    }
    return this.db
      .query<EventRow, [string]>("SELECT * FROM events WHERE id = ?")
      .get(id) as EventRow
  }
  /** Una página de eventos con `seq < event_seq <= upTo`, en orden. */
  eventsAfter(
    seq: number,
    projectId: string | null,
    limit = 1000,
    upTo = Number.MAX_SAFE_INTEGER,
  ): EventRow[] {
    return projectId
      ? this.db
          .query<EventRow, [number, number, string, number]>(
            "SELECT * FROM events WHERE event_seq > ? AND event_seq <= ? AND project_id = ? ORDER BY event_seq LIMIT ?",
          )
          .all(seq, upTo, projectId, limit)
      : this.db
          .query<EventRow, [number, number, number]>(
            "SELECT * FROM events WHERE event_seq > ? AND event_seq <= ? ORDER BY event_seq LIMIT ?",
          )
          .all(seq, upTo, limit)
  }
  lastEventSeq(): number {
    return (
      this.db.query<{ s: number | null }, []>("SELECT max(event_seq) s FROM events").get()?.s ?? 0
    )
  }

  // --- work items ----------------------------------------------------------------
  createWorkItem(p: {
    project_id: string
    title: string
    kind: string
    spec_markdown?: string
    source?: string
  }): WorkItemRow {
    const n =
      this.db
        .query<{ n: number }, [string]>("SELECT count(*) n FROM work_items WHERE project_id = ?")
        .get(p.project_id)?.n ?? 0
    const id = ulid()
    const display = `KEEL-${n + 1}`
    this.db
      .query(
        "INSERT INTO work_items(id, project_id, display_id, title, spec_markdown, kind, source) VALUES (?,?,?,?,?,?,?)",
      )
      .run(id, p.project_id, display, p.title, p.spec_markdown ?? "", p.kind, p.source ?? "human")
    return this.getWorkItem(id) as WorkItemRow
  }
  getWorkItem(id: string): WorkItemRow | null {
    return this.db
      .query<WorkItemRow, [string]>(
        "SELECT id, project_id, display_id, title, lifecycle, board_status, revision FROM work_items WHERE id = ?",
      )
      .get(id)
  }
  listWorkItems(projectId: string): WorkItemRow[] {
    return this.db
      .query<WorkItemRow, [string]>(
        "SELECT id, project_id, display_id, title, lifecycle, board_status, revision FROM work_items WHERE project_id = ? ORDER BY created_at",
      )
      .all(projectId)
  }
  /**
   * Compare-and-set: cambia el lifecycle sólo si la fila sigue en `from` y, si
   * se da, en `revision`. Devuelve null si otro escritor llegó antes. La
   * validez de la transición la decide `checkTransition` de @keel/core.
   */
  setLifecycle(
    id: string,
    to: Lifecycle,
    expect: { from: Lifecycle; revision?: number },
  ): WorkItemRow | null {
    const r = this.db
      .query(
        "UPDATE work_items SET lifecycle = ?, revision = revision + 1, updated_at = ? WHERE id = ? AND lifecycle = ? AND (? IS NULL OR revision = ?)",
      )
      .run(to, nowIso(), id, expect.from, expect.revision ?? null, expect.revision ?? null)
    return r.changes === 1 ? this.getWorkItem(id) : null
  }

  // --- bloqueos (guardas del scheduler, SDD 03 work_item_blocks) --------------------------
  openBlocks(workItemId: string): { kind: string; reason_key: string }[] {
    return this.db
      .query<{ kind: string; reason_key: string }, [string]>(
        "SELECT kind, reason_key FROM work_item_blocks WHERE work_item_id = ? AND cleared_at IS NULL ORDER BY kind, reason_key",
      )
      .all(workItemId)
  }
  addBlock(p: {
    work_item_id: string
    kind: "planning" | "dependency" | "lane" | "human" | "budget" | "environment"
    reason_key: string
    details?: Record<string, unknown>
  }): void {
    this.db
      .query(
        "INSERT INTO work_item_blocks(id, work_item_id, kind, reason_key, details_json) VALUES (?,?,?,?,?)",
      )
      .run(ulid(), p.work_item_id, p.kind, p.reason_key, JSON.stringify(p.details ?? {}))
  }

  // --- runs -----------------------------------------------------------------------
  createRun(p: {
    project_id: string
    work_item_id: string
    purpose: RunPurpose
    manifest?: Record<string, unknown>
  }): RunRow {
    const id = ulid()
    this.db
      .query(
        "INSERT INTO runs(id, project_id, work_item_id, purpose, status, context_manifest_json, cost_kind) VALUES (?,?,?,?, 'queued', ?, 'unknown')",
      )
      .run(id, p.project_id, p.work_item_id, p.purpose, JSON.stringify(p.manifest ?? {}))
    return this.getRun(id) as RunRow
  }
  getRun(id: string): RunRow | null {
    return this.db.query<RunRow, [string]>("SELECT * FROM runs WHERE id = ?").get(id)
  }
  listRuns(projectId: string): RunRow[] {
    return this.db
      .query<RunRow, [string]>("SELECT * FROM runs WHERE project_id = ? ORDER BY created_at")
      .all(projectId)
  }
  liveRunFor(workItemId: string): RunRow | null {
    const r = this.db
      .query<RunRow, [string]>(
        "SELECT * FROM runs WHERE work_item_id = ? ORDER BY created_at DESC LIMIT 1",
      )
      .get(workItemId)
    return r && isLive(r.status) ? r : null
  }
  liveRuns(): RunRow[] {
    return this.db
      .query<RunRow, []>(
        "SELECT * FROM runs WHERE status IN ('queued','initializing','running','paused','waiting_human')",
      )
      .all()
  }
  updateRun(
    id: string,
    patch: Partial<Omit<RunRow, "id" | "project_id" | "work_item_id">>,
  ): RunRow {
    const keys = Object.keys(patch) as (keyof typeof patch)[]
    if (keys.length === 0) return this.getRun(id) as RunRow
    const sets = keys.map((k) => `${k} = ?`).join(", ")
    this.db
      .query(`UPDATE runs SET ${sets} WHERE id = ?`)
      .run(...keys.map((k) => patch[k] as string | number | null), id)
    return this.getRun(id) as RunRow
  }
  mergeManifest(id: string, patch: Record<string, unknown>): RunRow {
    const run = this.getRun(id) as RunRow
    const manifest = {
      ...(JSON.parse(run.context_manifest_json) as Record<string, unknown>),
      ...patch,
    }
    return this.updateRun(id, { context_manifest_json: JSON.stringify(manifest) })
  }

  // --- nodos de ejecución (proyecciones) ---------------------------------------------
  upsertAgent(
    a: Omit<AgentRow, "state"> & { state?: NodeState; first_seen: string; last_seen: string },
  ): AgentRow {
    const existing = this.db
      .query<AgentRow, [string]>("SELECT * FROM agent_instances WHERE id = ?")
      .get(a.id)
    if (existing) {
      this.db
        .query(
          "UPDATE agent_instances SET last_seen = ?, state = ?, parent_agent_id = coalesce(?, parent_agent_id), parent_source = coalesce(?, parent_source), agent_type = coalesce(?, agent_type), model = coalesce(?, model) WHERE id = ?",
        )
        .run(
          a.last_seen,
          a.state ?? existing.state,
          a.parent_agent_id,
          a.parent_source,
          a.agent_type,
          a.model,
          a.id,
        )
    } else {
      this.db
        .query(
          "INSERT INTO agent_instances(id, run_id, provider, session_id, external_agent_id, parent_agent_id, parent_source, classification, state, agent_type, model, first_seen, last_seen) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
        )
        .run(
          a.id,
          a.run_id,
          a.provider,
          a.session_id,
          a.external_agent_id,
          a.parent_agent_id,
          a.parent_source,
          a.classification,
          a.state ?? "running",
          a.agent_type,
          a.model,
          a.first_seen,
          a.last_seen,
        )
    }
    return this.db
      .query<AgentRow, [string]>("SELECT * FROM agent_instances WHERE id = ?")
      .get(a.id) as AgentRow
  }
  setAgentState(
    id: string,
    state: NodeState,
    stoppedAt: string | null = null,
    error: string | null = null,
  ): void {
    this.db
      .query(
        "UPDATE agent_instances SET state = ?, stopped_at = coalesce(?, stopped_at), stop_failure_error = coalesce(?, stop_failure_error), last_seen = ? WHERE id = ?",
      )
      .run(state, stoppedAt, error, nowIso(), id)
  }
  agentsOfRun(runId: string): AgentRow[] {
    return this.db
      .query<AgentRow, [string]>(
        "SELECT * FROM agent_instances WHERE run_id = ? ORDER BY first_seen",
      )
      .all(runId)
  }
  openToolCall(
    t: Omit<
      ToolCallRow,
      "id" | "state" | "ended_at" | "wall_ms" | "duration_ms" | "error_message"
    > & { input_json: string | null },
  ): ToolCallRow {
    const id = ulid()
    this.db
      .query(
        "INSERT INTO tool_calls(id, run_id, agent_id, tool_use_id, tool_name, label, state, started_at, input_json) VALUES (?,?,?,?,?,?,'running',?,?)",
      )
      .run(
        id,
        t.run_id,
        t.agent_id,
        t.tool_use_id,
        t.tool_name,
        t.label,
        t.started_at,
        t.input_json,
      )
    return this.db
      .query<ToolCallRow, [string]>("SELECT * FROM tool_calls WHERE id = ?")
      .get(id) as ToolCallRow
  }
  closeToolCall(p: {
    run_id: string
    tool_use_id: string
    state: NodeState
    ended_at: string
    duration_ms: number | null
    output_json: string | null
    artifact_ref?: string | null
    error_message: string | null
  }): ToolCallRow | null {
    const row = this.db
      .query<ToolCallRow, [string, string]>(
        "SELECT * FROM tool_calls WHERE run_id = ? AND tool_use_id = ?",
      )
      .get(p.run_id, p.tool_use_id)
    if (!row) return null
    const wall = new Date(p.ended_at).getTime() - new Date(row.started_at).getTime()
    this.db
      .query(
        "UPDATE tool_calls SET state = ?, ended_at = ?, wall_ms = ?, duration_ms = ?, output_json = ?, artifact_ref = ?, error_message = ? WHERE id = ?",
      )
      .run(
        p.state,
        p.ended_at,
        Math.max(0, wall),
        p.duration_ms,
        p.output_json,
        p.artifact_ref ?? null,
        p.error_message,
        row.id,
      )
    return this.db.query<ToolCallRow, [string]>("SELECT * FROM tool_calls WHERE id = ?").get(row.id)
  }
  openToolCalls(runId: string): ToolCallRow[] {
    return this.db
      .query<ToolCallRow, [string]>(
        "SELECT * FROM tool_calls WHERE run_id = ? AND state IN ('pending','running','waiting_human')",
      )
      .all(runId)
  }
  toolCallsOfRun(runId: string): ToolCallRow[] {
    return this.db
      .query<ToolCallRow, [string]>("SELECT * FROM tool_calls WHERE run_id = ? ORDER BY started_at")
      .all(runId)
  }

  // --- recibos de comandos (idempotencia, ADR-0005) ------------------------------------
  getReceipt(
    projectId: string,
    actorId: string,
    key: string,
  ): { request_hash: string; result_json: string } | null {
    return this.db
      .query<{ request_hash: string; result_json: string }, [string, string, string]>(
        "SELECT request_hash, result_json FROM command_receipts WHERE project_id = ? AND actor_id = ? AND idempotency_key = ?",
      )
      .get(projectId, actorId, key)
  }
  putReceipt(
    projectId: string,
    actorId: string,
    key: string,
    requestHash: string,
    result: unknown,
  ): void {
    this.db
      .query(
        "INSERT INTO command_receipts(project_id, actor_id, idempotency_key, request_hash, result_json) VALUES (?,?,?,?,?)",
      )
      .run(projectId, actorId, key, requestHash, JSON.stringify(result))
  }

  // --- aprobaciones ------------------------------------------------------------------
  createApproval(p: {
    project_id: string
    run_id: string
    operation_hash: string
    operation: unknown
    expires_at: string
  }): string {
    const id = ulid()
    this.db
      .query(
        "INSERT INTO approval_requests(id, project_id, run_id, operation_hash, operation_json, state, expires_at) VALUES (?,?,?,?,?,'pending',?)",
      )
      .run(id, p.project_id, p.run_id, p.operation_hash, JSON.stringify(p.operation), p.expires_at)
    return id
  }
  getApproval(id: string): {
    id: string
    project_id: string
    run_id: string
    operation_hash: string
    operation_json: string
    state: string
    expires_at: string | null
  } | null {
    return this.db
      .query<
        {
          id: string
          project_id: string
          run_id: string
          operation_hash: string
          operation_json: string
          state: string
          expires_at: string | null
        },
        [string]
      >("SELECT * FROM approval_requests WHERE id = ?")
      .get(id)
  }
  setApproval(
    id: string,
    state: "approved" | "denied" | "expired" | "consumed",
    actor: string | null,
  ): void {
    this.db
      .query(
        "UPDATE approval_requests SET state = ?, decision_actor = coalesce(?, decision_actor) WHERE id = ?",
      )
      .run(state, actor, id)
  }

  // --- vistas con visual_state (ADR-0006 §3) -------------------------------------------
  workItemView(w: WorkItemRow) {
    const live = this.liveRunFor(w.id)
    const liveRun: LiveRun = live ? { status: live.status, purpose: live.purpose } : null
    return {
      id: w.id,
      project_id: w.project_id,
      display_id: w.display_id,
      title: w.title,
      lifecycle: w.lifecycle,
      board_status: w.board_status,
      revision: w.revision,
      visual_state: visualForWorkItem(w.lifecycle, liveRun),
    }
  }
  runView(r: RunRow) {
    return {
      id: r.id,
      work_item_id: r.work_item_id,
      purpose: r.purpose,
      status: r.status,
      end_reason: r.end_reason,
      cost_kind: r.cost_kind,
      total_cost_micro_usd: r.total_cost_micro_usd,
      revision: 0,
      visual_state: visualForRun(r.status, r.purpose),
    }
  }
  nodeView(
    kind: "agent" | "workflow" | "tool_call",
    n: {
      id: string
      run_id: string
      state: NodeState
      parent_id?: string | null
      parent_source?: string | null
    },
  ): {
    id: string
    run_id: string
    kind: typeof kind
    state: NodeState
    parent_id: string | null
    parent_source: "sdk" | "transcript" | "launch" | "prompt" | null
    revision: number
    visual_state: VisualState
  } {
    return {
      id: n.id,
      run_id: n.run_id,
      kind,
      state: n.state,
      parent_id: n.parent_id ?? null,
      parent_source: (n.parent_source ?? null) as "sdk" | "transcript" | "launch" | "prompt" | null,
      revision: 0,
      visual_state: visualForNode(n.state),
    }
  }
}
