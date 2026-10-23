/**
 * Cableado del daemon: store + bus + servidor IPC + adaptadores. Reconcilia
 * procesos y runs al arrancar (ADR-0003 §9) antes de aceptar clientes.
 */
import { existsSync } from "node:fs"
import { dirname, join } from "node:path"
import {
  allowedTransitions,
  checkTransition,
  ErrorCode,
  type Lifecycle,
  type MethodName,
  type Methods,
  type MutationMeta,
  RUN_START_RULES,
  type TransitionAuthority,
} from "@keel/core"
import type { z } from "zod"
import {
  ClaudeAdapter,
  type ClaudeAdapterDeps,
  type ClaudeProfile,
  DEFAULT_PROFILE,
  SOURCE,
} from "./adapters/claude.js"
import {
  CODEX_SOURCE,
  CodexAdapter,
  type CodexAdapterDeps,
  type CodexProfile,
  DEFAULT_CODEX_PROFILE,
} from "./adapters/codex.js"
import { AgentTokens } from "./agent-tokens.js"
import { ApprovalGate } from "./approvals.js"
import { EventBus } from "./bus.js"
import { runCommand, runUnitOfWork, type UnitOfWork } from "./command.js"
import { DirectFsDriver, defaultSnapshotsDir } from "./direct-fs.js"
import { canonicalJson, nowIso, sha256Hex } from "./ids.js"
import {
  type Handler,
  type HandlerContext,
  type Handlers,
  IpcServer,
  RpcFailure,
} from "./ipc/server.js"
import { checkRunStart, DEFAULT_LIMITS, type Limits, startOfLocalDay } from "./limits.js"
import { Outbox } from "./outbox.js"
import {
  defaultProcessTable,
  type ProcessTable,
  type RecordedProcess,
  sameProcess,
} from "./processes.js"
import { createRunContext } from "./run-context.js"
import { openStore, type Store } from "./store/db.js"
import { type NoteRow, Repo, type RunRow, type WorkItemRow } from "./store/repo.js"
import type { WorkspaceDriver } from "./workspace-driver.js"
import { defaultWorktreesDir, GitWorktreeDriver, releasesOnFinish } from "./workspaces.js"

export type DaemonOptions = {
  dbPath: string
  socketPath: string
  rootPath: string
  profile?: Partial<ClaudeProfile>
  adapterDeps?: ClaudeAdapterDeps
  /** Perfil de Codex (ADR-0008); el modo suscripción necesita `subscription_enabled`. */
  codex?: Partial<CodexProfile>
  codexDeps?: CodexAdapterDeps
  /** Raíz de los worktrees de runs; por defecto `$XDG_STATE_HOME/keel/worktrees`. */
  worktreesDir?: string
  /** Snapshots del modo sin VCS (ADR-0010); por defecto `$XDG_STATE_HOME/keel/snapshots`. */
  snapshotsDir?: string
  /** Tokens de un solo uso del puente MCP (ADR-0009); por defecto `run-tokens/` junto a la base. */
  tokensDir?: string
  /**
   * Cómo lanza el proveedor el puente `keel mcp`; `false` no lo inyecta. Por
   * defecto, este mismo runtime con `main.ts mcp`.
   */
  mcpBridge?: { command: string; args: string[] } | false
  /** Tabla de procesos para reconciliar; por defecto la de la plataforma (processes.ts). */
  processes?: ProcessTable
  /** Límites antes del spawn; por defecto `DEFAULT_LIMITS` (limits.ts). */
  limits?: Partial<Limits>
}

export type OrphanCheck = { runId: string; recorded: RecordedProcess }

export class Daemon {
  readonly store: Store
  readonly repo: Repo
  readonly bus = new EventBus()
  readonly server: IpcServer
  /** Hoy el único proveedor; el daemon sólo lo usa por la interfaz `ProviderAdapter`. */
  readonly claude: ClaudeAdapter
  /** Segundo proveedor (ADR-0008): se elige con `runs.start` `profile: "codex"`. */
  readonly codex: CodexAdapter
  readonly codexProfile: CodexProfile
  readonly toolGate: ApprovalGate
  /** Driver de proyectos con git (worktree por run). */
  readonly workspaces: GitWorktreeDriver
  /** Driver del modo sin VCS, confirmado por el humano (ADR-0010). */
  readonly directFs: DirectFsDriver
  readonly agentTokens: AgentTokens
  readonly project: { workspace_id: string; project_id: string }
  readonly profile: ClaudeProfile
  readonly startedAt = Date.now()
  private readonly approvalWaiters = new Map<string, (d: "approved" | "denied") => void>()
  readonly outbox: Outbox
  readonly processes: ProcessTable
  readonly limits: Limits
  private orphanSweep: Promise<void> = Promise.resolve()
  /** Runs que este proceso ya está despachando: una entrega repetida del outbox no los duplica. */
  private readonly dispatching = new Set<string>()
  /** Trabajo en segundo plano (runs, liberaciones); `idle()` espera a que termine. */
  private readonly background = new Set<Promise<unknown>>()
  private lagMs = 0
  private lagTimer: ReturnType<typeof setInterval> | null = null

  readonly opts: DaemonOptions
  constructor(opts: DaemonOptions) {
    this.opts = opts
    this.store = openStore(opts.dbPath)
    this.repo = new Repo(this.store.db)
    this.project = this.repo.ensureDefaultProject(opts.rootPath)
    this.profile = { ...DEFAULT_PROFILE, cwd: opts.rootPath, ...opts.profile }
    this.processes = opts.processes ?? defaultProcessTable()
    this.limits = { ...DEFAULT_LIMITS, ...opts.limits }
    this.claude = new ClaudeAdapter({ processes: this.processes, ...opts.adapterDeps })
    this.codexProfile = { ...DEFAULT_CODEX_PROFILE, cwd: opts.rootPath, ...opts.codex }
    this.codex = new CodexAdapter(
      { processes: this.processes, ...opts.codexDeps },
      this.codexProfile.transport,
    )
    this.outbox = new Outbox(this.repo)
    this.outbox.on(RUN_DISPATCH, (m) => this.onRunDispatch(m.payload as RunDispatch))
    this.outbox.on(WORKTREE_RELEASE, (m) =>
      this.captureAndRelease((m.payload as { run_id: string }).run_id),
    )
    this.outbox.on(SNAPSHOT_RESTORE, (m) => this.onSnapshotRestore(m.payload as SnapshotRestore))
    this.workspaces = new GitWorktreeDriver({
      repo: this.repo,
      rootPath: opts.rootPath,
      worktreesDir: opts.worktreesDir ?? defaultWorktreesDir(),
    })
    // Junto a la base: el directorio privado del daemon (`~/.keel`, 0700).
    this.agentTokens = new AgentTokens(opts.tokensDir ?? join(dirname(opts.dbPath), "run-tokens"))
    this.directFs = new DirectFsDriver({
      repo: this.repo,
      rootPath: opts.rootPath,
      snapshotsDir: opts.snapshotsDir ?? defaultSnapshotsDir(),
    })
    this.toolGate = new ApprovalGate({
      repo: this.repo,
      waitApproval: (id, ms) => this.waitApproval(id, ms),
      timeoutMs: this.profile.approval_timeout_ms,
    })
    this.server = new IpcServer({
      socketPath: opts.socketPath,
      repo: this.repo,
      bus: this.bus,
      handlers: this.handlers(),
    })
  }

  /** Reconcilia (una vez), abre el socket y devuelve lo reconciliado. */
  start(): { interrupted: string[]; orphans: OrphanCheck[] } {
    const reconciled = this.reconcile()
    // Lo que quedó pendiente antes de una caída: despachos y liberaciones (DoD Fase 0).
    this.track(this.outbox.drain())
    this.server.start()
    let last = performance.now()
    this.lagTimer = setInterval(() => {
      const t = performance.now()
      this.lagMs = Math.max(0, t - last - 100)
      last = t
    }, 100)
    return reconciled
  }

  /** Espera a que terminen los runs y liberaciones en curso (tests, apagado ordenado). */
  async idle(): Promise<void> {
    while (this.background.size > 0) await Promise.allSettled([...this.background])
  }

  private track(p: Promise<unknown>): void {
    const tracked = p.catch((e: unknown) => console.error("keel: tarea en segundo plano falló", e))
    this.background.add(tracked)
    void tracked.finally(() => this.background.delete(tracked))
  }

  stop(): void {
    if (this.lagTimer) clearInterval(this.lagTimer)
    this.server.stop()
    this.store.db.close()
  }

  /**
   * Runs vivos de un daemon anterior: su proceso ya no es nuestro. Se termina si
   * sigue, el run queda `interrupted`, su tarea sale de `running` y su worktree
   * se encola para liberar. Un run `queued` con el despacho pendiente en el
   * outbox no se toca: nunca arrancó y se despachará al drenar.
   */
  reconcile(): { interrupted: string[]; orphans: OrphanCheck[] } {
    const interrupted: string[] = []
    const orphans: OrphanCheck[] = []
    for (const run of this.repo.liveRuns()) {
      // Nunca arrancó: su despacho sigue en el outbox y se entrega al drenar.
      if (run.status === "queued" && this.repo.hasPendingOutbox(`${RUN_DISPATCH}:${run.id}`))
        continue
      const manifest = JSON.parse(run.context_manifest_json) as {
        provider_process?: RecordedProcess | null
      }
      const recorded = manifest.provider_process ?? null
      const t = nowIso()
      this.repo.updateRun(run.id, { status: "interrupted", end_reason: "interrupted", ended_at: t })
      for (const a of this.repo.agentsOfRun(run.id))
        if (["running", "waiting_human", "pending"].includes(a.state))
          this.repo.setAgentState(a.id, "interrupted", t, "daemon reiniciado")
      for (const tc of this.repo.openToolCalls(run.id))
        this.repo.closeToolCall({
          run_id: run.id,
          tool_use_id: tc.tool_use_id,
          state: "interrupted",
          ended_at: t,
          duration_ms: null,
          output_json: null,
          error_message: "daemon reiniciado",
        })
      this.emitSystem("run.reconciled", run.id, {
        provider_process: recorded,
        process_table: this.processes.kind,
      })
      interrupted.push(run.id)
      if (recorded) orphans.push({ runId: run.id, recorded })
      this.settleWorkItem(this.repo.getRun(run.id) as RunRow, "reconcile")
    }
    // La comprobación de procesos es asíncrona (CIM en Windows). Las liberaciones de
    // origen `reconcile` la esperan: no se borra un worktree con un huérfano escribiendo.
    this.orphanSweep = this.sweepOrphans(orphans)
    this.track(this.orphanSweep)
    return { interrupted, orphans }
  }

  /**
   * Termina el proceso de proveedor de un run interrumpido sólo si sigue siendo
   * el mismo (pid + arranque + ejecutable, processes.ts). Nunca por nombre.
   */
  private async sweepOrphans(orphans: OrphanCheck[]): Promise<void> {
    for (const { runId, recorded } of orphans) {
      const current = await this.processes.get(recorded.pid)
      const same = current !== null && sameProcess(recorded, current)
      const terminated = same && this.processes.terminate(recorded.pid)
      this.emitSystem("run.orphan_checked", runId, {
        pid: recorded.pid,
        alive: current !== null,
        same_process: same,
        terminated,
        process_table: this.processes.kind,
      })
    }
  }

  private waitApproval(id: string, ms: number): Promise<"approved" | "denied" | "expired"> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.approvalWaiters.delete(id)
        resolve("expired")
      }, ms)
      this.approvalWaiters.set(id, (d) => {
        clearTimeout(timer)
        this.approvalWaiters.delete(id)
        resolve(d)
      })
    })
  }

  private uowDeps() {
    const outbox = {
      drain: () => {
        const p = this.outbox.drain()
        this.track(p)
        return p
      },
    }
    return { db: this.store.db, repo: this.repo, bus: this.bus, outbox }
  }

  /** Comando idempotente del protocolo: dominio, eventos y recibo en una transacción (K-04). */
  private mutation<P extends MutationMeta>(
    method: MethodName,
    fn: (params: P, uow: UnitOfWork, ctx: HandlerContext) => unknown,
  ): Handler {
    return async (params, ctx) => {
      const p = params as P
      const requestHash = await sha256Hex(
        canonicalJson({ method, params: { ...p, request_id: undefined } }),
      )
      return runCommand(
        this.uowDeps(),
        {
          projectId: this.project.project_id,
          actorId: ctx.actor.actor_id,
          idempotencyKey: p.idempotency_key,
          requestHash,
        },
        (uow) => fn(p, uow, ctx),
      )
    }
  }

  private requireWorkItem(id: string): WorkItemRow {
    const w = this.repo.getWorkItem(id)
    if (!w) throw rpcError(ErrorCode.notFound, "work item no existe")
    return w
  }

  /**
   * Único camino para cambiar `work_items.lifecycle`: valida la arista con
   * @keel/core, aplica compare-and-set y emite `work_item.updated` (K-07).
   */
  private transition(
    uow: UnitOfWork,
    w: WorkItemRow,
    to: Lifecycle,
    by: TransitionAuthority,
    opts: { expectedRevision?: number; runId?: string | null; reason?: string } = {},
  ): WorkItemRow {
    if (opts.expectedRevision !== undefined && opts.expectedRevision !== w.revision)
      throw rpcError(ErrorCode.conflict, "la tarea cambió desde la revisión esperada", {
        expected_revision: opts.expectedRevision,
        current_revision: w.revision,
      })
    const check = checkTransition(w.lifecycle, to, by)
    if (!check.ok)
      throw rpcError(
        ErrorCode.invalidTransition,
        check.reason === "wrong_authority"
          ? `${w.lifecycle} → ${to} requiere autoridad ${check.edge?.by}`
          : `${w.lifecycle} → ${to} no es una transición del lifecycle`,
        { from: w.lifecycle, to, allowed: allowedTransitions(w.lifecycle, by) },
      )
    const updated = this.repo.setLifecycle(w.id, to, {
      from: w.lifecycle,
      ...(opts.expectedRevision === undefined ? {} : { revision: opts.expectedRevision }),
    })
    if (!updated)
      throw rpcError(ErrorCode.conflict, "otro escritor cambió la tarea; vuelve a leerla", {
        current_revision: this.repo.getWorkItem(w.id)?.revision ?? null,
      })
    uow.emit("work_item.updated", opts.runId ?? null, {
      ...this.repo.workItemView(updated),
      transition: { from: w.lifecycle, to, by, reason: opts.reason ?? null },
    })
    // El worktree de un run completed se conserva para la revisión; salir de ella lo libera.
    if (w.lifecycle === "needs_review")
      for (const runId of this.repo.runsWithWorkspaces(w.id))
        this.enqueueRelease(uow, runId, "review_exit")
    return updated
  }

  private handlers(): Handlers {
    const repo = this.repo
    const project = this.project
    return {
      "daemon.health": () => ({
        version: "0.0.0",
        event_loop_lag_ms: Math.round(this.lagMs),
        rss_bytes: process.memoryUsage().rss,
        ingest_queue: 0,
        wal_bytes: existsSync(`${this.opts.dbPath}-wal`)
          ? Bun.file(`${this.opts.dbPath}-wal`).size
          : 0,
        limits: this.limits,
        spent_today_micro_usd: repo.spentSince(project.project_id, startOfLocalDay()),
      }),
      "work_items.create": this.mutation<Params<"work_items.create">>(
        "work_items.create",
        (p, uow, ctx) => {
          // Lo que crea un agente nace en triage con source = 'agent' (ADR-0009 §5).
          const projectId = this.scopeOf(ctx, p.project_id)
          const w = repo.createWorkItem({
            project_id: projectId,
            title: p.title,
            kind: p.kind,
            source: ctx.actor.kind === "agent" ? "agent" : "human",
            ...(p.spec_markdown === undefined ? {} : { spec_markdown: p.spec_markdown }),
          })
          const view = repo.workItemView(w)
          uow.emit("work_item.created", agentRun(ctx), { ...view, actor: actorOf(ctx) })
          return view
        },
      ),
      "session.bind_agent": (params, ctx) => {
        const p = params as Params<"session.bind_agent">
        if (ctx.client.actor?.kind === "agent")
          throw rpcError(ErrorCode.conflict, "la conexión ya está vinculada a un run")
        const binding = this.agentTokens.consume(p.token)
        if (!binding) throw rpcError(ErrorCode.unauthorized, "token inválido, ya usado o caducado")
        const run = repo.getRun(binding.run_id)
        if (!run || !ACTIVE_RUN_STATUSES.includes(run.status))
          throw rpcError(ErrorCode.unauthorized, "el run del token ya terminó")
        const actor = { actor_id: `agent:${binding.run_id}`, kind: "agent" as const, ...binding }
        ctx.client.actor = actor
        this.emitSystem("session.agent_bound", binding.run_id, {
          actor_id: actor.actor_id,
          client_id: ctx.client.id,
        })
        return { actor_id: actor.actor_id, ...binding }
      },
      "work_items.list": (params, ctx) => {
        const p = params as Params<"work_items.list">
        const projectId = this.scopeOf(ctx, p.project_id)
        const items = repo
          .listWorkItems(projectId)
          .filter((w) => !p.lifecycle || p.lifecycle.includes(w.lifecycle))
          .slice(0, p.limit ?? 200)
          .map((w) => repo.workItemView(w))
        return { items }
      },
      "work_items.get": (params, ctx) => {
        const p = params as Params<"work_items.get">
        const w = this.workItemIn(ctx, p.work_item_id)
        return {
          item: repo.workItemView(w),
          spec_markdown: repo.workItemSpec(w.id),
          notes: repo.listNotes(w.id).map(noteView),
        }
      },
      "notes.add": this.mutation<Params<"notes.add">>("notes.add", (p, uow, ctx) => {
        const w = this.workItemIn(ctx, p.work_item_id)
        // Un agente sólo escribe en la tarea de su run (ADR-0009 §5).
        if (ctx.actor.kind === "agent" && w.id !== ctx.actor.work_item_id)
          throw rpcError(ErrorCode.unauthorized, "un agente sólo añade notas a la tarea de su run")
        const note = noteView(
          repo.addNote({
            work_item_id: w.id,
            author: ctx.actor.actor_id,
            content_markdown: p.content_markdown,
          }),
        )
        uow.emit("note.added", agentRun(ctx), { ...note, actor: actorOf(ctx) })
        return note
      }),
      "handoffs.request": this.mutation<Params<"handoffs.request">>(
        "handoffs.request",
        (p, uow, ctx) => {
          const actor = ctx.actor
          if (actor.kind !== "agent")
            throw rpcError(
              ErrorCode.unauthorized,
              "handoffs.request es para agentes; un humano crea la tarea directamente",
            )
          this.scopeOf(ctx)
          const origin = this.workItemIn(ctx, actor.work_item_id)
          const created = repo.createWorkItem({
            project_id: actor.project_id,
            title: p.title,
            kind: p.kind ?? "chore",
            source: "agent",
            spec_markdown: `${p.summary_markdown}\n\n---\nHandoff desde ${origin.display_id} (run ${actor.run_id}).`,
          })
          const workItem = repo.workItemView(created)
          const note = noteView(
            repo.addNote({
              work_item_id: origin.id,
              author: actor.actor_id,
              content_markdown: `Handoff pedido: ${created.display_id} · ${p.title}\n\n${p.summary_markdown}`,
            }),
          )
          uow.emit("work_item.created", actor.run_id, { ...workItem, actor: actorOf(ctx) })
          uow.emit("handoff.requested", actor.run_id, {
            from_work_item_id: origin.id,
            to_work_item_id: created.id,
            note_id: note.id,
            actor: actorOf(ctx),
          })
          return { note, work_item: workItem }
        },
      ),
      "work_items.transition": this.mutation<Params<"work_items.transition">>(
        "work_items.transition",
        (p, uow) => {
          const w = this.requireWorkItem(p.work_item_id)
          if (p.to === "done")
            throw rpcError(
              ErrorCode.invalidTransition,
              "`done` requiere el cierre humano explícito (SDD 01 §3); aún no implementado",
            )
          const updated = this.transition(uow, w, p.to, "human", {
            ...(p.expected_revision === undefined ? {} : { expectedRevision: p.expected_revision }),
            ...(p.reason === undefined ? {} : { reason: p.reason }),
          })
          return repo.workItemView(updated)
        },
      ),
      "runs.start": this.mutation<Params<"runs.start">>("runs.start", (p, uow) => {
        const w = this.requireWorkItem(p.work_item_id)
        if (p.expected_revision !== undefined && p.expected_revision !== w.revision)
          throw rpcError(ErrorCode.conflict, "la tarea cambió desde la revisión esperada", {
            expected_revision: p.expected_revision,
            current_revision: w.revision,
          })
        if (repo.liveRunFor(w.id))
          throw rpcError(ErrorCode.conflict, "la tarea ya tiene un run vivo")
        // K-02: elegibilidad antes de crear o despachar nada.
        const rule = RUN_START_RULES[p.purpose]
        if (w.lifecycle !== rule.from)
          throw rpcError(
            ErrorCode.invalidTransition,
            `un run ${p.purpose} arranca desde ${rule.from}; la tarea está ${w.lifecycle}`,
            { lifecycle: w.lifecycle, purpose: p.purpose, required: rule.from },
          )
        const blocks = repo.openBlocks(w.id)
        if (blocks.length > 0)
          throw rpcError(ErrorCode.invalidTransition, "la tarea tiene bloqueos abiertos", {
            blocks,
          })
        // ADR-0002 regla 3: concurrencia y presupuesto antes de crear nada.
        const lim = checkRunStart(repo, this.limits, w)
        if (!lim.ok)
          throw rpcError(
            ErrorCode.limitExceeded,
            lim.message,
            { limit: lim.limit, ...lim.details },
            lim.retryable,
          )
        const provider = p.profile ?? "claude"
        if (provider !== "claude" && provider !== "codex")
          throw rpcError(
            ErrorCode.invalidParams,
            `perfil desconocido: ${provider} (claude | codex)`,
          )
        const run = repo.createRun({
          project_id: project.project_id,
          work_item_id: w.id,
          purpose: p.purpose,
          // Va en el manifest para que el despacho, aunque llegue tras una caída, use el
          // mismo tope y el mismo proveedor.
          manifest: { budget_micro_usd: lim.runBudgetMicroUsd, provider },
        })
        if (rule.to !== w.lifecycle) this.transition(uow, w, rule.to, "system", { runId: run.id })
        const view = repo.runView(run)
        uow.emit("run.created", run.id, view)
        const prompt = p.prompt !== undefined && p.prompt.length > 0 ? p.prompt : w.title
        // Despacho durable: si el daemon cae tras el commit, se entrega al arrancar.
        uow.enqueue(RUN_DISPATCH, run.id, `${RUN_DISPATCH}:${run.id}`, {
          run_id: run.id,
          prompt,
        } satisfies RunDispatch)
        return view
      }),
      "runs.cancel": this.mutation<Params<"runs.cancel">>("runs.cancel", (p, uow) => {
        const run = repo.getRun(p.run_id)
        if (!run) throw rpcError(ErrorCode.notFound, "run no existe")
        if (run.status === "queued") {
          // Aún sin proceso del proveedor: la cancelación se registra en esta misma
          // transacción y sobrevive a una caída. El despacho la verá y no arrancará.
          const t = nowIso()
          const cancelled = repo.updateRun(run.id, {
            status: "cancelled",
            end_reason: "cancelled",
            started_at: t,
            ended_at: t,
          })
          uow.emit("run.cancelled", run.id, { message: p.reason ?? "cancelado antes de arrancar" })
          uow.emit("run.updated", run.id, repo.runView(cancelled))
          this.settleInTransaction(uow, cancelled, "cancel")
          return repo.runView(cancelled)
        }
        uow.afterCommit(
          () =>
            this.claude.cancel(run.id, p.reason ?? null) ||
            this.codex.cancel(run.id, p.reason ?? null),
        )
        return repo.runView(run)
      }),
      "projects.set_vcs": this.mutation<Params<"projects.set_vcs">>(
        "projects.set_vcs",
        (p, uow, ctx) => {
          // Pasar a sin VCS pierde el aislamiento: lo confirma un humano (ADR-0010 §2).
          requireHuman(ctx, "cambiar el control de versiones del proyecto")
          const projectId = p.project_id ?? project.project_id
          const vcs = repo.setProjectVcs(projectId, p.vcs, uow.actorId)
          const view = { project_id: projectId, ...vcs }
          uow.emit("project.vcs_changed", null, view)
          return view
        },
      ),
      "snapshots.restore": this.mutation<Params<"snapshots.restore">>(
        "snapshots.restore",
        (p, uow, ctx) => {
          requireHuman(ctx, "restaurar un snapshot")
          const snap = repo.runSnapshot(p.run_id)
          if (!snap) throw rpcError(ErrorCode.notFound, "el run no tiene snapshot del modo sin VCS")
          if (!snap.released_at)
            throw rpcError(
              ErrorCode.conflict,
              "el run sigue usando la carpeta; se restaura cuando termine",
            )
          const holder = repo.activeSnapshotForRoot(snap.root_path)
          if (holder)
            throw rpcError(ErrorCode.conflict, `la carpeta la está usando el run ${holder.run_id}`)
          const payload: SnapshotRestore = { run_id: p.run_id, delete_new: p.delete_new ?? false }
          uow.enqueue(
            SNAPSHOT_RESTORE,
            p.run_id,
            `${SNAPSHOT_RESTORE}:${p.idempotency_key}`,
            payload,
          )
          return { run_id: p.run_id, queued: true }
        },
      ),
      "approvals.resolve": this.mutation<Params<"approvals.resolve">>(
        "approvals.resolve",
        (p, uow) => {
          const a = repo.getApproval(p.approval_id)
          if (!a) throw rpcError(ErrorCode.notFound, "aprobación no existe")
          if (a.operation_hash !== p.operation_hash)
            throw rpcError(
              ErrorCode.conflict,
              "el hash de la operación no coincide: la solicitud cambió",
            )
          if (a.state !== "pending")
            throw rpcError(ErrorCode.invalidTransition, `la aprobación está ${a.state}`)
          const decision =
            p.decision === "approve_once" || p.decision === "approve_session"
              ? "approved"
              : "denied"
          repo.setApproval(a.id, decision, uow.actorId)
          uow.afterCommit(() => this.approvalWaiters.get(a.id)?.(decision))
          return { approval_id: a.id, state: decision }
        },
      ),
    }
  }

  /** Handler del outbox: idempotente. Sólo despacha un run que sigue `queued` y no está ya en marcha. */
  private onRunDispatch(m: RunDispatch): void {
    const run = this.repo.getRun(m.run_id)
    if (run?.status !== "queued" || this.dispatching.has(run.id)) return
    const item = this.repo.getWorkItem(run.work_item_id)
    if (!item) return
    this.dispatching.add(run.id)
    this.track(this.dispatchRun(run, item, m.prompt).finally(() => this.dispatching.delete(run.id)))
  }

  /**
   * Prepara el espacio del run, lo corre y asienta la tarea; la liberación del
   * worktree va por el outbox. Nunca rechaza: un fallo del adaptador o de git
   * termina el run en `failed` con su evento (K-08).
   */
  private async dispatchRun(run: RunRow, item: WorkItemRow, prompt: string): Promise<void> {
    const manifest = JSON.parse(run.context_manifest_json) as {
      budget_micro_usd?: number
      provider?: string
    }
    const useCodex = manifest.provider === "codex"
    const provider = useCodex ? this.codex : this.claude
    const ctx = createRunContext({
      repo: this.repo,
      bus: this.bus,
      run,
      gate: this.toolGate,
      source: useCodex ? CODEX_SOURCE : SOURCE,
      adapterVersion: provider.adapterVersion,
    })
    let final: RunRow
    try {
      const driver = this.driverFor(run.project_id)
      const ws = await driver.provision(run, item)
      const current = this.repo.getRun(run.id) ?? run
      if (!ws.ok) final = ctx.fail(ws.message, "run.start_failed")
      else {
        for (const e of ws.events) this.emitSystem(e.kind, run.id, e.payload)
        if (run.purpose === "execute")
          this.emitSystem("workspace.prepared", run.id, {
            kind: driver.kind,
            guarantees: driver.guarantees,
            cwd: ws.cwd,
          })
        // Cancelado mientras se preparaba: no se lanza el proveedor. Sin await entre esta
        // lectura y execute; el adaptador pasa a `initializing` en su parte síncrona.
        if (current.status !== "queued") final = current
        else {
          const budget = (
            JSON.parse(current.context_manifest_json) as { budget_micro_usd?: number }
          ).budget_micro_usd
          const mcp_servers = this.keelMcpServer(current)
          // ADR-0008 §7: el presupuesto en USD no aplica a Codex (sólo reporta tokens).
          final = useCodex
            ? await this.codex.execute(ctx, prompt, {
                ...this.codexProfile,
                cwd: ws.cwd,
                mcp_servers,
              })
            : await this.claude.execute(ctx, prompt, {
                ...this.profile,
                cwd: ws.cwd,
                max_budget_usd: budget === undefined ? null : budget / 1_000_000,
                mcp_servers,
              })
        }
      }
    } catch (e) {
      final = ctx.fail(e instanceof Error ? e.message : String(e))
    }
    // La tarea refleja el final sin esperar a git. Si el final libera, la liberación
    // (que captura antes) va encolada; si no, se capturan los cambios para la revisión.
    // La capacidad del agente caduca con el run (ADR-0009 §3).
    this.agentTokens.revokeRun(run.id)
    this.settleWorkItem(final, "dispatch")
    if (!releasesOnFinish(final.status)) await this.captureChanges(run.id)
  }

  /**
   * El puente `keel mcp` del run: el proveedor lo lanza con la ruta del token de
   * un solo uso, nunca con su valor (ADR-0009 §3).
   */
  private keelMcpServer(run: RunRow): ClaudeProfile["mcp_servers"] {
    const bridge = this.opts.mcpBridge ?? defaultBridge()
    if (bridge === false) return {}
    const { file } = this.agentTokens.issue({
      run_id: run.id,
      project_id: run.project_id,
      work_item_id: run.work_item_id,
    })
    return {
      keel: {
        command: bridge.command,
        args: bridge.args,
        env: { KEEL_RUN_TOKEN_FILE: file, KEEL_SOCKET: this.server.path },
      },
    }
  }

  /**
   * Para un actor `agent`: su run debe seguir activo (si no, su capacidad
   * caducó) y el proyecto pedido debe ser el suyo. Devuelve el proyecto en el
   * que opera la conexión.
   */
  private scopeOf(ctx: HandlerContext, projectId?: string): string {
    const actor = ctx.actor
    if (actor.kind !== "agent") return projectId ?? this.project.project_id
    const run = this.repo.getRun(actor.run_id)
    if (!run || !ACTIVE_RUN_STATUSES.includes(run.status))
      throw rpcError(ErrorCode.unauthorized, "el run del agente terminó; su capacidad caducó")
    if (projectId !== undefined && projectId !== actor.project_id)
      throw rpcError(ErrorCode.unauthorized, "el agente sólo opera en el proyecto de su run")
    return actor.project_id
  }

  /** La tarea existe y es del proyecto de la conexión; si no, para un agente es como si no existiera. */
  private workItemIn(ctx: HandlerContext, id: string): WorkItemRow {
    const projectId = this.scopeOf(ctx)
    const w = this.repo.getWorkItem(id)
    if (!w || w.project_id !== projectId) throw rpcError(ErrorCode.notFound, "work item no existe")
    return w
  }

  /** El driver de un run `execute` sale del proyecto; cada driver valida lo suyo. */
  private driverFor(projectId: string): WorkspaceDriver {
    return this.repo.getProjectVcs(projectId).vcs === "none" ? this.directFs : this.workspaces
  }

  /** Todos los drivers: cada uno sólo actúa sobre lo que registró para el run. */
  private get drivers(): WorkspaceDriver[] {
    return [this.workspaces, this.directFs]
  }

  private async captureChanges(runId: string): Promise<void> {
    for (const driver of this.drivers)
      for (const e of await driver.capture(runId)) this.emitSystem(e.kind, runId, e.payload)
  }

  /** Handler del outbox: captura los cambios finales y libera, rescatando antes. Idempotente. */
  private async captureAndRelease(runId: string): Promise<void> {
    await this.orphanSweep
    await this.captureChanges(runId)
    for (const driver of this.drivers)
      for (const e of await driver.release(runId)) this.emitSystem(e.kind, runId, e.payload)
  }

  /** Handler del outbox: restaura el snapshot del modo sin VCS. Restaurar es idempotente. */
  private async onSnapshotRestore(p: SnapshotRestore): Promise<void> {
    try {
      const result = await this.directFs.restore(p.run_id, { deleteNew: p.delete_new })
      this.emitSystem("workspace.restored", p.run_id, result)
    } catch (e) {
      this.emitSystem("workspace.restore_failed", p.run_id, {
        message: e instanceof Error ? e.message : String(e),
      })
    }
  }

  /**
   * La clave lleva el origen del pedido: cada pedido real de liberación es un
   * mensaje propio (una cancelación durante la preparación pide liberar antes de
   * que exista el worktree, y el final del despacho lo pide otra vez); las
   * entregas repetidas de un mismo pedido sí se deduplican. Liberar es idempotente.
   */
  private enqueueRelease(uow: UnitOfWork, runId: string, origin: ReleaseOrigin): void {
    uow.enqueue(WORKTREE_RELEASE, runId, `${WORKTREE_RELEASE}:${runId}:${origin}`, {
      run_id: runId,
      origin,
    })
  }

  private emitSystem(kind: string, runId: string, payload: unknown): void {
    runUnitOfWork(this.uowDeps(), this.systemScope(), (uow) => uow.emit(kind, runId, payload))
  }

  /** Tras un run terminal, la tarea sale de `running` y, si el final lo pide, se encola la liberación. */
  private settleWorkItem(final: RunRow, origin: ReleaseOrigin): void {
    runUnitOfWork(this.uowDeps(), this.systemScope(), (uow) =>
      this.settleInTransaction(uow, final, origin),
    )
  }

  private settleInTransaction(uow: UnitOfWork, final: RunRow, origin: ReleaseOrigin): void {
    if (final.purpose !== "execute") return
    const to: Lifecycle =
      final.status === "completed"
        ? "needs_review"
        : final.status === "cancelled"
          ? "planned"
          : "failed"
    const w = this.repo.getWorkItem(final.work_item_id)
    if (w?.lifecycle === "running")
      this.transition(uow, w, to, "system", { runId: final.id, reason: `run ${final.status}` })
    if (releasesOnFinish(final.status)) this.enqueueRelease(uow, final.id, origin)
  }

  private systemScope() {
    return { projectId: this.project.project_id, actorId: "system:daemon" }
  }
}

/** Tipos de mensaje del outbox que consume el daemon. */
export const RUN_DISPATCH = "run_dispatch"
export const WORKTREE_RELEASE = "worktree_release"
export const SNAPSHOT_RESTORE = "snapshot_restore"
type SnapshotRestore = { run_id: string; delete_new: boolean }
type RunDispatch = { run_id: string; prompt: string }
type ReleaseOrigin = "dispatch" | "cancel" | "reconcile" | "review_exit"

type Params<M extends MethodName> = z.infer<(typeof Methods)[M]["params"]>

function rpcError(code: number, message: string, details?: unknown, retryable = false): RpcFailure {
  return new RpcFailure({
    code,
    message,
    retryable,
    ...(details === undefined ? {} : { details }),
  })
}

function requireHuman(ctx: HandlerContext, what: string): void {
  if (ctx.actor.kind !== "human")
    throw new RpcFailure({
      code: ErrorCode.unauthorized,
      message: `${what} lo decide un humano`,
      retryable: false,
    })
}

/** Estados de un run en los que su agente conserva la capacidad. */
const ACTIVE_RUN_STATUSES: readonly string[] = [
  "queued",
  "initializing",
  "running",
  "paused",
  "waiting_human",
]

/** Quién hizo una mutación, para el evento (ADR-0009 §7). */
function actorOf(ctx: HandlerContext): { id: string; kind: string } {
  return { id: ctx.actor.actor_id, kind: ctx.actor.kind }
}

/** El run del agente, para correlacionar el evento; null para humanos. */
function agentRun(ctx: HandlerContext): string | null {
  return ctx.actor.kind === "agent" ? ctx.actor.run_id : null
}

function noteView(n: NoteRow) {
  return {
    id: n.id,
    work_item_id: n.work_item_id,
    author: n.author,
    content_markdown: n.content_markdown,
    created_at: n.created_at,
  }
}

/** El puente por defecto: este mismo runtime ejecutando la entrada del daemon con `mcp`. */
function defaultBridge(): { command: string; args: string[] } {
  const main = new URL(import.meta.url.endsWith(".ts") ? "./main.ts" : "./main.js", import.meta.url)
  return { command: process.execPath, args: [Bun.fileURLToPath(main), "mcp"] }
}
