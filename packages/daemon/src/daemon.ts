/**
 * Cableado del daemon: store + bus + servidor IPC + adaptadores. Reconcilia
 * procesos y runs al arrancar (ADR-0003 §9) antes de aceptar clientes.
 */
import { existsSync, readFileSync, readlinkSync } from "node:fs"
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
import type { ProviderAdapter } from "./adapters/provider.js"
import { ApprovalGate } from "./approvals.js"
import { EventBus } from "./bus.js"
import { runCommand, runUnitOfWork, type UnitOfWork } from "./command.js"
import { canonicalJson, nowIso, sha256Hex } from "./ids.js"
import { type Handler, type Handlers, IpcServer, RpcFailure } from "./ipc/server.js"
import { createRunContext } from "./run-context.js"
import { openStore, type Store } from "./store/db.js"
import { Repo, type RunRow, type WorkItemRow } from "./store/repo.js"

export type DaemonOptions = {
  dbPath: string
  socketPath: string
  rootPath: string
  profile?: Partial<ClaudeProfile>
  adapterDeps?: ClaudeAdapterDeps
}

export class Daemon {
  readonly store: Store
  readonly repo: Repo
  readonly bus = new EventBus()
  readonly server: IpcServer
  /** Hoy el único proveedor; el daemon sólo lo usa por la interfaz `ProviderAdapter`. */
  readonly claude: ClaudeAdapter
  readonly toolGate: ApprovalGate
  readonly project: { workspace_id: string; project_id: string }
  readonly profile: ClaudeProfile
  readonly startedAt = Date.now()
  private readonly approvalWaiters = new Map<string, (d: "approved" | "denied") => void>()
  private lagMs = 0
  private lagTimer: ReturnType<typeof setInterval> | null = null

  readonly opts: DaemonOptions
  constructor(opts: DaemonOptions) {
    this.opts = opts
    this.store = openStore(opts.dbPath)
    this.repo = new Repo(this.store.db)
    this.project = this.repo.ensureDefaultProject(opts.rootPath)
    this.profile = { ...DEFAULT_PROFILE, cwd: opts.rootPath, ...opts.profile }
    this.claude = new ClaudeAdapter(opts.adapterDeps ?? {})
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

  start(): void {
    this.reconcile()
    this.server.start()
    let last = performance.now()
    this.lagTimer = setInterval(() => {
      const t = performance.now()
      this.lagMs = Math.max(0, t - last - 100)
      last = t
    }, 100)
  }

  stop(): void {
    if (this.lagTimer) clearInterval(this.lagTimer)
    this.server.stop()
    this.store.db.close()
  }

  /**
   * Runs vivos de un daemon anterior: su proceso ya no es nuestro. Se termina si
   * sigue, el run queda `interrupted` y su tarea sale de `running`.
   */
  reconcile(): { interrupted: string[]; killed: number[] } {
    const interrupted: string[] = []
    const killed: number[] = []
    for (const run of this.repo.liveRuns()) {
      const manifest = JSON.parse(run.context_manifest_json) as {
        provider_process?: { pid: number; cwd: string } | null
      }
      const p = manifest.provider_process
      if (p && existsSync(`/proc/${p.pid}`)) {
        try {
          // Sólo si sigue siendo el mismo proceso: mismo cwd y binario claude en argv.
          const cwd = readlinkSync(`/proc/${p.pid}/cwd`)
          const cmd = readFileSync(`/proc/${p.pid}/cmdline`, "utf8")
          if (cwd === p.cwd && cmd.includes("claude")) {
            process.kill(p.pid, "SIGTERM")
            killed.push(p.pid)
          }
        } catch {}
      }
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
      this.repo.appendEvent({
        project_id: run.project_id,
        run_id: run.id,
        source: "daemon",
        source_event_key: `reconcile:${run.id}:${t}`,
        fidelity: "full",
        adapter_version: "daemon/0",
        kind: "run.reconciled",
        occurred_at: null,
        payload_json: JSON.stringify({ killed_pid: p?.pid ?? null }),
      })
      interrupted.push(run.id)
      this.settleWorkItem(this.repo.getRun(run.id) as RunRow)
    }
    return { interrupted, killed }
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
    return { db: this.store.db, repo: this.repo, bus: this.bus }
  }

  /** Comando idempotente del protocolo: dominio, eventos y recibo en una transacción (K-04). */
  private mutation<P extends MutationMeta>(
    method: MethodName,
    fn: (params: P, uow: UnitOfWork) => unknown,
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
        (uow) => fn(p, uow),
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
      }),
      "work_items.create": this.mutation<Params<"work_items.create">>(
        "work_items.create",
        (p, uow) => {
          const w = repo.createWorkItem({
            project_id: project.project_id,
            title: p.title,
            kind: p.kind,
            ...(p.spec_markdown === undefined ? {} : { spec_markdown: p.spec_markdown }),
          })
          const view = repo.workItemView(w)
          uow.emit("work_item.created", null, view)
          return view
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
        const run = repo.createRun({
          project_id: project.project_id,
          work_item_id: w.id,
          purpose: p.purpose,
        })
        if (rule.to !== w.lifecycle) this.transition(uow, w, rule.to, "system", { runId: run.id })
        const view = repo.runView(run)
        uow.emit("run.created", run.id, view)
        const prompt = p.prompt !== undefined && p.prompt.length > 0 ? p.prompt : w.title
        // El run corre en segundo plano tras el commit y se observa por events.subscribe.
        uow.afterCommit(() => this.dispatchRun(run, prompt))
        return view
      }),
      "runs.cancel": this.mutation<Params<"runs.cancel">>("runs.cancel", (p, uow) => {
        const run = repo.getRun(p.run_id)
        if (!run) throw rpcError(ErrorCode.notFound, "run no existe")
        uow.afterCommit(() => this.claude.cancel(run.id, p.reason ?? null))
        return repo.runView(run)
      }),
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

  /**
   * Corre el run y, al terminar, asienta la tarea. Nunca deja una promesa
   * rechazada sin manejar: un fallo del adaptador termina el run en `failed`
   * con su evento en vez de dejarlo vivo (K-08).
   */
  private dispatchRun(run: RunRow, prompt: string): void {
    const provider: ProviderAdapter<ClaudeProfile> = this.claude
    const ctx = createRunContext({
      repo: this.repo,
      bus: this.bus,
      run,
      gate: this.toolGate,
      source: SOURCE,
      adapterVersion: provider.adapterVersion,
    })
    provider
      .execute(ctx, prompt, this.profile)
      .catch((e: unknown) => ctx.fail(e instanceof Error ? e.message : String(e)))
      .then((final) => this.settleWorkItem(final))
      .catch((e: unknown) => console.error("keel: no se pudo asentar el run", run.id, e))
  }

  /** Tras un run `execute` terminal, la tarea sale de `running` según cómo terminó. */
  private settleWorkItem(final: RunRow): void {
    if (final.purpose !== "execute") return
    const to: Lifecycle =
      final.status === "completed"
        ? "needs_review"
        : final.status === "cancelled"
          ? "planned"
          : "failed"
    runUnitOfWork(this.uowDeps(), this.systemScope(), (uow) => {
      const w = this.repo.getWorkItem(final.work_item_id)
      if (w?.lifecycle === "running")
        this.transition(uow, w, to, "system", { runId: final.id, reason: `run ${final.status}` })
    })
  }

  private systemScope() {
    return { projectId: this.project.project_id, actorId: "system:daemon" }
  }
}

type Params<M extends MethodName> = z.infer<(typeof Methods)[M]["params"]>

function rpcError(code: number, message: string, details?: unknown): RpcFailure {
  return new RpcFailure({
    code,
    message,
    retryable: false,
    ...(details === undefined ? {} : { details }),
  })
}
