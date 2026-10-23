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
  /** Run del que continúa esta conversación (ADR-0019 §3). */
  parent_run_id: string | null
}
export type PermissionRuleRow = {
  id: string
  project_id: string
  tool: string
  prefix: string | null
  exact: number
  effect: "auto" | "deny"
  source_approval_id: string | null
  created_by: string
  created_at: string
  expires_at: string | null
  revoked_at: string | null
  revoked_by: string | null
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

export type PairingRow = {
  id: string
  code: string
  client_name: string
  cwd: string | null
  state: "pending" | "approved" | "rejected" | "closed"
  project_id: string | null
  work_item_id: string | null
  scopes_json: string
  created_at: string
}

export type RunRequestRow = {
  id: string
  project_id: string
  work_item_id: string
  purpose: RunPurpose
  prompt: string | null
  profile: string | null
  reason: string
  requested_by: string
  requested_by_run: string | null
  state: "pending" | "started" | "rejected"
  run_id: string | null
  created_at: string
}

const PAIRING_COLS =
  "id, code, client_name, cwd, state, project_id, work_item_id, scopes_json, created_at"
const RUN_REQUEST_COLS =
  "id, project_id, work_item_id, purpose, prompt, profile, reason, requested_by, requested_by_run, state, run_id, created_at"

export type NoteRow = {
  id: string
  work_item_id: string
  author: string
  content_markdown: string
  created_at: string
}

export type RunSnapshotRow = {
  id: string
  project_id: string
  run_id: string
  root_path: string
  snapshot_dir: string
  manifest_sha256: string
  file_count: number
  total_bytes: number
  released_at: string | null
  restored_at: string | null
}

export type ProjectVcs = {
  vcs: "git" | "none"
  vcs_none_confirmed_at: string | null
  vcs_none_confirmed_by: string | null
}

const SNAPSHOT_COLS =
  "id, project_id, run_id, root_path, snapshot_dir, manifest_sha256, file_count, total_bytes, released_at, restored_at"

export class Repo {
  readonly db: Database
  constructor(db: Database) {
    this.db = db
  }

  // --- workspace / proyecto por defecto ---------------------------------------
  ensureDefaultProject(
    rootPath: string,
    name = "default",
  ): { workspace_id: string; project_id: string } {
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
        .query("INSERT INTO projects(id, workspace_id, name, slug) VALUES (?, ?, ?, 'default')")
        .run(projectId, workspaceId, name)
    return { workspace_id: workspaceId, project_id: projectId }
  }

  /** Carpeta de un proyecto: la de su `work_space` (ADR-0019 §2). */
  projectRoot(projectId: string): string | null {
    return (
      this.db
        .query<{ root_path: string }, [string]>(
          "SELECT w.root_path FROM projects p JOIN work_spaces w ON w.id = p.workspace_id WHERE p.id = ?",
        )
        .get(projectId)?.root_path ?? null
    )
  }
  listProjects(): {
    id: string
    name: string
    root_path: string
    vcs: string
    last_opened_at: string | null
    created_at: string
  }[] {
    return this.db
      .query<
        {
          id: string
          name: string
          root_path: string
          vcs: string
          last_opened_at: string | null
          created_at: string
        },
        []
      >(
        `SELECT p.id, p.name, w.root_path, p.vcs, p.last_opened_at, p.created_at
           FROM projects p JOIN work_spaces w ON w.id = p.workspace_id
          WHERE p.archived_at IS NULL
          ORDER BY coalesce(p.last_opened_at, p.created_at) DESC`,
      )
      .all()
  }
  touchProject(projectId: string): void {
    this.db
      .query(
        "UPDATE projects SET last_opened_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?",
      )
      .run(projectId)
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
  /** La conversación continúa: los worktrees del run padre pasan al hijo. */
  transferWorktrees(fromRunId: string, toRunId: string): void {
    this.db.query("UPDATE run_worktrees SET run_id = ? WHERE run_id = ?").run(toRunId, fromRunId)
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
  /** Runs de la tarea con worktree o snapshot registrado, del más reciente al más antiguo. */
  runsWithWorkspaces(workItemId: string): string[] {
    return this.db
      .query<{ id: string }, [string, string]>(
        `SELECT id FROM runs WHERE id IN (
           SELECT r.id FROM runs r JOIN run_worktrees w ON w.run_id = r.id WHERE r.work_item_id = ?
           UNION SELECT r.id FROM runs r JOIN run_snapshots s ON s.run_id = r.id WHERE r.work_item_id = ?
         ) ORDER BY created_at DESC`,
      )
      .all(workItemId, workItemId)
      .map((r) => r.id)
  }

  // --- emparejamiento de sesiones externas (ADR-0009 §4, migración 0003) -------------
  createPairing(p: { code: string; client_name: string; cwd: string | null }): PairingRow {
    const id = ulid()
    this.db
      .query("INSERT INTO session_pairings(id, code, client_name, cwd) VALUES (?,?,?,?)")
      .run(id, p.code, p.client_name, p.cwd)
    return this.getPairing(id) as PairingRow
  }
  getPairing(id: string): PairingRow | null {
    return this.db
      .query<PairingRow, [string]>(`SELECT ${PAIRING_COLS} FROM session_pairings WHERE id = ?`)
      .get(id)
  }
  listPairings(state?: PairingRow["state"]): PairingRow[] {
    return state
      ? this.db
          .query<PairingRow, [string]>(
            `SELECT ${PAIRING_COLS} FROM session_pairings WHERE state = ? ORDER BY created_at, id`,
          )
          .all(state)
      : this.db
          .query<PairingRow, []>(
            `SELECT ${PAIRING_COLS} FROM session_pairings ORDER BY created_at, id`,
          )
          .all()
  }
  /** Resuelve sólo una pendiente (compare-and-set); devuelve null si ya no lo estaba. */
  resolvePairing(
    id: string,
    p: {
      state: "approved" | "rejected"
      project_id: string | null
      work_item_id: string | null
      scopes: readonly string[]
      decided_by: string
    },
  ): PairingRow | null {
    const changed = this.db
      .query(
        "UPDATE session_pairings SET state = ?, project_id = ?, work_item_id = ?, scopes_json = ?, decided_by = ?, decided_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ? AND state = 'pending'",
      )
      .run(p.state, p.project_id, p.work_item_id, JSON.stringify(p.scopes), p.decided_by, id)
    return changed.changes === 1 ? this.getPairing(id) : null
  }
  closePairing(id: string): void {
    this.db
      .query(
        "UPDATE session_pairings SET state = 'closed', closed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ? AND state IN ('pending', 'approved')",
      )
      .run(id)
  }

  // --- peticiones de run de agentes (ADR-0009 §5, migración 0003) --------------------
  createRunRequest(
    r: Omit<RunRequestRow, "id" | "state" | "run_id" | "created_at">,
  ): RunRequestRow {
    const id = ulid()
    this.db
      .query(
        "INSERT INTO run_requests(id, project_id, work_item_id, purpose, prompt, profile, reason, requested_by, requested_by_run) VALUES (?,?,?,?,?,?,?,?,?)",
      )
      .run(
        id,
        r.project_id,
        r.work_item_id,
        r.purpose,
        r.prompt,
        r.profile,
        r.reason,
        r.requested_by,
        r.requested_by_run,
      )
    return this.getRunRequest(id) as RunRequestRow
  }
  getRunRequest(id: string): RunRequestRow | null {
    return this.db
      .query<RunRequestRow, [string]>(`SELECT ${RUN_REQUEST_COLS} FROM run_requests WHERE id = ?`)
      .get(id)
  }
  listRunRequests(projectId: string, state?: RunRequestRow["state"]): RunRequestRow[] {
    return state
      ? this.db
          .query<RunRequestRow, [string, string]>(
            `SELECT ${RUN_REQUEST_COLS} FROM run_requests WHERE project_id = ? AND state = ? ORDER BY created_at, id`,
          )
          .all(projectId, state)
      : this.db
          .query<RunRequestRow, [string]>(
            `SELECT ${RUN_REQUEST_COLS} FROM run_requests WHERE project_id = ? ORDER BY created_at, id`,
          )
          .all(projectId)
  }
  /** Compare-and-set desde `pending`; null si ya estaba resuelta. */
  resolveRunRequest(
    id: string,
    p: { state: "started" | "rejected"; run_id: string | null; decided_by: string },
  ): RunRequestRow | null {
    const changed = this.db
      .query(
        "UPDATE run_requests SET state = ?, run_id = ?, decided_by = ?, decided_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ? AND state = 'pending'",
      )
      .run(p.state, p.run_id, p.decided_by, id)
    return changed.changes === 1 ? this.getRunRequest(id) : null
  }

  // --- modo sin VCS (ADR-0010, migración 0002) --------------------------------------
  getProjectVcs(projectId: string): ProjectVcs {
    const row = this.db
      .query<ProjectVcs, [string]>(
        "SELECT vcs, vcs_none_confirmed_at, vcs_none_confirmed_by FROM projects WHERE id = ?",
      )
      .get(projectId)
    if (!row) throw new Error(`el proyecto ${projectId} no existe`)
    return row
  }
  /** `none` queda confirmado por quien lo pide (el daemon sólo deja hacerlo a un humano). */
  setProjectVcs(projectId: string, vcs: "git" | "none", actorId: string): ProjectVcs {
    if (vcs === "none")
      this.db
        .query(
          "UPDATE projects SET vcs = 'none', vcs_none_confirmed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), vcs_none_confirmed_by = ? WHERE id = ?",
        )
        .run(actorId, projectId)
    else
      this.db
        .query(
          "UPDATE projects SET vcs = 'git', vcs_none_confirmed_at = NULL, vcs_none_confirmed_by = NULL WHERE id = ?",
        )
        .run(projectId)
    return this.getProjectVcs(projectId)
  }
  addRunSnapshot(s: Omit<RunSnapshotRow, "id" | "released_at" | "restored_at">): RunSnapshotRow {
    const id = ulid()
    this.db
      .query(
        "INSERT INTO run_snapshots(id, project_id, run_id, root_path, snapshot_dir, manifest_sha256, file_count, total_bytes) VALUES (?,?,?,?,?,?,?,?)",
      )
      .run(
        id,
        s.project_id,
        s.run_id,
        s.root_path,
        s.snapshot_dir,
        s.manifest_sha256,
        s.file_count,
        s.total_bytes,
      )
    return { ...s, id, released_at: null, restored_at: null }
  }
  runSnapshot(runId: string): RunSnapshotRow | null {
    return this.db
      .query<RunSnapshotRow, [string]>(
        `SELECT ${SNAPSHOT_COLS} FROM run_snapshots WHERE run_id = ?`,
      )
      .get(runId)
  }
  /** El snapshot sin liberar de la carpeta: su candado de un escritor. */
  activeSnapshotForRoot(rootPath: string): RunSnapshotRow | null {
    return this.db
      .query<RunSnapshotRow, [string]>(
        `SELECT ${SNAPSHOT_COLS} FROM run_snapshots WHERE root_path = ? AND released_at IS NULL`,
      )
      .get(rootPath)
  }
  releaseSnapshot(id: string): void {
    this.db
      .query(
        "UPDATE run_snapshots SET released_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ? AND released_at IS NULL",
      )
      .run(id)
  }
  markSnapshotRestored(id: string): void {
    this.db
      .query(
        "UPDATE run_snapshots SET restored_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?",
      )
      .run(id)
  }

  // --- gasto estimado (limits.ts) -----------------------------------------------------
  /** Costo estimado de los runs del proyecto que arrancaron desde `sinceIso`. */
  spentSince(projectId: string, sinceIso: string): number {
    return (
      this.db
        .query<{ s: number | null }, [string, string]>(
          "SELECT sum(total_cost_micro_usd) s FROM runs WHERE project_id = ? AND started_at >= ?",
        )
        .get(projectId, sinceIso)?.s ?? 0
    )
  }
  spentOnWorkItem(workItemId: string): number {
    return (
      this.db
        .query<{ s: number | null }, [string]>(
          "SELECT sum(total_cost_micro_usd) s FROM runs WHERE work_item_id = ?",
        )
        .get(workItemId)?.s ?? 0
    )
  }
  workItemBudgetCap(workItemId: string): number | null {
    return (
      this.db
        .query<{ c: number | null }, [string]>(
          "SELECT budget_micro_usd_cap c FROM work_items WHERE id = ?",
        )
        .get(workItemId)?.c ?? null
    )
  }
  setWorkItemBudgetCap(workItemId: string, capMicroUsd: number | null): void {
    this.db
      .query("UPDATE work_items SET budget_micro_usd_cap = ? WHERE id = ?")
      .run(capMicroUsd, workItemId)
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
  workItemSpec(id: string): string {
    return (
      this.db
        .query<{ spec_markdown: string }, [string]>(
          "SELECT spec_markdown FROM work_items WHERE id = ?",
        )
        .get(id)?.spec_markdown ?? ""
    )
  }
  addNote(p: { work_item_id: string; author: string; content_markdown: string }): NoteRow {
    const id = ulid()
    this.db
      .query("INSERT INTO notes(id, work_item_id, author, content_markdown) VALUES (?,?,?,?)")
      .run(id, p.work_item_id, p.author, p.content_markdown)
    return this.db
      .query<NoteRow, [string]>(
        "SELECT id, work_item_id, author, content_markdown, created_at FROM notes WHERE id = ?",
      )
      .get(id) as NoteRow
  }
  listNotes(workItemId: string): NoteRow[] {
    return this.db
      .query<NoteRow, [string]>(
        "SELECT id, work_item_id, author, content_markdown, created_at FROM notes WHERE work_item_id = ? ORDER BY created_at, id",
      )
      .all(workItemId)
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
    parent_run_id?: string | null
  }): RunRow {
    const id = ulid()
    this.db
      .query(
        "INSERT INTO runs(id, project_id, work_item_id, purpose, status, context_manifest_json, cost_kind, parent_run_id) VALUES (?,?,?,?, 'queued', ?, 'unknown', ?)",
      )
      .run(
        id,
        p.project_id,
        p.work_item_id,
        p.purpose,
        JSON.stringify(p.manifest ?? {}),
        p.parent_run_id ?? null,
      )
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
  /**
   * Pendientes (excluye las vencidas aunque el gate aún no las haya marcado) o,
   * con `includeResolved`, el historial de decisiones para la vista de permisos.
   */
  listApprovals(
    projectId: string,
    q: { state?: string; includeResolved?: boolean; runId?: string; limit?: number } = {},
  ): ApprovalListRow[] {
    const where = ["a.project_id = ?"]
    const args: string[] = [projectId]
    if (q.runId) {
      where.push("a.run_id = ?")
      args.push(q.runId)
    }
    if (!q.includeResolved || q.state) {
      const state = q.state ?? "pending"
      where.push("a.state = ?")
      args.push(state)
      if (state === "pending") {
        where.push("(a.expires_at IS NULL OR a.expires_at > ?)")
        args.push(new Date().toISOString())
      }
    }
    return this.db
      .query<ApprovalListRow, string[]>(
        `SELECT a.id, a.run_id, r.work_item_id, a.operation_hash, a.operation_json, a.state,
                a.expires_at, a.decision_actor
           FROM approval_requests a JOIN runs r ON r.id = a.run_id
          WHERE ${where.join(" AND ")}
          ORDER BY a.id DESC LIMIT ${Math.min(q.limit ?? 200, 1000)}`,
      )
      .all(...args)
  }

  // --- reglas de permiso (ADR-0019 §4) -------------------------------------------------
  addPermissionRule(p: {
    project_id: string
    tool: string
    prefix: string | null
    exact: boolean
    effect: "auto" | "deny"
    created_by: string
    source_approval_id?: string | null
    expires_at?: string | null
  }): PermissionRuleRow {
    const id = ulid()
    this.db
      .query(
        "INSERT INTO permission_rules(id, project_id, tool, prefix, exact, effect, source_approval_id, created_by, expires_at) VALUES (?,?,?,?,?,?,?,?,?)",
      )
      .run(
        id,
        p.project_id,
        p.tool,
        p.prefix,
        p.exact ? 1 : 0,
        p.effect,
        p.source_approval_id ?? null,
        p.created_by,
        p.expires_at ?? null,
      )
    return this.getPermissionRule(id) as PermissionRuleRow
  }
  getPermissionRule(id: string): PermissionRuleRow | null {
    return this.db
      .query<PermissionRuleRow, [string]>("SELECT * FROM permission_rules WHERE id = ?")
      .get(id)
  }
  /** Activas: sin revocar y sin vencer. Con `includeRevoked`, todas. */
  listPermissionRules(projectId: string, includeRevoked = false): PermissionRuleRow[] {
    return includeRevoked
      ? this.db
          .query<PermissionRuleRow, [string]>(
            "SELECT * FROM permission_rules WHERE project_id = ? ORDER BY created_at DESC, id DESC",
          )
          .all(projectId)
      : this.db
          .query<PermissionRuleRow, [string, string]>(
            `SELECT * FROM permission_rules WHERE project_id = ? AND revoked_at IS NULL
               AND (expires_at IS NULL OR expires_at > ?) ORDER BY created_at DESC, id DESC`,
          )
          .all(projectId, new Date().toISOString())
  }
  revokePermissionRule(id: string, actor: string): PermissionRuleRow | null {
    this.db
      .query(
        "UPDATE permission_rules SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), revoked_by = ? WHERE id = ? AND revoked_at IS NULL",
      )
      .run(actor, id)
    return this.getPermissionRule(id)
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
      options: runOptionsOf(r),
      isolation: isolationOf(r),
      parent_run_id: r.parent_run_id ?? null,
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

export type ApprovalListRow = {
  id: string
  run_id: string
  work_item_id: string
  operation_hash: string
  operation_json: string
  state: string
  expires_at: string | null
  decision_actor: string | null
}

/** Opciones efectivas del run, del manifest; los runs viejos no las tienen. */
function runOptionsOf(r: RunRow): {
  model: string | null
  max_turns: number | null
  permission_mode: "ask" | "accept_edits" | "plan" | "bypass"
} | null {
  const m = JSON.parse(r.context_manifest_json) as {
    options?: { model?: string | null; max_turns?: number | null; permission_mode?: string }
  }
  const o = m.options
  if (!o?.permission_mode) return null
  return {
    model: o.model ?? null,
    max_turns: o.max_turns ?? null,
    permission_mode: o.permission_mode as "ask" | "accept_edits" | "plan" | "bypass",
  }
}

/** Aislamiento del run según su manifest (ADR-0018). */
function isolationOf(r: RunRow): "none" | "sandbox" | "provider" | "os_user" | null {
  const m = JSON.parse(r.context_manifest_json) as {
    isolation?: "none" | "sandbox" | "os_user"
    provider?: string
    sandbox?: string
  }
  if (m.isolation) return m.isolation
  // Codex corre en su propio sandbox; que oculte la puerta humana no está medido.
  if (m.provider === "codex" && m.sandbox) return "provider"
  return null
}
