/**
 * Cableado del daemon: store + bus + servidor IPC + adaptadores. Reconcilia
 * procesos y runs al arrancar (ADR-0003 §9) antes de aceptar clientes.
 */
import { existsSync, readFileSync, readlinkSync } from "node:fs"
import { ErrorCode, type MethodName } from "@keel/core"
import { ClaudeAdapter, type ClaudeProfile, DEFAULT_PROFILE } from "./adapters/claude.js"
import { EventBus } from "./bus.js"
import { canonicalJson, nowIso, sha256Hex } from "./ids.js"
import { type Handler, type Handlers, IpcServer, RpcFailure } from "./ipc/server.js"
import { openStore, type Store } from "./store/db.js"
import { Repo } from "./store/repo.js"

export type DaemonOptions = {
  dbPath: string
  socketPath: string
  rootPath: string
  profile?: Partial<ClaudeProfile>
  adapterDeps?: Partial<ConstructorParameters<typeof ClaudeAdapter>[0]>
}

export class Daemon {
  readonly store: Store
  readonly repo: Repo
  readonly bus = new EventBus()
  readonly server: IpcServer
  readonly claude: ClaudeAdapter
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
    this.claude = new ClaudeAdapter({
      repo: this.repo,
      bus: this.bus,
      waitApproval: (id, ms) => this.waitApproval(id, ms),
      ...opts.adapterDeps,
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

  /** Runs vivos de un daemon anterior: su proceso ya no es nuestro. Se termina si sigue y el run queda `interrupted`. */
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

  /** Mutación idempotente por recibo (ADR-0005 §3). */
  private mutation(
    method: MethodName,
    fn: (params: Record<string, unknown>, actorId: string) => Promise<unknown> | unknown,
  ): Handler {
    return async (params, ctx) => {
      const p = params as Record<string, unknown> & { request_id: string; idempotency_key: string }
      const hash = await sha256Hex(
        canonicalJson({ method, params: { ...p, request_id: undefined } }),
      )
      const receipt = this.repo.getReceipt(
        this.project.project_id,
        ctx.actor.actor_id,
        p.idempotency_key,
      )
      if (receipt) {
        if (receipt.request_hash !== hash)
          throw new RpcFailure({
            code: ErrorCode.idempotencyMismatch,
            message: "idempotency_key reutilizada con otra request",
            retryable: false,
          })
        return JSON.parse(receipt.result_json)
      }
      const result = await fn(p, ctx.actor.actor_id)
      this.repo.putReceipt(
        this.project.project_id,
        ctx.actor.actor_id,
        p.idempotency_key,
        hash,
        result,
      )
      return result
    }
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
      "work_items.create": this.mutation("work_items.create", (p) => {
        const w = repo.createWorkItem({
          project_id: project.project_id,
          title: String(p.title),
          kind: String(p.kind),
          ...(typeof p.spec_markdown === "string" ? { spec_markdown: p.spec_markdown } : {}),
        })
        this.emit("work_item.created", null, repo.workItemView(w))
        return repo.workItemView(w)
      }),
      "work_items.transition": this.mutation("work_items.transition", (p) => {
        const w = repo.getWorkItem(String(p.work_item_id))
        if (!w)
          throw new RpcFailure({
            code: ErrorCode.notFound,
            message: "work item no existe",
            retryable: false,
          })
        if (p.to === "done")
          throw new RpcFailure({
            code: ErrorCode.invalidTransition,
            message: "`done` requiere el cierre humano explícito (SDD 01 §3); aún no implementado",
            retryable: false,
          })
        const updated = repo.setLifecycle(w.id, p.to as typeof w.lifecycle)
        this.emit("work_item.updated", null, repo.workItemView(updated))
        return repo.workItemView(updated)
      }),
      "runs.start": this.mutation("runs.start", (p) => {
        const w = repo.getWorkItem(String(p.work_item_id))
        if (!w)
          throw new RpcFailure({
            code: ErrorCode.notFound,
            message: "work item no existe",
            retryable: false,
          })
        if (repo.liveRunFor(w.id))
          throw new RpcFailure({
            code: ErrorCode.conflict,
            message: "la tarea ya tiene un run vivo",
            retryable: false,
          })
        const run = repo.createRun({
          project_id: project.project_id,
          work_item_id: w.id,
          purpose: p.purpose as "plan" | "execute" | "triage_eval",
        })
        if (w.lifecycle === "triage" || w.lifecycle === "planned")
          repo.setLifecycle(w.id, "running")
        this.emit("run.created", run.id, repo.runView(run))
        const prompt = typeof p.prompt === "string" && p.prompt.length > 0 ? p.prompt : w.title
        // No se espera: el run corre en segundo plano y se observa por events.subscribe.
        void this.claude.execute(run, prompt, this.profile).then((final) => {
          const item = repo.getWorkItem(w.id)
          if (item && item.lifecycle === "running")
            repo.setLifecycle(
              w.id,
              final.status === "completed"
                ? "needs_review"
                : final.status === "cancelled"
                  ? "planned"
                  : "failed",
            )
          const refreshed = repo.getWorkItem(w.id)
          if (refreshed) this.emit("work_item.updated", run.id, repo.workItemView(refreshed))
        })
        return repo.runView(run)
      }),
      "runs.cancel": this.mutation("runs.cancel", (p) => {
        const run = repo.getRun(String(p.run_id))
        if (!run)
          throw new RpcFailure({
            code: ErrorCode.notFound,
            message: "run no existe",
            retryable: false,
          })
        this.claude.cancel(run.id, typeof p.reason === "string" ? p.reason : null)
        return repo.runView(repo.getRun(run.id) as typeof run)
      }),
      "approvals.resolve": this.mutation("approvals.resolve", (p, actorId) => {
        const a = repo.getApproval(String(p.approval_id))
        if (!a)
          throw new RpcFailure({
            code: ErrorCode.notFound,
            message: "aprobación no existe",
            retryable: false,
          })
        if (a.operation_hash !== p.operation_hash)
          throw new RpcFailure({
            code: ErrorCode.conflict,
            message: "el hash de la operación no coincide: la solicitud cambió",
            retryable: false,
          })
        if (a.state !== "pending")
          throw new RpcFailure({
            code: ErrorCode.invalidTransition,
            message: `la aprobación está ${a.state}`,
            retryable: false,
          })
        const decision =
          p.decision === "approve_once" || p.decision === "approve_session" ? "approved" : "denied"
        repo.setApproval(a.id, decision, actorId)
        this.approvalWaiters.get(a.id)?.(decision)
        return { approval_id: a.id, state: decision }
      }),
    }
  }

  private emit(kind: string, runId: string | null, payload: unknown): void {
    const e = this.repo.appendEvent({
      project_id: this.project.project_id,
      run_id: runId,
      source: "daemon",
      source_event_key: `${kind}:${nowIso()}:${Math.random()}`,
      fidelity: "full",
      adapter_version: "daemon/0",
      kind,
      occurred_at: null,
      payload_json: JSON.stringify(payload),
    })
    if (e)
      this.bus.publish({
        event_seq: e.event_seq,
        kind,
        project_id: e.project_id,
        run_id: runId,
        received_at: e.received_at,
        payload,
      })
  }
}
