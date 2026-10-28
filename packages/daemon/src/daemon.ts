/**
 * Cableado del daemon: store + bus + servidor IPC + adaptadores. Reconcilia
 * procesos y runs al arrancar (ADR-0003 §9) antes de aceptar clientes.
 */
import { createHash, randomBytes } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path"
import {
  AGENT_SCOPES,
  type AgentScope,
  allowedTransitions,
  canReturn,
  checkTransition,
  contractSection,
  describePattern,
  type Effort,
  ErrorCode,
  type GitPlan,
  GitPlanSchema,
  isReadOnlyStage,
  type Lifecycle,
  lifecycleForStage,
  type MethodName,
  type Methods,
  type MutationMeta,
  matchesPattern,
  type PermissionMode,
  type PermissionPattern,
  type PlannedTask,
  type ProjectProfile,
  ProjectProfileSchema,
  parsePattern,
  parseTasks,
  patternFor,
  purposeForStage,
  qaVerdict,
  RUN_START_RULES,
  redact,
  type SettingsView,
  type Stage,
  stageMove,
  storyFor,
  type TaskDocKind,
  type TaskFlowView,
  type TransitionAuthority,
  type VerifyResult,
  validateDoc,
  verifyDelta,
  withinFrontier,
} from "@keel/core"
import {
  changedFiles,
  currentBranch,
  GitError,
  git as gitExec,
  headSha,
  numstat,
  openRepo,
  type RepoStatus,
  repoStatus,
  unifiedDiff,
} from "@keel/git"
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
import type { LiveChange } from "./adapters/provider.js"
import { AgentTokens } from "./agent-tokens.js"
import { ApprovalGate, type ApprovalResolution, QUESTION_TOOLS } from "./approvals.js"
import { ArtifactStore, parseArtifactRef } from "./artifacts.js"
import { checkBase, pullBase } from "./base-sync.js"
import { EventBus } from "./bus.js"
import { runCommand, runUnitOfWork, type UnitOfWork } from "./command.js"
import { projectContext, searchContext } from "./context.js"
import { DirectFsDriver, defaultSnapshotsDir } from "./direct-fs.js"
import { createFeatureBranch, featureBranchName, integrateInto } from "./features.js"
import {
  continuationPrompt,
  type DocSet,
  docView,
  flowView,
  projectAllowRules,
  stageInstructions,
  stageMessage,
  validationContext,
  workPrompt,
} from "./flows.js"
import { buildPlan, DIFF_INLINE_MAX, executePlan, type GitPlansDeps } from "./git-plans.js"
import { canonicalJson, nowIso, sha256Hex, ulid } from "./ids.js"
import { agentDoorPath, isNamedPipe } from "./ipc/endpoint.js"
import {
  type ClientState,
  type Handler,
  type HandlerContext,
  type Handlers,
  IpcServer,
  RpcFailure,
} from "./ipc/server.js"
import { checkRunStart, DEFAULT_LIMITS, type Limits, startOfLocalDay } from "./limits.js"
import { Outbox } from "./outbox.js"
import { PluginHost } from "./plugins.js"
import {
  defaultProcessTable,
  type ProcessTable,
  type RecordedProcess,
  sameProcess,
} from "./processes.js"
import { detectProfile } from "./project-profile.js"
import { Research, ResearchError } from "./research.js"
import { BrokerError, ResourceBroker } from "./resources/broker.js"
import { createRunContext } from "./run-context.js"
import { bwrapPath, type SandboxSpec } from "./sandbox.js"
import { SemanticProjector } from "./semantic.js"
import { openStore, type Store } from "./store/db.js"
import {
  CONVERSATION_KEY,
  type EvidenceRow,
  type FeatureInfo,
  type NoteRow,
  type PairingRow,
  type PermissionRuleRow,
  Repo,
  type RunRequestRow,
  type RunRow,
  type SubtaskInfo,
  type WorkItemRow,
} from "./store/repo.js"
import { CredentialService } from "./vault/credentials.js"
import { type KeyStore, noKeyStore } from "./vault/keystore.js"
import {
  authorizedKeysLine,
  fingerprint,
  generateEd25519,
  importSshConfig,
  KeelSshAgent,
  knownHostLines,
  scanHostKeys,
} from "./vault/ssh.js"
import { Vault, VaultError } from "./vault/vault.js"
import { runVerify } from "./verify.js"
import type { WorkspaceDriver } from "./workspace-driver.js"
import { defaultWorktreesDir, GitWorktreeDriver, releasesOnFinish } from "./workspaces.js"

export type DaemonOptions = {
  dbPath: string
  socketPath: string
  /** Puerta de agentes; por defecto `<socket>-agent` junto a la humana (ADR-0018 §2). */
  agentSocketPath?: string
  /** Almacén de artefactos (ADR-0012); por defecto `artifacts/` junto a la base. */
  artifactsDir?: string
  /** `gh` para las PR de ADR-0015; null = no crear PR. Por defecto, el del PATH. */
  gh?: string | null
  /**
   * ADR-0018 §3: `auto` aísla con bubblewrap los runs `execute` de Claude donde
   * exista (Linux, WSL2); `off` no aísla. Por defecto `auto`.
   */
  sandbox?: "auto" | "off"
  /**
   * Proyecto que se abre al arrancar (ADR-0019 §2). Sin él, el último abierto;
   * si nunca hubo uno, la carpeta actual.
   */
  rootPath?: string
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
  /**
   * El plugin con el método de Keel (ADR-0021 §1); `false` no lo carga. Por
   * defecto, `packages/daemon/method-plugin`.
   */
  methodPlugin?: string | false
  /** Tabla de procesos para reconciliar; por defecto la de la plataforma (processes.ts). */
  processes?: ProcessTable
  /** Límites antes del spawn; por defecto `DEFAULT_LIMITS` (limits.ts). */
  limits?: Partial<Limits>
  /** ADR-0025 §2: dónde vive la llave maestra del vault; por defecto ninguno (main.ts pasa el del sistema). */
  keystore?: KeyStore
  /** ADR-0025 §4: el ejecutable de `keel askpass`; por defecto, un envoltorio en el estado de Keel. */
  askpass?: string
}

export type OrphanCheck = { runId: string; recorded: RecordedProcess }

export class Daemon {
  readonly store: Store
  readonly repo: Repo
  readonly bus = new EventBus()
  readonly artifacts: ArtifactStore
  readonly semantic: SemanticProjector
  readonly broker: ResourceBroker
  /** ADR-0025: el vault y las credenciales de las conexiones. */
  readonly vault: Vault
  readonly credentials: CredentialService
  readonly plugins: PluginHost
  readonly research: Research
  readonly server: IpcServer
  /** Puerta de agentes (ADR-0018 §2): nada que entre por ella es humano. */
  readonly agentServer: IpcServer
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
  /** Proyecto por defecto: el de `--root` o el último abierto. */
  readonly project: { workspace_id: string; project_id: string }
  readonly rootPath: string
  readonly profile: ClaudeProfile
  readonly startedAt = Date.now()
  private readonly approvalWaiters = new Map<string, (r: ApprovalResolution) => void>()
  readonly outbox: Outbox
  readonly processes: ProcessTable
  /** Los límites efectivos: flags del daemon > Ajustes de la GUI > defaults (ADR-0002 regla 5). */
  get limits(): Limits {
    const set = this.repo.getSetting(LIMITS)?.value as Partial<Limits> | undefined
    return { ...DEFAULT_LIMITS, ...(set ?? {}), ...this.opts.limits }
  }
  private orphanSweep: Promise<void> = Promise.resolve()
  /** Runs que este proceso ya está despachando: una entrega repetida del outbox no los duplica. */
  private readonly dispatching = new Set<string>()
  /** Carpeta de trabajo de cada run vivo: las reglas no cubren archivos fuera de ella. */
  private readonly runCwd = new Map<string, string>()
  /** Trabajo en segundo plano (runs, liberaciones); `idle()` espera a que termine. */
  private readonly background = new Set<Promise<unknown>>()
  /** El perfil detectado de cada proyecto, mientras el humano no confirme uno (ADR-0021 §5). */
  private readonly detectedProfiles = new Map<string, ProjectProfile>()
  /**
   * Cierre aplicado con el run aún vivo (ADR-0021 §4): quién aprobó el plan. Al
   * asentar el run, la tarea pasa de `needs_review` a `done` a su nombre.
   */
  private readonly closedByPlan = new Map<string, string>()
  /** Una verificación a la vez por tarea: la segunda espera a la primera. */
  private readonly verifying = new Map<string, Promise<unknown>>()
  private lagMs = 0
  private lagTimer: ReturnType<typeof setInterval> | null = null

  readonly opts: DaemonOptions
  constructor(opts: DaemonOptions) {
    this.opts = opts
    this.store = openStore(opts.dbPath)
    this.repo = new Repo(this.store.db)
    this.artifacts = new ArtifactStore(
      opts.artifactsDir ?? join(dirname(opts.dbPath), "artifacts"),
      this.store.db,
    )
    this.repo.artifacts = this.artifacts
    // ADR-0011: cada evento guardado pasa por los intérpretes semánticos.
    this.semantic = new SemanticProjector({
      db: this.store.db,
      repo: this.repo,
      artifacts: this.artifacts,
    })
    this.research = new Research({ db: this.store.db, repo: this.repo, artifacts: this.artifacts })
    // ADR-0014: los plugins interpretan en su propio proceso, sin bloquear la ingesta.
    this.plugins = new PluginHost({
      db: this.store.db,
      projector: this.semantic,
      emit: (row, kind, payload) =>
        runUnitOfWork(this.uowDeps(), this.systemScope(row.project_id), (uow) =>
          uow.emit(kind, row.run_id, payload),
        ),
    })
    this.bus.subscribe((n) => {
      const row = this.repo.eventBySeq(n.event_seq)
      if (!row) return
      this.semantic.onEvent(row)
      if (!row.kind.startsWith("plugin.")) this.track(this.plugins.onEvent(row))
    })
    // ADR-0013: el intermediario ejecuta con la credencial; el agente sólo ve el resultado.
    this.broker = new ResourceBroker({
      db: this.store.db,
      artifacts: this.artifacts,
      plansDir: join(dirname(opts.dbPath), "plans"),
      emit: (projectId, runId, kind, payload) =>
        runUnitOfWork(this.uowDeps(), this.systemScope(projectId), (uow) =>
          uow.emit(kind, runId, payload),
        ),
      addEvidence: (e) => {
        let id = ""
        runUnitOfWork(this.uowDeps(), this.systemScope(e.project_id), (uow) => {
          const row = this.repo.addEvidence({ ...e, supersedes_id: null })
          id = row.id
          uow.emit("evidence.attached", e.run_id, this.evidenceView(row))
        })
        return id
      },
      ask: (ctx, op) => this.askHuman(ctx.projectId, ctx.runId as string, op),
      credentials: {
        ssh: (c, x) => this.credentials.ssh(c, x),
        password: (c, x) => this.credentials.password(c, x),
      },
    })
    const stateDir = dirname(opts.dbPath)
    this.vault = new Vault({
      db: this.store.db,
      // La librería no toca el llavero del sistema salvo que se lo pidan (main.ts lo hace):
      // las pruebas y otros consumidores no escriben en el llavero del usuario.
      keystore: opts.keystore ?? noKeyStore(),
      emit: (kind, payload) =>
        runUnitOfWork(this.uowDeps(), this.systemScope(), (uow) => uow.emit(kind, null, payload)),
    })
    this.credentials = new CredentialService({
      vault: this.vault,
      agent: new KeelSshAgent(join(stateDir, "ssh")),
      broker: this.broker,
      knownHosts: join(stateDir, "ssh", "known_hosts"),
      askpass: opts.askpass ?? join(stateDir, "bin", "keel-askpass"),
      humanDoor: () => this.server.path,
      emit: (projectId, runId, kind, payload) =>
        runUnitOfWork(this.uowDeps(), this.systemScope(projectId), (uow) =>
          uow.emit(kind, runId, payload),
        ),
      timeoutMs: () => this.settingsView().approvals.timeout_ms,
    })
    const root = opts.rootPath ?? this.repo.listProjects()[0]?.root_path ?? process.cwd()
    this.rootPath = root
    this.project = this.repo.ensureDefaultProject(root, basename(root))
    this.repo.touchProject(this.project.project_id)
    this.profile = { ...DEFAULT_PROFILE, cwd: root, ...opts.profile }
    this.processes = opts.processes ?? defaultProcessTable()
    this.claude = new ClaudeAdapter({ processes: this.processes, ...opts.adapterDeps })
    this.codexProfile = { ...DEFAULT_CODEX_PROFILE, cwd: root, ...opts.codex }
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
      rootOf: (id) => this.repo.projectRoot(id) ?? root,
      worktreesDir: opts.worktreesDir ?? defaultWorktreesDir(),
    })
    // Junto a la base: el directorio privado del daemon (`~/.keel`, 0700).
    this.agentTokens = new AgentTokens(opts.tokensDir ?? join(dirname(opts.dbPath), "run-tokens"))
    this.directFs = new DirectFsDriver({
      repo: this.repo,
      rootOf: (id) => this.repo.projectRoot(id) ?? root,
      snapshotsDir: opts.snapshotsDir ?? defaultSnapshotsDir(),
    })
    this.toolGate = new ApprovalGate({
      repo: this.repo,
      waitApproval: (id, ms) => this.waitApproval(id, ms),
      timeoutMs: () => this.settingsView().approvals.timeout_ms,
      cwdOf: (runId) => this.runCwd.get(runId) ?? null,
      stageOf: (run) => this.stagePolicy(run),
    })
    // El vínculo de una sesión externa dura lo que dura su conexión (ADR-0009 §4).
    const onClose = (client: ClientState) => {
      const actor = client.actor
      if (actor && "pairing_id" in actor && actor.pairing_id) {
        this.repo.closePairing(actor.pairing_id)
        this.emitSystem("session.pairing_closed", null, { pairing_id: actor.pairing_id })
      }
    }
    const handlers = this.handlers()
    this.server = new IpcServer({
      socketPath: opts.socketPath,
      repo: this.repo,
      bus: this.bus,
      handlers,
      onClose,
    })
    // ADR-0018 §2: la puerta de agentes. El sandbox del agente monta sólo ésta.
    this.agentServer = new IpcServer({
      socketPath: opts.agentSocketPath ?? agentDoorPath(opts.socketPath),
      repo: this.repo,
      bus: this.bus,
      handlers,
      onClose,
      door: "agent",
    })
  }

  /** Reconcilia (una vez), abre el socket y devuelve lo reconciliado. */
  start(): { interrupted: string[]; orphans: OrphanCheck[] } {
    const reconciled = this.reconcile()
    // ADR-0025: el vault se abre con el llavero si se puede; sin él espera la frase.
    if (!this.opts.askpass) writeAskpass(join(dirname(this.opts.dbPath), "bin", "keel-askpass"))
    writeNoAskpass(this.noAskpassPath())
    this.track(this.vault.open().catch(() => "locked"))
    // Lo que quedó pendiente antes de una caída: despachos y liberaciones (DoD Fase 0).
    this.track(this.outbox.drain())
    this.server.start()
    this.agentServer.start()
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
    this.credentials.stop()
    this.plugins.stopAll()
    this.server.stop()
    this.agentServer.stop()
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

  /** Espera la decisión humana; `ms` null = sin límite (ADR-0020 §3). */
  private waitApproval(id: string, ms: number | null): Promise<ApprovalResolution> {
    return new Promise((resolve) => {
      const timer =
        ms === null
          ? null
          : setTimeout(() => {
              this.approvalWaiters.delete(id)
              resolve({ decision: "expired" })
            }, ms)
      this.approvalWaiters.set(id, (r) => {
        if (timer) clearTimeout(timer)
        this.approvalWaiters.delete(id)
        resolve(r)
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
      // Los secretos (ADR-0025) no entran ni al hash del recibo.
      const requestHash = await sha256Hex(
        canonicalJson({
          method,
          params: {
            ...p,
            request_id: undefined,
            secret_value: undefined,
            passphrase: undefined,
            value: undefined,
          },
        }),
      )
      return runCommand(
        this.uowDeps(),
        {
          projectId: this.projectOfParams(ctx, p),
          actorId: ctx.actor.actor_id,
          idempotencyKey: p.idempotency_key,
          requestHash,
        },
        (uow) => fn(p, uow, ctx),
      )
    }
  }

  /** El flag de arranque manda; si no, lo que el humano eligió en la GUI (ADR-0008 §2). */
  settingsView(): SettingsView {
    // ADR-0020 §3: lo que fijó el humano manda; si no, el perfil (null = sin límite).
    const timeout = this.repo.getSetting(APPROVALS_TIMEOUT)
    const suggestions = this.repo.getSetting(PROMPT_SUGGESTIONS)
    const rest = {
      approvals: {
        timeout_ms: timeout
          ? typeof timeout.value === "number"
            ? timeout.value
            : null
          : this.profile.approval_timeout_ms,
      },
      // Encendidas por decisión del humano (ADR-0020 §6) hasta que las apague.
      prompt_suggestions: { enabled: suggestions ? suggestions.value === true : true },
      default_models: (() => {
        const set = this.repo.getSetting(DEFAULT_MODELS)
        const v = (set?.value ?? {}) as DefaultModels
        const one = (p: "claude" | "codex", model: string | null, effort: Effort | null) => {
          const c = v[p]
          return c
            ? { model: c.model, effort: c.effort ?? null, source: "setting" as const }
            : { model, effort, source: "default" as const }
        }
        return {
          claude: one("claude", this.profile.model, this.profile.effort ?? null),
          codex: one("codex", this.codexProfile.model ?? null, null),
          updated_by: set?.updated_by ?? null,
          updated_at: set?.updated_at ?? null,
        }
      })(),
      limits: (() => {
        const l = this.limits
        const set = this.repo.getSetting(LIMITS)
        return {
          run_budget_usd: l.run_budget_micro_usd === null ? null : l.run_budget_micro_usd / 1e6,
          daily_budget_usd:
            l.daily_budget_micro_usd === null ? null : l.daily_budget_micro_usd / 1e6,
          max_concurrent_runs: l.max_concurrent_runs,
          source: (this.opts.limits && Object.keys(this.opts.limits).length
            ? "flag"
            : set
              ? "setting"
              : "default") as "default" | "setting" | "flag",
          updated_by: set?.updated_by ?? null,
          updated_at: set?.updated_at ?? null,
        }
      })(),
    }
    if (this.codexProfile.subscription_enabled)
      return {
        codex_subscription: { enabled: true, source: "flag", updated_by: null, updated_at: null },
        ...rest,
      }
    const s = this.repo.getSetting(CODEX_SUBSCRIPTION)
    return {
      codex_subscription: {
        enabled: s?.value === true,
        source: s?.value === true ? "setting" : "off",
        updated_by: s?.updated_by ?? null,
        updated_at: s?.updated_at ?? null,
      },
      ...rest,
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
    opts: {
      expectedRevision?: number
      runId?: string | null
      reason?: string
      /** Continuar la conversación: el worktree pasa al run hijo, no se libera. */
      keepWorkspaces?: boolean
    } = {},
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
    // ADR-0022 §3: integrada una subtarea, la feature sigue con la siguiente.
    if (to === "done" && w.parent_work_item_id) {
      const parentId = w.parent_work_item_id
      uow.afterCommit(() => this.scheduleFeature(parentId))
    }
    if (!updated)
      throw rpcError(ErrorCode.conflict, "otro escritor cambió la tarea; vuelve a leerla", {
        current_revision: this.repo.getWorkItem(w.id)?.revision ?? null,
      })
    uow.emit("work_item.updated", opts.runId ?? null, {
      ...this.repo.workItemView(updated),
      transition: { from: w.lifecycle, to, by, reason: opts.reason ?? null },
    })
    // El worktree de un run completed se conserva para la revisión; salir de ella lo libera.
    if (w.lifecycle === "needs_review" && !opts.keepWorkspaces)
      for (const runId of this.repo.runsWithWorkspaces(w.id))
        this.enqueueRelease(uow, runId, "review_exit")
    return updated
  }

  private handlers(): Handlers {
    const repo = this.repo
    return {
      "daemon.health": (_params, ctx) => {
        const pid = this.scopeOf(ctx)
        return {
          version: "0.0.0",
          event_loop_lag_ms: Math.round(this.lagMs),
          rss_bytes: process.memoryUsage().rss,
          ingest_queue: 0,
          wal_bytes: existsSync(`${this.opts.dbPath}-wal`)
            ? Bun.file(`${this.opts.dbPath}-wal`).size
            : 0,
          limits: this.limits,
          spent_today_micro_usd: repo.spentSince(pid, startOfLocalDay()),
          project: { id: pid, root_path: repo.projectRoot(pid) ?? this.rootPath },
        }
      },
      "work_items.create": this.mutation<Params<"work_items.create">>(
        "work_items.create",
        (p, uow, ctx) => {
          // Lo que crea un agente nace en triage con source = 'agent' (ADR-0009 §5) y
          // queda ligado a la tarea y al run de los que nació (ADR-0024 §2).
          const projectId = this.scopeOf(ctx, p.project_id)
          const actor = ctx.actor
          const origin =
            actor.kind === "agent" && actor.work_item_id
              ? repo.getWorkItem(actor.work_item_id)
              : null
          const w = repo.createWorkItem({
            project_id: projectId,
            title: p.title,
            kind: p.kind,
            source: actor.kind === "agent" ? "agent" : "human",
            ...(p.spec_markdown === undefined ? {} : { spec_markdown: p.spec_markdown }),
            ...(p.priority ? { priority: p.priority } : {}),
            ...(origin ? { origin_work_item_id: origin.id } : {}),
            ...(origin && actor.kind === "agent" && actor.run_id
              ? { origin_run_id: actor.run_id }
              : {}),
          })
          if (origin && actor.kind === "agent")
            repo.addNote({
              work_item_id: w.id,
              author: actor.actor_id,
              content_markdown: `Nació de ${origin.dedupe_key === CONVERSATION_KEY ? "la conversación del proyecto" : origin.display_id}${actor.run_id ? ` (run ${actor.run_id})` : ""}.`,
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
        const actor = {
          actor_id: `agent:${binding.run_id}`,
          kind: "agent" as const,
          ...binding,
          scopes: AGENT_SCOPES,
          pairing_id: null,
        }
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
          throw rpcError(
            ErrorCode.unauthorized,
            "un agente sólo añade notas a la tarea que tiene vinculada",
          )
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
          if (!actor.work_item_id)
            throw rpcError(ErrorCode.unauthorized, "un handoff necesita una tarea vinculada")
          const origin = this.workItemIn(ctx, actor.work_item_id)
          const created = repo.createWorkItem({
            project_id: actor.project_id,
            title: p.title,
            kind: p.kind ?? "chore",
            source: "agent",
            spec_markdown: `${p.summary_markdown}\n\n---\nHandoff desde ${origin.display_id} (${actor.run_id ? `run ${actor.run_id}` : actor.actor_id}).`,
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
      "work_items.close": this.mutation<Params<"work_items.close">>(
        "work_items.close",
        (p, uow, ctx) => {
          requireHuman(ctx, "cerrar una tarea")
          const w = this.requireWorkItem(p.work_item_id)
          if (repo.liveRunFor(w.id))
            throw rpcError(
              ErrorCode.invalidTransition,
              "la tarea tiene un run vivo: detenlo antes de cerrarla",
            )
          // ADR-0027 §3: una feature se cierra cuando sus hijas terminaron.
          const pending = repo.childrenOf(w.id).filter((c) => c.lifecycle !== "done")
          if (pending.length)
            throw rpcError(
              ErrorCode.invalidTransition,
              `la feature tiene ${pending.length} subtarea(s) sin terminar: ciérralas primero`,
            )
          const plan = repo
            .listApprovals(w.project_id)
            .find(
              (a) =>
                JSON.parse(a.operation_json).tool === "git.plan" &&
                repo.getRun(a.run_id)?.work_item_id === w.id,
            )
          if (plan)
            throw rpcError(
              ErrorCode.invalidTransition,
              "la tarea tiene un plan de cierre esperando: ese plan es su cierre",
            )
          const closed = this.transition(uow, w, "done", "human_close", {
            ...(p.expected_revision === undefined ? {} : { expectedRevision: p.expected_revision }),
            reason: `cerrada a mano: ${p.reason}`,
          })
          // La evidencia queda con su procedencia (ADR-0012): quién, cuándo y que fue a mano.
          const body = [
            `# Cierre a mano de ${w.display_id}`,
            "",
            `**Motivo:** ${p.reason}`,
            ...(p.evidence.url ? ["", `**Enlace:** ${p.evidence.url}`] : []),
            ...(p.evidence.text ? ["", p.evidence.text] : []),
          ].join("\n")
          const stored = this.artifacts.put(body, "text/markdown")
          const ev = repo.addEvidence({
            project_id: w.project_id,
            work_item_id: w.id,
            run_id: null,
            kind: "manual_close",
            title: p.evidence.url ? `Cerrada a mano · ${p.evidence.url}` : "Cerrada a mano",
            artifact_ref: stored.ref,
            sha256: stored.sha256,
            metadata: { reason: p.reason, url: p.evidence.url ?? null },
            provenance: {
              actor: actorOf(ctx),
              captured_at: nowIso(),
              source: { manual_close: true },
            },
            created_by: ctx.actor.actor_id,
            supersedes_id: null,
          })
          uow.emit("evidence.attached", null, this.evidenceView(ev))
          uow.emit("task.closed", null, {
            work_item_id: w.id,
            manual: true,
            reason: p.reason,
            url: p.evidence.url ?? null,
            approver: ctx.actor.actor_id,
          })
          const view = repo.workItemView(closed)
          uow.emit("work_item.updated", null, view)
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
              "`done` es el cierre humano: usa work_items.close con motivo y evidencia (ADR-0027)",
            )
          const updated = this.transition(uow, w, p.to, "human", {
            ...(p.expected_revision === undefined ? {} : { expectedRevision: p.expected_revision }),
            ...(p.reason === undefined ? {} : { reason: p.reason }),
          })
          return repo.workItemView(updated)
        },
      ),
      "runs.start": this.mutation<Params<"runs.start">>("runs.start", (p, uow) =>
        this.startRunIn(uow, p),
      ),
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
      // --- el método (ADR-0021) ---------------------------------------------------
      "tasks.work": this.mutation<Params<"tasks.work">>("tasks.work", (p, uow, ctx) => {
        requireHuman(ctx, "trabajar una tarea")
        const w = this.requireWorkItem(p.work_item_id)
        if (w.lifecycle === "done")
          throw rpcError(ErrorCode.invalidTransition, "la tarea está terminada")
        let started: Stage | null = null
        if (!repo.getFlow(w.id)) {
          started =
            w.lifecycle === "triage"
              ? "brief"
              : w.lifecycle === "needs_review"
                ? "close"
                : "implement"
          repo.createFlow(w.id, started, uow.actorId)
          uow.emit("work_item.updated", null, repo.workItemView(w))
        }
        const live = repo.liveRunFor(w.id)
        if (live) {
          // Con el agente trabajando, «trabajar» es escribirle.
          if (!p.text?.trim())
            throw rpcError(ErrorCode.conflict, "el agente ya está trabajando; escríbele un mensaje")
          if (!this.providerOf(live).sendMessage(live.id, p.text))
            throw rpcError(ErrorCode.conflict, "el run ya no acepta mensajes; está terminando")
          uow.emit("run.user_message", live.id, { text: p.text, actor: actorOf(ctx) })
          return {
            delivered: "message" as const,
            run: repo.runView(live),
            flow: this.flowViewOf(w.id) as TaskFlowView,
          }
        }
        const hadRun = repo.lastRunFor(w.id) !== null
        const flow = repo.getFlow(w.id) as NonNullable<ReturnType<Repo["getFlow"]>>
        const run = this.startFlowRun(uow, w, p.text?.trim() || workPrompt(w, flow.stage), {
          source: "human",
          profile: p.profile,
          ...(p.options ? { options: p.options } : {}),
        })
        // Con el run ya creado, para que el chat de la conversación lo muestre.
        if (started)
          uow.emit("task.flow_started", run.id, {
            work_item_id: w.id,
            stage: started,
            actor: actorOf(ctx),
          })
        return {
          delivered: hadRun ? ("continued" as const) : ("started" as const),
          run,
          flow: this.flowViewOf(w.id) as TaskFlowView,
        }
      }),
      // --- la conversación del proyecto (ADR-0024) ------------------------------------
      "conversation.open": (params, ctx) => {
        requireHuman(ctx, "abrir la conversación del proyecto")
        const p = params as Params<"conversation.open">
        const w = this.conversationFor(this.scopeOf(ctx, p.project_id))
        const last = repo.lastRunFor(w.id)
        return {
          work_item: repo.workItemView(w),
          run: last ? repo.runView(last) : null,
          born: repo.bornFrom(w.id).map((x) => repo.workItemView(x)),
          notes: repo.listNotes(w.id).map(noteView),
        }
      },
      "conversation.ask": this.mutation<Params<"conversation.ask">>(
        "conversation.ask",
        (p, uow, ctx) => {
          requireHuman(ctx, "preguntar al proyecto")
          const w = this.conversationFor(this.scopeOf(ctx, p.project_id))
          const live = repo.liveRunFor(w.id)
          if (live) {
            if (p.fresh)
              throw rpcError(
                ErrorCode.conflict,
                "el agente está respondiendo; espera a que termine o detenlo para empezar otra conversación",
              )
            if (!this.providerOf(live).sendMessage(live.id, p.text))
              throw rpcError(ErrorCode.conflict, "el run ya no acepta mensajes; está terminando")
            uow.emit("run.user_message", live.id, { text: p.text, actor: actorOf(ctx) })
            return { delivered: "message" as const, run: repo.runView(live) }
          }
          // «Nueva conversación» no arrastra la sesión anterior: el contexto no crece sin límite.
          const last = p.fresh ? null : repo.lastRunFor(w.id)
          const manifest = last
            ? (JSON.parse(last.context_manifest_json) as {
                provider?: "claude" | "codex"
                options?: Params<"runs.start">["options"]
              })
            : {}
          const run = this.startRunIn(uow, {
            work_item_id: w.id,
            purpose: "plan",
            prompt: p.text,
            prompt_source: "human",
            profile: p.profile ?? manifest.provider ?? "claude",
            options: { ...manifest.options, ...p.options, permission_mode: "plan" },
            parent_run_id: last?.id ?? null,
          })
          return { delivered: last ? ("continued" as const) : ("started" as const), run }
        },
      ),
      "tasks.flow": (params, ctx) => {
        const p = params as Params<"tasks.flow">
        this.requireOwnTask(ctx, p.work_item_id)
        return { flow: this.flowViewOf(p.work_item_id) }
      },
      "stages.advance": this.mutation<Params<"stages.advance">>("stages.advance", (p, uow, ctx) => {
        // ADR-0021 §2: avanza el agente; el humano decide los gates y puede devolver.
        if (ctx.actor.kind !== "agent")
          throw rpcError(
            ErrorCode.unauthorized,
            "la etapa la avanza el agente; un humano la devuelve con stages.return o decide su gate",
          )
        const w = this.requireOwnTask(ctx, p.work_item_id)
        const flow = repo.getFlow(w.id)
        if (!flow)
          throw rpcError(ErrorCode.notFound, "la tarea no se está trabajando con el método")
        const pending = repo.pendingStageGate(w.id)
        if (pending)
          throw rpcError(
            ErrorCode.conflict,
            "hay un gate esperando al humano; espera su decisión antes de avanzar",
            { approval_id: pending.id },
          )
        const ceremony = flow.stage === "brief" ? (p.ceremony ?? flow.ceremony) : flow.ceremony
        const move = stageMove(flow.stage, p.to, ceremony)
        if (!move.ok) throw rpcError(ErrorCode.invalidParams, move.reason)
        if (flow.stage === "brief" && p.ceremony)
          repo.updateFlow(w.id, { ceremony: p.ceremony, ceremony_reason: p.reason ?? null })
        // Lo mecánico lo valida Keel: el agente recibe sólo lo que falta.
        const docs = this.docSet(w.id)
        const vctx = validationContext(this.profileOf(w.project_id))
        const missing: string[] = []
        for (const kind of move.requires) {
          const md = docs[kind]
          if (md === undefined) {
            missing.push(`${kind}: falta; guárdalo con task_doc_put`)
            continue
          }
          for (const c of validateDoc(kind, md, docs, vctx).checks)
            if (!c.ok && c.level === "block")
              missing.push(`${kind}: ${c.msg}${c.detail ? ` (${c.detail})` : ""}`)
        }
        if (flow.stage === "review" && p.to === "close") {
          const profile = this.profileOf(w.project_id)
          if (profile?.verify.length) {
            const last = flow.last_verify_json
              ? (JSON.parse(flow.last_verify_json) as VerifyResult[])
              : null
            const base = flow.baseline_json
              ? (JSON.parse(flow.baseline_json) as VerifyResult[])
              : null
            if (!last) missing.push("verificación: corre verify_run antes de cerrar")
            else {
              const delta = verifyDelta(base, last)
              if (!delta.green && qaVerdict(docs.qa ?? "") !== "WAIVED")
                missing.push(
                  `verificación: rojo nuevo en ${delta.newRed.join(", ")}; arréglalo o deja el QA en WAIVED con su justificación`,
                )
            }
          }
        }
        if (missing.length > 0)
          throw rpcError(
            ErrorCode.invalidParams,
            `no se puede pasar a ${p.to}: ${missing.join("; ")}`,
            { missing },
          )
        if (move.gate) {
          const gate = this.openStageGate(uow, w, move.gate, flow.stage, p.to, "stage")
          return {
            flow: this.flowViewOf(w.id) as TaskFlowView,
            gate,
          }
        }
        this.applyStage(uow, w, p.to, {
          authorizedBy: flow.started_by,
          delegated: true,
          reason: p.reason,
        })
        return {
          flow: this.flowViewOf(w.id) as TaskFlowView,
          gate: null,
        }
      }),
      "stages.return": this.mutation<Params<"stages.return">>("stages.return", (p, uow, ctx) => {
        requireHuman(ctx, "devolver una tarea a una etapa anterior")
        const w = this.requireWorkItem(p.work_item_id)
        const flow = repo.getFlow(w.id)
        if (!flow)
          throw rpcError(ErrorCode.notFound, "la tarea no se está trabajando con el método")
        if (!canReturn(flow.stage, p.to))
          throw rpcError(
            ErrorCode.invalidParams,
            `de ${flow.stage} sólo se vuelve a una etapa anterior`,
          )
        // El lifecycle no vuelve a triage: brief y diseño sólo se reabren antes de implementar.
        if (lifecycleForStage(p.to) === "triage" && w.lifecycle !== "triage")
          throw rpcError(
            ErrorCode.invalidTransition,
            "la tarea ya pasó a implementación; para cambiar el diseño, pide al agente un cambio de contrato",
          )
        let item = w
        if (item.lifecycle === "needs_review")
          item = this.transition(uow, item, "planned", "human", {
            reason: p.reason,
            keepWorkspaces: true,
          })
        const pending = repo.pendingStageGate(w.id)
        if (pending) repo.setApproval(pending.id, "expired", null)
        repo.updateFlow(w.id, { stage: p.to })
        const run = repo.lastRunFor(w.id)
        uow.emit("task.stage_changed", run?.id ?? null, {
          work_item_id: w.id,
          from: flow.stage,
          to: p.to,
          ceremony: flow.ceremony,
          authorized_by: uow.actorId,
          delegated: false,
          reason: p.reason,
          returned: true,
        })
        uow.emit("work_item.updated", run?.id ?? null, repo.workItemView(item))
        uow.afterCommit(() =>
          this.continueFlow(w.id, `El humano devolvió la tarea a ${p.to}: ${p.reason}`),
        )
        return this.flowViewOf(w.id) as TaskFlowView
      }),
      "task_docs.put": this.mutation<Params<"task_docs.put">>("task_docs.put", (p, uow, ctx) => {
        const w = this.requireOwnTask(ctx, p.work_item_id)
        const flow = repo.getFlow(w.id)
        const row = repo.putTaskDoc({
          work_item_id: w.id,
          kind: p.kind,
          content: p.content_markdown,
          author: uow.actorId,
        })
        const docs = this.docSet(w.id)
        const report = validateDoc(
          p.kind,
          p.content_markdown,
          docs,
          validationContext(this.profileOf(w.project_id)),
        )
        const run = repo.lastRunFor(w.id)
        uow.emit("task.doc_put", run?.id ?? null, {
          work_item_id: w.id,
          kind: p.kind,
          version: row.version,
          sha256: row.sha256,
          size: row.size,
          author: row.author,
          report,
        })
        // ADR-0021 §4: cambiar el contrato congelado durante la implementación reabre el gate (b).
        if (
          p.kind === "design" &&
          flow?.contract_sha256 &&
          (flow.stage === "implement" || flow.stage === "review") &&
          !repo.pendingStageGate(w.id)
        ) {
          const now = createHash("sha256")
            .update(contractSection(p.content_markdown) ?? "")
            .digest("hex")
          if (now !== flow.contract_sha256)
            this.openStageGate(uow, w, "design", flow.stage, flow.stage, "contract")
        }
        return docView(row, report)
      }),
      "task_docs.get": (params, ctx) => {
        const p = params as Params<"task_docs.get">
        const w = this.requireOwnTask(ctx, p.work_item_id)
        const row = repo.getTaskDoc(w.id, p.kind, p.version)
        if (!row) return { doc: null }
        const content = repo.taskDocContent(row)
        const report = validateDoc(
          p.kind,
          content,
          this.docSet(w.id),
          validationContext(this.profileOf(w.project_id)),
        )
        return { doc: docView(row, report, content) }
      },
      "task_docs.list": (params, ctx) => {
        const p = params as Params<"task_docs.list">
        const w = this.requireOwnTask(ctx, p.work_item_id)
        const docs = this.docSet(w.id)
        const vctx = validationContext(this.profileOf(w.project_id))
        return {
          docs: repo
            .latestTaskDocs(w.id)
            .map((d) => docView(d, validateDoc(d.kind, docs[d.kind] ?? "", docs, vctx))),
        }
      },
      "verify.run": async (params, ctx) => {
        const p = params as Params<"verify.run">
        const w = this.requireOwnTask(ctx, p.work_item_id)
        const r = await this.taskVerify(w.id)
        return { results: r.results, delta: r.delta, baseline: r.baseline }
      },
      "projects.profile_get": async (params, ctx) => {
        const p = params as Params<"projects.profile_get">
        return this.profileView(this.scopeOf(ctx, p.project_id))
      },
      "projects.profile_set": this.mutation<Params<"projects.profile_set">>(
        "projects.profile_set",
        (p, uow, ctx) => {
          requireHuman(ctx, "confirmar el perfil del proyecto")
          const projectId = this.scopeOf(ctx, p.project_id)
          const row = repo.setProfile(projectId, p.profile, uow.actorId)
          uow.emit("project.profile_set", null, { project_id: projectId, profile: p.profile })
          const detected = this.detectedProfiles.get(projectId) ?? p.profile
          return {
            project_id: projectId,
            profile: p.profile,
            detected,
            confirmed_by: row.confirmed_by,
            confirmed_at: row.confirmed_at,
          }
        },
      ),
      "runs.set_mode": this.mutation<Params<"runs.set_mode">>("runs.set_mode", (p, uow, ctx) => {
        requireHuman(ctx, "cambiar el modo de un run")
        const run = this.requireLiveRun(p.run_id)
        const before = runOptionsFor(run)
        // Las mismas reglas que al arrancar: bypass sólo en execute con git.
        const checked = this.runOptions(run.project_id, run.purpose, this.providerName(run), {
          permission_mode: p.permission_mode,
        })
        const codex = this.providerName(run) === "codex"
        if (codex && (before.permission_mode === "plan") !== (p.permission_mode === "plan"))
          throw rpcError(
            ErrorCode.invalidParams,
            "Codex no entra ni sale de plan con el run vivo: el sandbox se fija al arrancar",
          )
        const updated = repo.mergeManifest(run.id, {
          options: { ...before, permission_mode: checked.permission_mode },
        })
        const applies = codex ? "next_turn" : "now"
        uow.emit("run.mode_changed", run.id, {
          from: before.permission_mode,
          to: checked.permission_mode,
          applies,
          actor: actorOf(ctx),
        })
        uow.emit("run.updated", run.id, repo.runView(updated))
        uow.afterCommit(() => this.applyLive(run, (a) => a.setMode(run.id, p.permission_mode)))
        return { run: repo.runView(updated), applies: applies as "now" | "next_turn" }
      }),
      "runs.set_model": this.mutation<Params<"runs.set_model">>("runs.set_model", (p, uow, ctx) => {
        requireHuman(ctx, "cambiar el modelo de un run")
        const run = this.requireLiveRun(p.run_id)
        const before = runOptionsFor(run)
        const effort = p.effort ?? null
        const updated = repo.mergeManifest(run.id, {
          options: { ...before, model: p.model, effort },
        })
        const applies = this.providerName(run) === "codex" ? "next_turn" : "now"
        uow.emit("run.model_changed", run.id, {
          from: { model: before.model, effort: before.effort ?? null },
          to: { model: p.model, effort },
          applies,
          actor: actorOf(ctx),
        })
        uow.emit("run.updated", run.id, repo.runView(updated))
        uow.afterCommit(() => this.applyLive(run, (a) => a.setModel(run.id, p.model, effort)))
        return { run: repo.runView(updated), applies: applies as "now" | "next_turn" }
      }),
      "runs.message": this.mutation<Params<"runs.message">>("runs.message", (p, uow, ctx) => {
        requireHuman(ctx, "escribirle a un run")
        const run = repo.getRun(p.run_id)
        if (!run) throw rpcError(ErrorCode.notFound, "el run no existe")
        if (!ACTIVE_RUN_STATUSES.includes(run.status))
          throw rpcError(
            ErrorCode.invalidTransition,
            `el run está ${run.status}; para seguir la conversación usa runs.continue`,
          )
        const provider = this.providerOf(run)
        if (!provider.sendMessage(run.id, p.text))
          throw rpcError(ErrorCode.conflict, "el run ya no acepta mensajes; está terminando")
        uow.emit("run.user_message", run.id, { text: p.text, actor: actorOf(ctx) })
        return { run_id: run.id, delivered: true as const }
      }),
      "runs.continue": this.mutation<Params<"runs.continue">>("runs.continue", (p, uow, ctx) => {
        requireHuman(ctx, "continuar un run")
        const parent = repo.getRun(p.run_id)
        if (!parent) throw rpcError(ErrorCode.notFound, "el run no existe")
        if (ACTIVE_RUN_STATUSES.includes(parent.status))
          throw rpcError(
            ErrorCode.invalidTransition,
            "el run sigue vivo; escríbele con runs.message",
          )
        const manifest = JSON.parse(parent.context_manifest_json) as {
          provider?: string
          options?: Params<"runs.start">["options"]
        }
        // Una ejecución revisada o fallida vuelve a planned por decisión del humano
        // (las mismas aristas que work_items.transition) y sigue en su worktree.
        const w = this.requireWorkItem(parent.work_item_id)
        // ADR-0021: una tarea del método que espera al humano también sigue al escribirle.
        if (
          parent.purpose === "execute" &&
          (w.lifecycle === "needs_review" ||
            w.lifecycle === "failed" ||
            w.lifecycle === "waiting_human")
        )
          this.transition(uow, w, "planned", "human", {
            runId: parent.id,
            reason: "continuar la conversación",
            keepWorkspaces: true,
          })
        const run = this.startRunIn(uow, {
          work_item_id: parent.work_item_id,
          purpose: parent.purpose,
          prompt: p.text,
          profile: manifest.provider ?? "claude",
          // ADR-0028: sólo se hereda el tope de turnos que eligió el humano.
          options: { ...inheritedOptions(parent), ...p.options },
          parent_run_id: parent.id,
        })
        return run
      }),
      "runs.request": this.mutation<Params<"runs.request">>("runs.request", (p, uow, ctx) => {
        // Un agente pide; arrancar es del humano (ADR-0009 §5). Un humano usa runs.start.
        const actor = ctx.actor
        if (actor.kind !== "agent")
          throw rpcError(
            ErrorCode.unauthorized,
            "runs.request es para agentes; un humano usa runs.start",
          )
        const w = this.workItemIn(ctx, p.work_item_id)
        const request = repo.createRunRequest({
          project_id: w.project_id,
          work_item_id: w.id,
          purpose: p.purpose,
          prompt: p.prompt ?? null,
          profile: p.profile ?? null,
          reason: p.reason,
          requested_by: actor.actor_id,
          requested_by_run: actor.run_id,
        })
        const view = runRequestView(request)
        uow.emit("run.requested", actor.run_id, { ...view, actor: actorOf(ctx) })
        return view
      }),
      "runs.requests_list": (params, ctx) => {
        requireHuman(ctx, "revisar las peticiones de run")
        const p = params as Params<"runs.requests_list">
        return {
          requests: repo.listRunRequests(this.scopeOf(ctx), p.state).map(runRequestView),
        }
      },
      "runs.request_resolve": this.mutation<Params<"runs.request_resolve">>(
        "runs.request_resolve",
        (p, uow, ctx) => {
          requireHuman(ctx, "resolver una petición de run")
          const request = repo.getRunRequest(p.run_request_id)
          if (!request) throw rpcError(ErrorCode.notFound, "la petición de run no existe")
          if (request.state !== "pending")
            throw rpcError(ErrorCode.conflict, `la petición ya está ${request.state}`)
          if (p.decision === "reject") {
            const done = repo.resolveRunRequest(request.id, {
              state: "rejected",
              run_id: null,
              decided_by: uow.actorId,
            }) as NonNullable<ReturnType<Repo["getRunRequest"]>>
            const view = runRequestView(done)
            uow.emit("run.request_resolved", request.requested_by_run, view)
            return { request: view, run: null }
          }
          // Mismas reglas que runs.start; si no se cumplen, la petición sigue pendiente.
          const run = this.startRunIn(uow, {
            work_item_id: request.work_item_id,
            purpose: request.purpose,
            prompt: request.prompt ?? undefined,
            profile: request.profile ?? undefined,
          })
          const done = repo.resolveRunRequest(request.id, {
            state: "started",
            run_id: run.id,
            decided_by: uow.actorId,
          }) as NonNullable<ReturnType<Repo["getRunRequest"]>>
          const view = runRequestView(done)
          uow.emit("run.request_resolved", request.requested_by_run, view)
          return { request: view, run }
        },
      ),
      "session.pair": (params, ctx) => {
        // Un `keel mcp` sin token pide entrar (ADR-0009 §4). Desde aquí la conexión no es
        // humana: sólo espera la decisión.
        const p = params as Params<"session.pair">
        if (ctx.client.actor && ctx.client.actor.kind !== "unbound")
          throw rpcError(ErrorCode.conflict, "la conexión ya está vinculada o emparejándose")
        const pairing = repo.createPairing({
          code: pairingCode(),
          client_name: p.client_name,
          cwd: p.cwd ?? null,
        })
        ctx.client.actor = {
          actor_id: `pairing:${pairing.id}`,
          kind: "pending",
          pairing_id: pairing.id,
        }
        const view = pairingView(pairing)
        this.emitSystem("session.pairing_requested", null, view)
        return view
      },
      "session.pair_status": (_params, ctx) => {
        const actor = ctx.actor
        const id = actor.kind === "pending" || actor.kind === "agent" ? actor.pairing_id : null
        const pairing = id ? repo.getPairing(id) : null
        if (!pairing) throw rpcError(ErrorCode.notFound, "esta conexión no tiene emparejamiento")
        return pairingView(pairing)
      },
      "session.pairings_list": (params, ctx) => {
        requireHuman(ctx, "revisar los emparejamientos")
        const p = params as Params<"session.pairings_list">
        return { pairings: repo.listPairings(p.state).map(pairingView) }
      },
      "session.pair_resolve": this.mutation<Params<"session.pair_resolve">>(
        "session.pair_resolve",
        (p, uow, ctx) => {
          requireHuman(ctx, "aprobar una sesión externa")
          const pairing = repo.getPairing(p.pairing_id)
          if (!pairing) throw rpcError(ErrorCode.notFound, "el emparejamiento no existe")
          if (pairing.state !== "pending")
            throw rpcError(ErrorCode.conflict, `el emparejamiento ya está ${pairing.state}`)
          const client = this.pairingClient(pairing.id)
          if (p.decision === "approve" && !client) {
            repo.closePairing(pairing.id)
            throw rpcError(ErrorCode.conflict, "la sesión se desconectó antes de aprobarla")
          }
          if (p.work_item_id !== undefined) {
            const w = repo.getWorkItem(p.work_item_id)
            if (!w) throw rpcError(ErrorCode.notFound, "work item no existe")
          }
          const scopes = p.scopes ?? [...AGENT_SCOPES]
          // La sesión trabaja en el proyecto de la tarea o en el que tiene abierto el humano.
          const pairProject = p.work_item_id
            ? (repo.getWorkItem(p.work_item_id)?.project_id ?? this.scopeOf(ctx))
            : this.scopeOf(ctx)
          const done = repo.resolvePairing(pairing.id, {
            state: p.decision === "approve" ? "approved" : "rejected",
            project_id: p.decision === "approve" ? pairProject : null,
            work_item_id: p.decision === "approve" ? (p.work_item_id ?? null) : null,
            scopes: p.decision === "approve" ? scopes : [],
            decided_by: uow.actorId,
          }) as NonNullable<ReturnType<Repo["getPairing"]>>
          const view = pairingView(done)
          uow.emit("session.pairing_resolved", null, view)
          if (client) {
            if (p.decision === "approve")
              client.actor = {
                actor_id: `agent:ext:${pairing.id}`,
                kind: "agent",
                run_id: null,
                project_id: pairProject,
                work_item_id: done.work_item_id,
                scopes,
                pairing_id: pairing.id,
              }
            // Rechazada: la conexión sigue `pending` y sólo puede leer su estado.
            uow.afterCommit(() => this.server.notifyClient(client, "session.paired", view))
          }
          return view
        },
      ),
      "projects.list": (_params, ctx) => {
        requireHuman(ctx, "listar los proyectos")
        return { projects: repo.listProjects().map(projectView), current: this.scopeOf(ctx) }
      },
      "projects.open": (params, ctx) => {
        requireHuman(ctx, "abrir un proyecto")
        const p = params as Params<"projects.open">
        let root: string
        try {
          root = realpathSync.native(p.path)
          if (!statSync(root).isDirectory()) throw new Error("no es una carpeta")
        } catch (e) {
          throw rpcError(
            ErrorCode.invalidParams,
            `no se puede abrir ${p.path}: ${(e as Error).message}`,
          )
        }
        const opened = repo.ensureDefaultProject(root, basename(root) || root)
        repo.touchProject(opened.project_id)
        ctx.client.project_id = opened.project_id
        const view = this.projectViewOf(opened.project_id)
        this.emitIn(opened.project_id, "project.opened", view)
        return view
      },
      "projects.use": (params, ctx) => {
        requireHuman(ctx, "cambiar de proyecto")
        const p = params as Params<"projects.use">
        if (!repo.projectRoot(p.project_id))
          throw rpcError(ErrorCode.notFound, "el proyecto no existe")
        repo.touchProject(p.project_id)
        ctx.client.project_id = p.project_id
        return this.projectViewOf(p.project_id)
      },
      "projects.status": async (params, ctx) => {
        const p = params as Params<"projects.status">
        const pid = this.scopeOf(ctx, p.project_id)
        const root = repo.projectRoot(pid)
        if (!root) throw rpcError(ErrorCode.notFound, "el proyecto no existe")
        let gitStatus: RepoStatus | null = null
        try {
          gitStatus = await repoStatus(root)
        } catch (e) {
          if (!(e instanceof GitError)) throw e
        }
        return { project_id: pid, root_path: root, git: gitStatus }
      },
      "projects.set_vcs": this.mutation<Params<"projects.set_vcs">>(
        "projects.set_vcs",
        (p, uow, ctx) => {
          // Pasar a sin VCS pierde el aislamiento: lo confirma un humano (ADR-0010 §2).
          requireHuman(ctx, "cambiar el control de versiones del proyecto")
          const projectId = this.scopeOf(ctx, p.project_id)
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
      "approvals.list": (params, ctx) => {
        requireHuman(ctx, "revisar las aprobaciones")
        const p = params as Params<"approvals.list">
        return {
          approvals: repo
            .listApprovals(this.scopeOf(ctx), {
              ...(p.state ? { state: p.state } : {}),
              ...(p.include_resolved ? { includeResolved: true } : {}),
              ...(p.run_id ? { runId: p.run_id } : {}),
              ...(p.limit ? { limit: p.limit } : {}),
            })
            .map(({ operation_json, ...a }) => ({
              ...a,
              state: a.state as "pending" | "approved" | "denied" | "expired" | "consumed",
              operation: JSON.parse(operation_json) as unknown,
            })),
        }
      },
      "artifacts.read": (params, ctx) => {
        requireHuman(ctx, "leer artefactos")
        const p = params as Params<"artifacts.read">
        const sha = parseArtifactRef(p.ref) ?? (/^[0-9a-f]{64}$/.test(p.ref) ? p.ref : null)
        const row = sha ? this.artifacts.get(sha) : null
        if (!sha || !row) throw rpcError(ErrorCode.notFound, "el artefacto no existe")
        const offset = p.offset ?? 0
        let chunk: ReturnType<ArtifactStore["read"]>
        try {
          chunk = this.artifacts.read(sha, offset, p.length)
        } catch {
          this.artifacts.verify(sha)
          throw rpcError(ErrorCode.notFound, "los bytes del artefacto no están en disco")
        }
        // Al terminar de leer se comprueba el hash; uno que no coincide no se da por válido.
        const integrity = chunk.eof ? this.artifacts.verify(sha) : row.integrity
        return {
          sha256: sha,
          size: chunk.size,
          media_type: row.media_type,
          sensitivity: row.sensitivity,
          integrity,
          offset,
          data_base64: Buffer.from(chunk.data).toString("base64"),
          eof: chunk.eof,
        }
      },
      "evidence.list": (params, ctx) => {
        const p = params as Params<"evidence.list">
        if (!p.work_item_id && !p.run_id)
          throw rpcError(ErrorCode.invalidParams, "evidence.list necesita work_item_id o run_id")
        if (p.work_item_id) this.workItemIn(ctx, p.work_item_id)
        return { evidence: repo.listEvidence(p).map((e) => this.evidenceView(e)) }
      },
      "evidence.attach": this.mutation<Params<"evidence.attach">>(
        "evidence.attach",
        (p, uow, ctx) => {
          const actor = ctx.actor
          const agent = actor.kind === "agent" ? actor : null
          // Un agente sólo adjunta a su tarea y a su run, y sólo archivos de su worktree.
          const workItemId = agent ? agent.work_item_id : (p.work_item_id ?? null)
          const runId = agent ? agent.run_id : (p.run_id ?? null)
          if (agent && p.work_item_id && p.work_item_id !== agent.work_item_id)
            throw rpcError(ErrorCode.unauthorized, "el agente sólo adjunta evidencia a su tarea")
          if (!workItemId && !runId)
            throw rpcError(ErrorCode.invalidParams, "la evidencia necesita una tarea o un run")
          if (workItemId) this.workItemIn(ctx, workItemId)
          let bytes: Buffer
          let mediaType = p.media_type ?? "application/octet-stream"
          if (p.path !== undefined) {
            const base = agent?.run_id ? this.runCwd.get(agent.run_id) : null
            if (!agent || !base)
              throw rpcError(
                ErrorCode.invalidParams,
                "path sólo vale para un agente con worktree; el humano manda content_base64",
              )
            const full = resolve(base, p.path)
            const rel = relative(base, full)
            if (rel.startsWith("..") || isAbsolute(rel))
              throw rpcError(ErrorCode.unauthorized, "el archivo está fuera del worktree del run")
            try {
              bytes = readFileSync(full)
            } catch (e) {
              throw rpcError(
                ErrorCode.notFound,
                `no se puede leer ${p.path}: ${(e as Error).message}`,
              )
            }
            if (!p.media_type) mediaType = mediaTypeOf(full)
          } else if (p.content_base64 !== undefined) bytes = Buffer.from(p.content_base64, "base64")
          else throw rpcError(ErrorCode.invalidParams, "falta content_base64 o path")
          if (p.supersedes_id) {
            const old = repo.getEvidence(p.supersedes_id)
            if (!old || old.project_id !== uow.projectId)
              throw rpcError(ErrorCode.notFound, "la evidencia que se corrige no existe")
          }
          const stored = this.artifacts.put(bytes, mediaType, p.sensitivity ?? "internal")
          const row = repo.addEvidence({
            project_id: uow.projectId,
            work_item_id: workItemId,
            run_id: runId,
            kind: p.kind,
            title: p.title ?? null,
            artifact_ref: stored.ref,
            sha256: stored.sha256,
            metadata: p.metadata ?? {},
            // Procedencia (ADR-0012 §3): quién, cuándo, desde dónde y el hash de la entrada.
            provenance: {
              actor: actorOf(ctx),
              captured_at: nowIso(),
              source: p.path !== undefined ? { worktree_path: p.path } : { upload: true },
              input_sha256: stored.sha256,
            },
            created_by: actor.actor_id,
            supersedes_id: p.supersedes_id ?? null,
          })
          const view = this.evidenceView(row)
          uow.emit("evidence.attached", runId, view)
          return view
        },
      ),
      "semantic.list": (params, ctx) => {
        const p = params as Params<"semantic.list">
        if (p.work_item_id) this.workItemIn(ctx, p.work_item_id)
        return { events: this.semanticList(this.scopeOf(ctx), p) }
      },
      "semantic.rebuild": this.mutation<Params<"semantic.rebuild">>(
        "semantic.rebuild",
        (p, _uow, ctx) => {
          requireHuman(ctx, "reconstruir la proyección semántica")
          return { events: this.semantic.rebuild(this.scopeOf(ctx, p.project_id)) }
        },
      ),
      "retention.purge": this.mutation<Params<"retention.purge">>(
        "retention.purge",
        (p, uow, ctx) => {
          requireHuman(ctx, "purgar historia")
          return this.purge(this.scopeOf(ctx, p.project_id), p, uow.actorId)
        },
      ),
      "git.status": async (params, ctx) => {
        const p = params as Params<"git.status">
        const { runId, worktree } = this.worktreeFor(ctx, p.run_id)
        const files = await numstat(worktree, await changedFiles(worktree))
        return {
          run_id: runId,
          worktree,
          branch: await currentBranch(worktree),
          head: await headSha(worktree),
          files,
        }
      },
      "git.diff": async (params, ctx) => {
        const p = params as Params<"git.diff">
        const { worktree } = this.worktreeFor(ctx, p.run_id)
        const all = await changedFiles(worktree)
        const wanted = p.paths?.length ? all.filter((f) => p.paths?.includes(f.path)) : all
        const diff = await unifiedDiff(worktree, wanted)
        return {
          diff: diff.slice(0, DIFF_INLINE_MAX),
          truncated: diff.length > DIFF_INLINE_MAX,
          files: await numstat(worktree, wanted),
        }
      },
      "git.propose": async (params, ctx) => {
        // El plan (diff, hashes, ramas protegidas) se arma fuera de la transacción;
        // dentro sólo se registra la aprobación y sus eventos.
        const p = params as Params<"git.propose">
        const { runId, worktree } = this.worktreeFor(ctx, p.run_id)
        const run = repo.getRun(runId) as RunRow
        const item = repo.getWorkItem(run.work_item_id)
        // ADR-0022 §2: una subtarea no se publica; su cierre es integrarla a la feature.
        if (item?.parent_work_item_id && (p.push || p.pr))
          throw rpcError(
            ErrorCode.invalidParams,
            "una subtarea no hace push ni PR: su cierre es integrarse a la rama de la feature; propone sólo el commit",
          )
        let built: Awaited<ReturnType<typeof buildPlan>>
        try {
          built = await buildPlan(this.gitPlanDeps(), run, worktree, p)
        } catch (e) {
          throw rpcError(ErrorCode.invalidParams, e instanceof Error ? e.message : String(e))
        }
        const autoBlocker = item ? this.autoIntegrable(item, built.plan) : "sin tarea"
        const feat = item?.parent_work_item_id ? this.featureOf(item.parent_work_item_id) : null
        return this.mutation<Params<"git.propose">>("git.propose", (_p, uow) => {
          // ADR-0020 §3: un plan no vence solo; sólo con el límite que fije el humano. Lo que
          // protege es la revalidación al ejecutar (ADR-0015 §3), no el reloj.
          const timeout = this.settingsView().approvals.timeout_ms
          const expires = timeout ? new Date(Date.now() + timeout).toISOString() : null
          // Un plan nuevo reemplaza al que esperaba: nunca hay dos planes vivos por tarea.
          for (const old of repo.gitPlansFor(run.work_item_id))
            if (old.state === "pending") {
              repo.setApproval(old.id, "expired", null)
              uow.emit("git.plan.expired", old.run_id, {
                plan_id: old.id,
                reason: "lo reemplazó un plan nuevo",
              })
            }
          const planId = repo.createApproval({
            project_id: run.project_id,
            run_id: run.id,
            operation_hash: built.plan_hash,
            operation: { tool: "git.plan", input: built.plan, run_id: run.id },
            expires_at: expires,
          })
          uow.emit("approval.requested", run.id, {
            approval_id: planId,
            operation_hash: built.plan_hash,
            tool: "git.plan",
            input: built.plan,
            expires_at: expires,
          })
          uow.emit("git.plan.proposed", run.id, {
            plan_id: planId,
            plan_hash: built.plan_hash,
            operations: built.plan.operations.map((o) => o.op),
          })
          // ADR-0022 §2: con las tres condiciones comprobadas, se integra sin preguntar a
          // nombre de quien eligió la integración automática al aprobar el diseño.
          if (feat?.auto_integrate && autoBlocker === null) {
            repo.setApproval(planId, "approved", feat.approved_by)
            uow.emit("approval.resolved", run.id, {
              approval_id: planId,
              decision: "approved",
              auto: "feature.auto_integrate",
            })
            uow.emit("git.plan.approved", run.id, {
              plan_id: planId,
              plan_hash: built.plan_hash,
              auto: true,
            })
            uow.afterCommit(() => this.track(this.runGitPlan(planId, built.plan)))
          } else if (feat?.auto_integrate)
            uow.emit("feature.auto_integrate_skipped", run.id, {
              work_item_id: item?.parent_work_item_id,
              subtask_id: item?.id,
              reason: autoBlocker,
            })
          return { plan_id: planId, plan_hash: built.plan_hash, plan: built.plan }
        })(params, ctx)
      },
      "git.plan_status": (params, ctx) => {
        const p = params as Params<"git.plan_status">
        const a = repo.getApproval(p.plan_id)
        const op = a ? (JSON.parse(a.operation_json) as { tool?: string }) : null
        if (!a || op?.tool !== "git.plan") throw rpcError(ErrorCode.notFound, "el plan no existe")
        if (ctx.actor.kind === "agent" && ctx.actor.run_id !== a.run_id)
          throw rpcError(ErrorCode.notFound, "el plan no existe")
        return { plan_id: a.id, ...this.gitPlanState(a.id, a.state, a.expires_at) }
      },
      "context.search": (params, ctx) => {
        const p = params as Params<"context.search">
        return searchContext(this.store.db, this.scopeOf(ctx), p)
      },
      "context.project": (_params, ctx) => {
        const pid = this.scopeOf(ctx)
        const root = repo.projectRoot(pid) ?? this.rootPath
        return { root, ...projectContext(root) }
      },
      "connections.list": (_params, ctx) => {
        requireHuman(ctx, "ver las conexiones")
        const pid = this.scopeOf(ctx)
        return { connections: this.broker.connections(pid).map((c) => this.broker.view(c)) }
      },
      "connections.add": async (params, ctx) => {
        requireHuman(ctx, "dar de alta una conexión")
        const p = params as Params<"connections.add">
        // ADR-0025: el secreto entra al vault antes de la fila; la mutación sólo lo enlaza.
        const vaultId = p.secret_value
          ? await this.vaultPut({
              project_id: this.scopeOf(ctx),
              kind: p.auth_method === "file" ? "passphrase" : "password",
              label: p.name,
              value: p.secret_value,
              actor: ctx.actor.actor_id,
            })
          : null
        try {
          return await this.mutation<Params<"connections.add">>("connections.add", (q, uow) => {
            const c = brokerCall(() =>
              this.broker.add({
                project_id: uow.projectId,
                name: q.name,
                type: q.type,
                environment: q.environment,
                config: q.config,
                secret_ref: q.secret_ref,
                secret_ref_ro: q.secret_ref_ro,
                server_guarantee: q.server_guarantee,
                auth_method: q.auth_method,
                vault_item_id: vaultId,
                tags: q.tags,
              }),
            )
            const view = this.broker.view(c)
            uow.emit("connection.added", null, view)
            if (q.setup_request_id)
              this.answerSetup(uow, q.setup_request_id, { connection_id: c.id })
            return view
          })(params, ctx)
        } catch (e) {
          if (vaultId) this.vault.remove(vaultId, ctx.actor.actor_id)
          throw e
        }
      },
      "connections.update": async (params, ctx) => {
        requireHuman(ctx, "cambiar una conexión")
        const p = params as Params<"connections.update">
        const conn = brokerCall(() => this.broker.find(this.scopeOf(ctx), p.connection_id))
        const method = p.auth_method ?? conn.auth_method ?? null
        let vaultId: string | null | undefined
        if (p.secret_value) {
          if (conn.vault_item_id) {
            await this.vaultCall(() =>
              this.vault.rotate(
                conn.vault_item_id as string,
                p.secret_value as string,
                ctx.actor.actor_id,
              ),
            )
            vaultId = conn.vault_item_id
          } else
            vaultId = await this.vaultPut({
              project_id: conn.project_id,
              kind: method === "file" ? "passphrase" : "password",
              label: conn.name,
              value: p.secret_value,
              actor: ctx.actor.actor_id,
            })
        } else if (p.forget_secret && conn.vault_item_id) {
          this.vault.remove(conn.vault_item_id, ctx.actor.actor_id)
          vaultId = null
        }
        return this.mutation<Params<"connections.update">>("connections.update", (q, uow) => {
          const config = JSON.parse(conn.config_json) as Record<string, unknown>
          const c = this.broker.update(conn, {
            ...(q.environment ? { environment: q.environment } : {}),
            ...(q.auth_method ? { auth_method: q.auth_method } : {}),
            ...(vaultId !== undefined ? { vault_item_id: vaultId } : {}),
            ...(q.tags ? { tags: q.tags } : {}),
            ...(q.server_guarantee !== undefined ? { server_guarantee: q.server_guarantee } : {}),
            ...(q.identity_file !== undefined
              ? { config: { ...config, identity_file: q.identity_file || undefined } }
              : {}),
          })
          const view = this.broker.view(c)
          uow.emit("connection.updated", null, view)
          return view
        })(params, ctx)
      },
      "connections.generate_key": async (params, ctx) => {
        requireHuman(ctx, "generar una llave")
        const p = params as Params<"connections.generate_key">
        const conn = brokerCall(() => this.broker.find(this.scopeOf(ctx), p.connection_id))
        if (conn.conn_type !== "ssh")
          throw rpcError(ErrorCode.invalidParams, "sólo una conexión SSH lleva llave")
        const project = this.repo.listProjects().find((x) => x.id === conn.project_id)
        const key = generateEd25519(`keel/${project?.name ?? "proyecto"}/${conn.name}`)
        const id = await this.vaultCall(async () => {
          if (conn.vault_item_id && conn.auth_method === "key") {
            await this.vault.rotate(
              conn.vault_item_id,
              key.privatePem,
              ctx.actor.actor_id,
              key.publicLine,
            )
            return conn.vault_item_id
          }
          return this.vault.put({
            project_id: conn.project_id,
            kind: "ssh_key",
            label: conn.name,
            value: key.privatePem,
            public_key: key.publicLine,
            actor: ctx.actor.actor_id,
          })
        })
        const view = await this.mutation<Params<"connections.generate_key">>(
          "connections.generate_key",
          (_q, uow) => {
            const c = this.broker.update(conn, { auth_method: "key", vault_item_id: id })
            const v = this.broker.view(c)
            uow.emit("connection.updated", null, v)
            return v
          },
        )(params, ctx)
        return {
          connection: view,
          public_key: key.publicLine,
          authorized_keys: authorizedKeysLine(key.publicLine, {
            command: p.command ?? null,
            from: p.from ?? null,
          }),
        }
      },
      "connections.import_key_file": async (params, ctx) => {
        requireHuman(ctx, "importar una llave")
        const p = params as Params<"connections.import_key_file">
        const conn = brokerCall(() => this.broker.find(this.scopeOf(ctx), p.connection_id))
        // ADR-0025 §9: sólo el archivo que el humano eligió; Keel no recorre ~/.ssh.
        const path = p.path.replace(/^~(?=\/)/, homedir())
        if (!existsSync(path)) throw rpcError(ErrorCode.notFound, `no existe ${p.path}`)
        const pem = readFileSync(path, "utf8")
        if (!/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(pem))
          throw rpcError(ErrorCode.invalidParams, "ese archivo no es una llave privada")
        const pub = existsSync(`${path}.pub`) ? readFileSync(`${path}.pub`, "utf8").trim() : null
        const id = await this.vaultPut({
          project_id: conn.project_id,
          kind: "ssh_key",
          label: conn.name,
          value: pem,
          public_key: pub,
          actor: ctx.actor.actor_id,
        })
        return this.mutation<Params<"connections.import_key_file">>(
          "connections.import_key_file",
          (_q, uow) => {
            const c = this.broker.update(conn, { auth_method: "key", vault_item_id: id })
            const v = this.broker.view(c)
            uow.emit("connection.updated", null, v)
            uow.emit("vault.key_imported", null, {
              connection_id: conn.id,
              item_id: id,
              path: p.path,
              actor: actorOf(ctx),
            })
            return v
          },
        )(params, ctx)
      },
      "connections.import_preview": async (_params, ctx) => {
        requireHuman(ctx, "importar conexiones")
        return { hosts: await importSshConfig() }
      },
      "connections.import": async (params, ctx) => {
        requireHuman(ctx, "importar conexiones")
        const p = params as Params<"connections.import">
        // Las huellas que el humano ya aceptó en su known_hosts siembran las de Keel.
        const seeds = new Map<string, string | null>()
        for (const h of p.hosts) {
          const line = (await knownHostLines(h.host, h.port))[0] ?? null
          seeds.set(h.alias, line ? JSON.stringify({ line, ...(await fingerprint(line)) }) : null)
        }
        return this.mutation<Params<"connections.import">>("connections.import", (q, uow) => {
          const out = q.hosts.map((h) => {
            const c = brokerCall(() =>
              this.broker.add({
                project_id: uow.projectId,
                name: h.alias,
                type: "ssh",
                environment: h.environment,
                config: {
                  host: h.host,
                  ...(h.user ? { user: h.user } : {}),
                  port: h.port,
                  ...(h.proxy_jump ? { proxy_jump: h.proxy_jump } : {}),
                  ...(h.identity_file ? { identity_file: h.identity_file } : {}),
                },
                auth_method: h.identity_file ? "file" : "agent",
                host_key: seeds.get(h.alias) ?? null,
              }),
            )
            const v = this.broker.view(c)
            uow.emit("connection.added", null, { ...v, imported_from: "~/.ssh/config" })
            return v
          })
          return { connections: out }
        })(params, ctx)
      },
      "connections.host_keys": async (params, ctx) => {
        requireHuman(ctx, "revisar la huella de un host")
        const p = params as Params<"connections.host_keys">
        const conn = brokerCall(() => this.broker.find(this.scopeOf(ctx), p.connection_id))
        const cfg = JSON.parse(conn.config_json) as { host?: string; port?: number }
        if (!cfg.host) throw rpcError(ErrorCode.invalidParams, "la conexión no tiene host")
        return {
          keys: await scanHostKeys(cfg.host, Number(cfg.port ?? 22)),
          accepted: this.broker.view(conn).host_key ?? null,
        }
      },
      "connections.host_key_accept": async (params, ctx) => {
        requireHuman(ctx, "aceptar la huella de un host")
        const p = params as Params<"connections.host_key_accept">
        const fp = await fingerprint(p.line)
        if (!fp.fingerprint)
          throw rpcError(ErrorCode.invalidParams, "esa línea no es una llave de host")
        return this.mutation<Params<"connections.host_key_accept">>(
          "connections.host_key_accept",
          (q, uow) => {
            const conn = brokerCall(() => this.broker.find(uow.projectId, q.connection_id))
            const c = this.broker.update(conn, {
              host_key: JSON.stringify({ line: q.line, ...fp }),
            })
            const v = this.broker.view(c)
            uow.emit("connection.host_key_accepted", null, {
              connection_id: c.id,
              fingerprint: fp.fingerprint,
              type: fp.type,
              actor: actorOf(ctx),
            })
            return v
          },
        )(params, ctx)
      },
      "connections.ssh_session": async (params, ctx) => {
        requireHuman(ctx, "abrir una terminal")
        const p = params as Params<"connections.ssh_session">
        const conn = brokerCall(() => this.broker.find(this.scopeOf(ctx), p.connection))
        try {
          const s = await this.credentials.humanSession(conn)
          this.emitSystem("connection.terminal_opened", null, {
            connection_id: conn.id,
            environment: conn.environment,
            actor: actorOf(ctx),
          })
          return { connection: this.broker.view(conn), ...s }
        } catch (e) {
          throw brokerFailure(e)
        }
      },
      "projects.base_check": async (params, ctx) => {
        requireHuman(ctx, "consultar la rama base")
        const p = params as Params<"projects.base_check">
        const pid = this.scopeOf(ctx, p.project_id)
        const root = repo.projectRoot(pid) ?? this.rootPath
        const g = this.credentials.gitEnv(pid, this.noAskpassPath())
        try {
          return await checkBase(root, g.env)
        } finally {
          g.done()
        }
      },
      "projects.pull": async (params, ctx) => {
        requireHuman(ctx, "actualizar la rama base")
        const p = params as Params<"projects.pull">
        const pid = this.scopeOf(ctx, p.project_id)
        const root = repo.projectRoot(pid) ?? this.rootPath
        const g = this.credentials.gitEnv(pid, this.noAskpassPath())
        try {
          const state = await pullBase(root, g.env)
          this.emitSystem("project.pulled", null, {
            project_id: pid,
            branch: state.branch,
            upstream: state.upstream,
            behind: state.behind,
            actor: actorOf(ctx),
          })
          return state
        } catch (e) {
          throw rpcError(ErrorCode.conflict, e instanceof Error ? e.message : String(e))
        } finally {
          g.done()
        }
      },
      "vault.status": (_params, ctx) => {
        requireHuman(ctx, "ver el vault")
        return this.vault.status()
      },
      "vault.unlock": async (params, ctx) => {
        requireHuman(ctx, "abrir el vault")
        const p = params as Params<"vault.unlock">
        await this.vaultCall(() => this.vault.unlock(p.passphrase))
        this.emitSystem("vault.unlocked", null, { actor: actorOf(ctx), keystore: "passphrase" })
        return this.vault.status()
      },
      "secrets.askpass": async (params) => {
        const p = params as Params<"secrets.askpass">
        return this.vaultCall(() => this.credentials.askpass(p.token, p.prompt))
      },
      "secrets.remember": async (params, ctx) => {
        const p = params as Params<"secrets.remember">
        await this.vaultCall(() =>
          this.credentials.remember(p.token, p.value, p.scope, ctx.actor.actor_id),
        )
        return { ok: true as const }
      },
      "secrets.prompt_answer": (params, ctx) => {
        requireHuman(ctx, "contestar una pregunta de secreto")
        const p = params as Params<"secrets.prompt_answer">
        try {
          this.credentials.answer(
            p.prompt_id,
            p.cancel || !p.value
              ? null
              : { value: p.value, remember: p.remember, actor: ctx.actor.actor_id },
          )
        } catch (e) {
          throw rpcError(ErrorCode.notFound, e instanceof Error ? e.message : String(e))
        }
        return { ok: true as const }
      },
      "setup.request": async (params, ctx) => {
        const p = params as Params<"setup.request">
        const actor = ctx.actor
        if (actor.kind !== "agent" || !actor.run_id)
          throw rpcError(ErrorCode.unauthorized, "setup.request es para el agente de un run")
        // ADR-0025 §6: el agente nunca pasa secretos ni pide quitar la pregunta en prod.
        const bad = Object.keys(p.proposal).filter((k) =>
          /pass|secret|token|private|key_?material|credential/i.test(k),
        )
        if (bad.length)
          throw rpcError(
            ErrorCode.invalidParams,
            `«${bad.join(", ")}» parece un secreto: el agente no pasa secretos; describe qué falta y el humano lo guarda en el vault (o usa una referencia)`,
          )
        if (
          p.kind === "grant" &&
          p.proposal.policy === "auto" &&
          (p.proposal.environment === "prod" ||
            this.broker
              .connections(this.scopeOf(ctx))
              .find((c) => c.id === p.proposal.connection || c.name === p.proposal.connection)
              ?.environment === "prod")
        )
          throw rpcError(
            ErrorCode.invalidParams,
            "quitar la pregunta en producción es una decisión del humano en la conexión (ADR-0026); pide el grant en ask",
          )
        const decision = await this.askHuman(this.scopeOf(ctx), actor.run_id, {
          tool: "setup.request",
          input: { kind: p.kind, why: p.why, proposal: p.proposal, evidence: p.evidence ?? null },
        })
        const message = this.setupMessages.get(actor.run_id) ?? null
        this.setupMessages.delete(actor.run_id)
        return {
          approval_id: "",
          state: decision,
          message:
            decision === "approved"
              ? (message ?? "el humano lo dejó listo")
              : decision === "denied"
                ? `el humano no lo configuró${message ? `: ${message}` : ""}. No vuelvas a pedirlo en este turno.`
                : "nadie contestó a tiempo",
        }
      },
      "connections.archive": this.mutation<Params<"connections.archive">>(
        "connections.archive",
        (p, uow, ctx) => {
          requireHuman(ctx, "archivar una conexión")
          brokerCall(() => this.broker.archive(uow.projectId, p.connection_id))
          uow.emit("connection.archived", null, { connection_id: p.connection_id })
          return { connection_id: p.connection_id, archived: true as const }
        },
      ),
      "grants.set": this.mutation<Params<"grants.set">>("grants.set", (p, uow, ctx) => {
        requireHuman(ctx, "cambiar los permisos de una conexión")
        const conn = brokerCall(() => this.broker.find(uow.projectId, p.connection_id))
        const r = brokerCall(() =>
          this.broker.setGrant(conn, p.operation, p.policy, uow.actorId, p.expires_at ?? null, {
            riskConfirm: p.risk_confirm,
          }),
        )
        const view = this.broker.view(conn)
        uow.emit("grant.set", null, {
          connection_id: conn.id,
          operation: p.operation,
          policy: p.policy,
        })
        // ADR-0026: quitar la pregunta en prod queda a nombre de quien asumió el riesgo.
        if (r.risk_accepted)
          uow.emit("grant.risk_accepted", null, {
            connection_id: conn.id,
            connection_name: conn.name,
            operation: p.operation,
            environment: conn.environment,
            actor: actorOf(ctx),
          })
        return view
      }),
      "resources.list": (_params, ctx) => {
        const pid = this.scopeOf(ctx)
        return { connections: this.broker.connections(pid).map((c) => this.broker.view(c)) }
      },
      "resources.execute": async (params, ctx) => {
        const p = params as Params<"resources.execute">
        const actor = ctx.actor
        const agent = actor.kind === "agent" ? actor : null
        try {
          return await this.broker.execute(
            {
              projectId: this.scopeOf(ctx),
              runId: agent ? agent.run_id : null,
              workItemId: agent ? agent.work_item_id : null,
              actor: actorOf(ctx),
            },
            p,
          )
        } catch (e) {
          throw brokerFailure(e)
        }
      },
      "plugins.install": this.mutation<Params<"plugins.install">>(
        "plugins.install",
        (p, uow, ctx) => {
          requireHuman(ctx, "instalar un plugin")
          let row: ReturnType<PluginHost["install"]>
          try {
            row = this.plugins.install(p.path, uow.actorId)
          } catch (e) {
            throw rpcError(ErrorCode.invalidParams, e instanceof Error ? e.message : String(e))
          }
          const view = this.plugins.view(row)
          uow.emit("plugin.installed", null, {
            id: view.id,
            version: view.version,
            sha256: view.sha256,
          })
          return view
        },
      ),
      "plugins.list": (_params, ctx) => {
        requireHuman(ctx, "ver los plugins")
        return { plugins: this.plugins.installed().map((p) => this.plugins.view(p)) }
      },
      "plugins.uninstall": this.mutation<Params<"plugins.uninstall">>(
        "plugins.uninstall",
        (p, uow, ctx) => {
          requireHuman(ctx, "desinstalar un plugin")
          if (!this.plugins.uninstall(p.id))
            throw rpcError(ErrorCode.notFound, "el plugin no está instalado")
          uow.emit("plugin.uninstalled", null, { id: p.id })
          return { id: p.id, uninstalled: true as const }
        },
      ),
      "artifacts.put": this.mutation<Params<"artifacts.put">>("artifacts.put", (p, _uow, ctx) => {
        requireHuman(ctx, "guardar un artefacto")
        const stored = this.artifacts.put(Buffer.from(p.content_base64, "base64"), p.media_type)
        return { ref: stored.ref, sha256: stored.sha256, size: stored.size }
      }),
      "research.claim_add": this.mutation<Params<"research.claim_add">>(
        "research.claim_add",
        (p, uow, ctx) => {
          const agent = ctx.actor.kind === "agent" ? ctx.actor : null
          const workItemId = agent ? agent.work_item_id : (p.work_item_id ?? null)
          if (!workItemId)
            throw rpcError(ErrorCode.invalidParams, "falta la tarea de la investigación")
          if (agent && p.work_item_id && p.work_item_id !== agent.work_item_id)
            throw rpcError(
              ErrorCode.unauthorized,
              "el agente sólo escribe en la investigación de su tarea",
            )
          this.workItemIn(ctx, workItemId)
          const claim = researchCall(() =>
            this.research.add({
              work_item_id: workItemId,
              kind: p.kind,
              statement: p.statement,
              evidence_ids: p.evidence_ids ?? [],
              created_by: ctx.actor.actor_id,
              run_id: agent?.run_id ?? null,
            }),
          )
          uow.emit("research.claim_added", agent?.run_id ?? null, claim)
          return claim
        },
      ),
      "research.claim_decide": this.mutation<Params<"research.claim_decide">>(
        "research.claim_decide",
        (p, uow, ctx) => {
          // Un agente puede proponer, no decidir (ADR-0016 §2).
          requireHuman(ctx, "verificar o refutar una afirmación")
          const claim = researchCall(() =>
            this.research.decide(p.claim_id, p.decision, uow.actorId, p.reason ?? null),
          )
          uow.emit("research.claim_decided", null, claim)
          return claim
        },
      ),
      "research.claims_list": (params, ctx) => {
        const p = params as Params<"research.claims_list">
        const agent = ctx.actor.kind === "agent" ? ctx.actor : null
        const workItemId = agent ? agent.work_item_id : (p.work_item_id ?? null)
        if (!workItemId)
          throw rpcError(ErrorCode.invalidParams, "falta la tarea de la investigación")
        this.workItemIn(ctx, workItemId)
        return { claims: this.research.list(workItemId) }
      },
      "research.report_generate": async (params, ctx) => {
        requireHuman(ctx, "generar un reporte")
        const p = params as Params<"research.report_generate">
        this.workItemIn(ctx, p.work_item_id)
        let out: Awaited<ReturnType<Research["generate"]>>
        try {
          out = await this.research.generate(p.work_item_id, ctx.actor.actor_id)
        } catch (e) {
          throw researchFailure(e)
        }
        const view = { ...reportView(out.report), reused: out.reused }
        if (!out.reused)
          this.emitIn(out.report.project_id, "research.report_generated", {
            ...view,
            markdown: undefined,
          })
        return view
      },
      "research.reports_list": (params, ctx) => {
        requireHuman(ctx, "ver los reportes")
        const p = params as Params<"research.reports_list">
        this.workItemIn(ctx, p.work_item_id)
        return {
          reports: this.research
            .reports(p.work_item_id)
            .map((r) => ({ ...reportView(r), reused: false })),
        }
      },
      "research.report_export": (params, ctx) => {
        requireHuman(ctx, "exportar un reporte")
        const p = params as Params<"research.report_export">
        const r = this.research.report(p.report_id)
        if (!r) throw rpcError(ErrorCode.notFound, "el reporte no existe")
        return this.research.export(r, p.format, p.include_restricted ?? false)
      },
      "permissions.rules_list": (params, ctx) => {
        requireHuman(ctx, "revisar las reglas de permiso")
        const p = params as Params<"permissions.rules_list">
        return {
          rules: repo
            .listPermissionRules(this.scopeOf(ctx), p.include_revoked ?? false)
            .map(ruleView),
        }
      },
      "permissions.rule_add": this.mutation<Params<"permissions.rule_add">>(
        "permissions.rule_add",
        (p, uow, ctx) => {
          requireHuman(ctx, "crear una regla de permiso")
          const rule = repo.addPermissionRule({
            project_id: uow.projectId,
            tool: p.tool,
            prefix: p.prefix ?? null,
            exact: p.exact ?? false,
            effect: p.effect,
            created_by: uow.actorId,
            expires_at: p.expires_at ?? null,
          })
          const view = ruleView(rule)
          uow.emit("permission.rule_added", null, view)
          return view
        },
      ),
      "permissions.rule_revoke": this.mutation<Params<"permissions.rule_revoke">>(
        "permissions.rule_revoke",
        (p, uow, ctx) => {
          requireHuman(ctx, "revocar una regla de permiso")
          const old = repo.getPermissionRule(p.rule_id)
          if (!old) throw rpcError(ErrorCode.notFound, "la regla no existe")
          const rule = repo.revokePermissionRule(p.rule_id, uow.actorId) as PermissionRuleRow
          const view = ruleView(rule)
          uow.emit("permission.rule_revoked", null, view)
          return view
        },
      ),
      "settings.get": () => this.settingsView(),
      "settings.codex_subscription_set": this.mutation<Params<"settings.codex_subscription_set">>(
        "settings.codex_subscription_set",
        (p, uow, ctx) => {
          requireHuman(ctx, "cambiar el uso de la suscripción de Codex")
          repo.setSetting(CODEX_SUBSCRIPTION, p.enabled, uow.actorId)
          const view = this.settingsView()
          uow.emit("settings.changed", null, view)
          return view
        },
      ),
      "settings.update": this.mutation<Params<"settings.update">>(
        "settings.update",
        (p, uow, ctx) => {
          requireHuman(ctx, "cambiar los ajustes")
          if (p.approvals_timeout_ms !== undefined)
            repo.setSetting(APPROVALS_TIMEOUT, p.approvals_timeout_ms, uow.actorId)
          if (p.prompt_suggestions !== undefined)
            repo.setSetting(PROMPT_SUGGESTIONS, p.prompt_suggestions, uow.actorId)
          if (p.default_model) {
            const prev = (repo.getSetting(DEFAULT_MODELS)?.value ?? {}) as DefaultModels
            const { [p.default_model.provider]: _, ...rest } = prev
            repo.setSetting(
              DEFAULT_MODELS,
              p.default_model.model === null
                ? rest
                : {
                    ...rest,
                    [p.default_model.provider]: {
                      model: p.default_model.model,
                      effort: p.default_model.effort ?? null,
                    },
                  },
              uow.actorId,
            )
          }
          // ADR-0002 regla 3: el humano sube, baja o quita (null) los límites; queda a su nombre.
          if (p.limits) {
            const prev = (repo.getSetting(LIMITS)?.value ?? {}) as Partial<Limits>
            const micro = (usd: number | null) => (usd === null ? null : Math.round(usd * 1e6))
            repo.setSetting(
              LIMITS,
              {
                ...prev,
                ...(p.limits.run_budget_usd !== undefined
                  ? { run_budget_micro_usd: micro(p.limits.run_budget_usd) }
                  : {}),
                ...(p.limits.daily_budget_usd !== undefined
                  ? { daily_budget_micro_usd: micro(p.limits.daily_budget_usd) }
                  : {}),
                ...(p.limits.max_concurrent_runs !== undefined
                  ? { max_concurrent_runs: p.limits.max_concurrent_runs }
                  : {}),
              },
              uow.actorId,
            )
            uow.emit("limits.changed", null, { limits: this.limits, actor: actorOf(ctx) })
          }
          const view = this.settingsView()
          uow.emit("settings.changed", null, view)
          return view
        },
      ),
      "providers.models": async (params) => {
        const p = params as Params<"providers.models">
        if (p.provider === "claude") {
          const models = await this.claude.listModels(this.profile)
          if (models) return { models, source: "sdk" as const }
        }
        const fallback = p.provider === "claude" ? this.profile.model : this.codexProfile.model
        return {
          models: fallback
            ? [
                {
                  value: fallback,
                  display_name: fallback,
                  description: "el del perfil",
                  efforts: [],
                },
              ]
            : [],
          source: "profile" as const,
        }
      },
      "approvals.resolve": this.mutation<Params<"approvals.resolve">>(
        "approvals.resolve",
        (p, uow, ctx) => {
          const a = repo.getApproval(p.approval_id)
          if (!a) throw rpcError(ErrorCode.notFound, "aprobación no existe")
          if (a.operation_hash !== p.operation_hash)
            throw rpcError(
              ErrorCode.conflict,
              "el hash de la operación no coincide: la solicitud cambió",
            )
          if (a.state !== "pending")
            throw rpcError(ErrorCode.invalidTransition, `la aprobación está ${a.state}`)
          // ADR-0015: un plan de git se aprueba una vez y se ejecuta revalidando.
          const op = JSON.parse(a.operation_json) as { tool?: string; input?: unknown }
          if (op.tool === "git.plan") return this.resolveGitPlan(uow, a, op.input, p.decision)
          // ADR-0021: un gate del método mueve la etapa; no es un permiso de herramienta.
          if (op.tool === "stage.gate") {
            requireHuman(ctx, "decidir un gate del método")
            return this.resolveStageGate(uow, a, op.input, p)
          }
          // ADR-0020 §7: una pregunta se contesta o se rechaza; no hay «sesión» ni «siempre».
          if (op.tool && QUESTION_TOOLS.has(op.tool))
            return this.resolveQuestion(uow, a, op.tool, p)
          // ADR-0025 §6: lo que pidió el agente queda listo (o no) con lo que hizo el humano.
          if (op.tool === "setup.request") {
            requireHuman(ctx, "contestar una petición del agente")
            if (p.decision === "deny") {
              this.setupMessages.set(a.run_id, p.reason ?? "")
              repo.setApproval(a.id, "denied", uow.actorId)
              uow.emit("approval.resolved", a.run_id, { approval_id: a.id, decision: "denied" })
              uow.afterCommit(() => this.approvalWaiters.get(a.id)?.({ decision: "denied" }))
              return { approval_id: a.id, state: "denied" as const }
            }
            return this.answerSetup(uow, a.id, p.setup_result ?? {})
          }
          // ADR-0025 §7: una operación de recurso se aprueba esta vez, para esta tarea
          // (una hora) o para el proyecto (un grant); en prod, el proyecto pide el riesgo
          // en la conexión (ADR-0026).
          if (
            op.tool?.startsWith("resource.") &&
            p.decision !== "approve_once" &&
            p.decision !== "deny"
          ) {
            const input = (op.input ?? {}) as { connection?: string; operation?: string }
            const conn = brokerCall(() =>
              this.broker.find(a.project_id, String(input.connection ?? "")),
            )
            const run = repo.getRun(a.run_id)
            if (p.decision === "approve_always" && conn.environment === "prod")
              throw rpcError(
                ErrorCode.invalidParams,
                "en producción, quitar la pregunta para todo el proyecto se hace en la conexión, escribiendo su nombre (ADR-0026)",
              )
            brokerCall(() =>
              this.broker.setGrant(
                conn,
                String(input.operation ?? ""),
                "auto",
                uow.actorId,
                p.decision === "approve_session"
                  ? new Date(Date.now() + 60 * 60_000).toISOString()
                  : null,
                p.decision === "approve_session" && run ? { workItemId: run.work_item_id } : {},
              ),
            )
            uow.emit("grant.set", a.run_id, {
              connection_id: conn.id,
              operation: input.operation,
              policy: "auto",
              scope: p.decision === "approve_session" ? "task" : "project",
            })
          }
          const decision =
            p.decision === "approve_once" ||
            p.decision === "approve_session" ||
            p.decision === "approve_always"
              ? "approved"
              : "denied"
          // ADR-0019 §4: recordar lo aprobado, para el run o para el proyecto. ADR-0020 §2:
          // el humano puede corregir el patrón, pero tiene que cubrir lo que se pidió.
          let pattern: PermissionPattern | null = null
          if (p.decision === "approve_session" || p.decision === "approve_always") {
            const op = JSON.parse(a.operation_json) as { tool: string; input: unknown }
            pattern =
              p.pattern === undefined
                ? patternFor(op.tool, op.input)
                : parsePattern(op.tool, p.pattern)
            if (!pattern)
              throw rpcError(
                ErrorCode.invalidParams,
                "patrón no válido: usa la orden exacta o un prefijo sin ;, &&, | ni redirecciones seguido de « *» (para todo el shell, el modo bypass)",
              )
            if (!matchesPattern(pattern, op.tool, op.input))
              throw rpcError(ErrorCode.invalidParams, "el patrón no cubre la operación pedida")
          }
          repo.setApproval(a.id, decision, uow.actorId)
          if (pattern) {
            if (p.decision === "approve_always") {
              const rule = repo.addPermissionRule({
                project_id: a.project_id,
                ...pattern,
                effect: "auto",
                created_by: uow.actorId,
                source_approval_id: a.id,
              })
              uow.emit("permission.rule_added", a.run_id, ruleView(rule))
            } else {
              const granted = pattern
              uow.afterCommit(() => this.toolGate.grantSession(a.run_id, granted, a.id))
            }
          }
          const reason = p.reason
          uow.afterCommit(() =>
            this.approvalWaiters.get(a.id)?.({ decision, ...(reason ? { reason } : {}) }),
          )
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
      budget_micro_usd?: number | null
      provider?: string
      options?: RunOptionsRecord
    }
    const opt = manifest.options
    const env = agentEnv(run, item, manifest.provider === "codex" ? "Codex" : "Claude")
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
            JSON.parse(current.context_manifest_json) as { budget_micro_usd?: number | null }
          ).budget_micro_usd
          const mcp_servers = this.keelMcpServer(current)
          const flow = this.repo.getFlow(item.id)
          const profile =
            this.profileOf(run.project_id) ?? (await this.detectedProfile(run.project_id))
          // ADR-0017 §1: el prompt lleva sólo un encabezado; el resto lo pide el agente.
          // ADR-0021: con el método, el encabezado dice la etapa y cómo avanzar.
          if (Object.keys(mcp_servers).length > 0)
            prompt =
              item.dedupe_key === CONVERSATION_KEY
                ? `${conversationHeader()}\n\n${prompt}`
                : `${promptHeader(item)}${flow ? `\n${stageInstructions(flow, profile)}${flow.stage === "close" ? this.gitPlanNote(item.id) : ""}` : ""}${featureHeader(this.featureOf(item.id), item.parent_work_item_id ? this.featureOf(item.parent_work_item_id) : null)}\n\n${prompt}`
          // Planear y revisar son sólo lectura también para el SDK (ADR-0021 §3).
          const readOnly =
            run.purpose !== "execute" || (flow !== null && isReadOnlyStage(flow.stage))
          // ADR-0008 §7: el presupuesto en USD no aplica a Codex (sólo reporta tokens).
          this.runCwd.set(run.id, ws.cwd)
          const sandbox = useCodex ? null : await this.sandboxFor(run, ws.cwd)
          final = useCodex
            ? await this.codex.execute(ctx, prompt, {
                ...this.codexProfile,
                subscription_enabled: this.settingsView().codex_subscription.enabled,
                ...(opt ? { model: opt.model, permission_mode: opt.permission_mode } : {}),
                ...(opt?.effort ? { reasoning_effort: codexEffort(opt.effort) } : {}),
                resume_thread_id: this.resumeOf(run, ws.cwd),
                env,
                cwd: ws.cwd,
                mcp_servers,
              })
            : await this.claude.execute(ctx, prompt, {
                ...this.profile,
                ...(opt
                  ? {
                      model: opt.model ?? this.profile.model,
                      max_turns: opt.max_turns ?? this.profile.max_turns,
                      permission_mode: opt.permission_mode,
                      effort: opt.effort ?? null,
                    }
                  : {}),
                ...(readOnly ? { permission_mode: "plan" as const } : {}),
                // ADR-0021 §5: el harness del proyecto y el método de Keel; las reglas
                // `allow` del proyecto vuelven al gate.
                project_settings: true,
                method_plugin: this.methodPluginDir(),
                ask_rules: projectAllowRules(ws.cwd),
                // ADR-0020 §4: el humano puede pasar a bypass en vivo donde arrancar en bypass vale.
                allow_bypass:
                  run.purpose === "execute" &&
                  this.repo.getProjectVcs(run.project_id).vcs === "git",
                prompt_suggestions: this.settingsView().prompt_suggestions.enabled,
                resume_session_id: this.resumeOf(run, ws.cwd),
                sandbox,
                env,
                cwd: ws.cwd,
                max_budget_usd: budget == null ? null : budget / 1_000_000,
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
    this.toolGate.forgetRun(run.id)
    if (run.purpose === "execute") await this.detectCommits(run.id)
    this.runCwd.delete(run.id)
    this.settleWorkItem(final, "dispatch")
    if (!releasesOnFinish(final.status)) await this.captureChanges(run.id)
    this.afterFlowRun(final)
    // ADR-0022 §3: un run que termina libera lugar para la hija que esperaba.
    for (const parentId of [...this.waitingFeatures]) this.scheduleFeature(parentId)
  }

  /**
   * El puente `keel mcp` del run: el proveedor lo lanza con la ruta del token de
   * un solo uso, nunca con su valor (ADR-0009 §3).
   */
  /** El plugin del método (ADR-0021 §1): junto al paquete del daemon. */
  private methodPluginDir(): string | null {
    if (this.opts.methodPlugin === false) return null
    const dir = this.opts.methodPlugin ?? join(import.meta.dir, "..", "method-plugin")
    return existsSync(join(dir, ".claude-plugin", "plugin.json")) ? dir : null
  }

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
        env: { KEEL_RUN_TOKEN_FILE: file, KEEL_SOCKET: this.agentServer.path },
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
    if (actor.kind !== "agent") return projectId ?? ctx.client.project_id ?? this.project.project_id
    if (actor.run_id !== null) {
      const run = this.repo.getRun(actor.run_id)
      if (!run || !ACTIVE_RUN_STATUSES.includes(run.status))
        throw rpcError(ErrorCode.unauthorized, "el run del agente terminó; su capacidad caducó")
    } else if (this.repo.getPairing(actor.pairing_id ?? "")?.state !== "approved")
      throw rpcError(ErrorCode.unauthorized, "el emparejamiento de la sesión ya no está vigente")
    if (projectId !== undefined && projectId !== actor.project_id)
      throw rpcError(
        ErrorCode.unauthorized,
        "el agente sólo opera en el proyecto que tiene vinculado",
      )
    return actor.project_id
  }

  /**
   * Proyecto de una mutación (ADR-0019 §2): el de la entidad que nombra (tarea,
   * run, regla), el que pide explícitamente o el de la conexión. Así sus
   * eventos llegan a quien está suscrito a ese proyecto.
   */
  private projectOfParams(ctx: HandlerContext, p: object): string {
    if (ctx.actor.kind === "agent") return this.scopeOf(ctx)
    const q = p as { work_item_id?: string; run_id?: string; project_id?: string }
    const fromItem = q.work_item_id ? this.repo.getWorkItem(q.work_item_id)?.project_id : undefined
    const fromRun = q.run_id ? this.repo.getRun(q.run_id)?.project_id : undefined
    return fromItem ?? fromRun ?? this.scopeOf(ctx, q.project_id)
  }

  /** La tarea existe y es del proyecto de la conexión; si no, para un agente es como si no existiera. */
  private workItemIn(ctx: HandlerContext, id: string): WorkItemRow {
    const w = this.repo.getWorkItem(id)
    // El humano ve todos sus proyectos; el agente, sólo el suyo.
    if (!w || (ctx.actor.kind === "agent" && w.project_id !== this.scopeOf(ctx)))
      throw rpcError(ErrorCode.notFound, "work item no existe")
    return w
  }

  /**
   * Arranca un run con las reglas de `runs.start`: elegibilidad, bloqueos y
   * límites antes de crear nada (K-02, ADR-0002 regla 3). Lo usan `runs.start`
   * y la aprobación de una petición de run (ADR-0009 §5).
   */
  private startRunIn(
    uow: UnitOfWork,
    p: {
      work_item_id: string
      purpose: Params<"runs.start">["purpose"]
      prompt?: string | undefined
      profile?: string | undefined
      expected_revision?: number | undefined
      options?: Params<"runs.start">["options"]
      parent_run_id?: string | null
      /** Quién escribió la instrucción: el humano, la tarea o Keel al cambiar de etapa. */
      prompt_source?: "human" | "keel"
      /** ADR-0021 §3: el run trabaja en el worktree de la tarea aunque no ejecute. */
      task_worktree?: boolean
      /** ADR-0022: el worktree sale de la rama de la feature, no de HEAD. */
      worktree_base?: string
      /** ADR-0022: worktree nuevo aunque siga la conversación. */
      fresh_worktree?: boolean
    },
  ): ReturnType<Repo["runView"]> {
    const repo = this.repo
    const w = this.requireWorkItem(p.work_item_id)
    if (p.expected_revision !== undefined && p.expected_revision !== w.revision)
      throw rpcError(ErrorCode.conflict, "la tarea cambió desde la revisión esperada", {
        expected_revision: p.expected_revision,
        current_revision: w.revision,
      })
    if (repo.liveRunFor(w.id)) throw rpcError(ErrorCode.conflict, "la tarea ya tiene un run vivo")
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
      throw rpcError(ErrorCode.invalidParams, `perfil desconocido: ${provider} (claude | codex)`)
    const options = this.runOptions(w.project_id, p.purpose, provider, p.options)
    const run = repo.createRun({
      project_id: w.project_id,
      work_item_id: w.id,
      purpose: p.purpose,
      // Va en el manifest para que el despacho, aunque llegue tras una caída, use el
      // mismo tope, el mismo proveedor y las mismas opciones.
      manifest: {
        budget_micro_usd: lim.runBudgetMicroUsd,
        provider,
        options,
        ...(p.task_worktree ? { task_worktree: true } : {}),
        ...(p.options?.max_turns !== undefined ? { turns_explicit: true } : {}),
        ...(p.worktree_base ? { worktree_base: p.worktree_base } : {}),
        ...(p.fresh_worktree ? { fresh_worktree: true } : {}),
      },
      parent_run_id: p.parent_run_id ?? null,
    })
    if (rule.to !== w.lifecycle) this.transition(uow, w, rule.to, "system", { runId: run.id })
    const view = repo.runView(run)
    uow.emit("run.created", run.id, view)
    const prompt = p.prompt !== undefined && p.prompt.length > 0 ? p.prompt : w.title
    // El chat del run empieza con lo que se le pidió al agente, venga de quien venga.
    uow.emit("run.prompt", run.id, {
      text: prompt,
      source: p.prompt_source ?? (p.prompt ? "human" : "task"),
      actor: { id: uow.actorId },
    })
    // Despacho durable: si el daemon cae tras el commit, se entrega al arrancar.
    uow.enqueue(RUN_DISPATCH, run.id, `${RUN_DISPATCH}:${run.id}`, {
      run_id: run.id,
      prompt,
    } satisfies RunDispatch)
    return view
  }

  /**
   * Opciones efectivas del run (ADR-0019 §4): lo que pidió el humano o el
   * perfil. `bypass` sólo para `execute` en un worktree de git; los runs que
   * no ejecutan trabajan en la raíz del repo y sólo admiten `ask` o `plan`.
   */
  private runOptions(
    projectId: string,
    purpose: Params<"runs.start">["purpose"],
    provider: "claude" | "codex",
    o: Params<"runs.start">["options"],
  ): RunOptionsRecord {
    const mode = o?.permission_mode ?? "ask"
    if (purpose !== "execute" && mode !== "ask" && mode !== "plan")
      throw rpcError(
        ErrorCode.invalidParams,
        `un run ${purpose} trabaja en la raíz del repo: sólo admite los modos ask o plan`,
      )
    if (mode === "bypass" && this.repo.getProjectVcs(projectId).vcs !== "git")
      throw rpcError(
        ErrorCode.invalidParams,
        "bypass sólo existe dentro de un worktree de git; este proyecto no usa git",
      )
    // El modelo elegido al arrancar gana; si no, el default que eligió el humano en Ajustes.
    const chosen = (this.repo.getSetting(DEFAULT_MODELS)?.value as DefaultModels | undefined)?.[
      provider
    ]
    const useDefault = o?.model === undefined && chosen !== undefined
    const effort = o?.effort ?? (useDefault ? chosen.effort : null) ?? null
    return provider === "claude"
      ? {
          model: o?.model ?? chosen?.model ?? this.profile.model,
          max_turns: o?.max_turns ?? this.profile.max_turns,
          permission_mode: mode,
          effort: effort ?? this.profile.effort,
        }
      : {
          model: o?.model ?? chosen?.model ?? this.codexProfile.model,
          max_turns: null,
          permission_mode: mode,
          effort,
        }
  }

  // --- el método (ADR-0021) ----------------------------------------------------------

  /** Cómo trata el gate a un run según la etapa de su tarea. */
  private stagePolicy(run: RunRow): { stage: string | null; readOnly: boolean; inMethod: boolean } {
    const flow = this.repo.getFlow(run.work_item_id)
    // Un run que no ejecuta es de sólo lectura, esté o no en el método (ADR-0021 §3).
    if (run.purpose !== "execute")
      return { stage: flow?.stage ?? null, readOnly: true, inMethod: flow !== null }
    if (!flow) return { stage: null, readOnly: false, inMethod: false }
    // Un cambio de contrato esperando al humano congela la escritura.
    const gate = this.repo.pendingStageGate(run.work_item_id)
    const frozen = gate !== null && JSON.parse(gate.operation_json).input?.reason === "contract"
    return { stage: flow.stage, readOnly: isReadOnlyStage(flow.stage) || frozen, inMethod: true }
  }

  // --- vault y peticiones del agente (ADR-0025) ------------------------------------

  /** Lo que el humano dejó listo para una petición `setup.request`, por run. */
  private readonly setupMessages = new Map<string, string>()

  /** Un error del vault como error del protocolo: bloqueado, inexistente o inválido. */
  private async vaultCall<T>(fn: () => T | Promise<T>): Promise<T> {
    try {
      return await fn()
    } catch (e) {
      if (e instanceof VaultError)
        throw rpcError(
          e.code === "not_found" ? ErrorCode.notFound : ErrorCode.invalidParams,
          e.message,
          { vault: e.code },
        )
      if (e instanceof BrokerError) throw brokerFailure(e)
      throw e
    }
  }

  /** El askpass que nunca contesta: usuario y contraseña de git no pasan por Keel. */
  private noAskpassPath(): string {
    return join(dirname(this.opts.dbPath), "bin", "keel-noaskpass")
  }

  private vaultPut(p: Parameters<Vault["put"]>[0]): Promise<string> {
    return this.vaultCall(() => this.vault.put(p))
  }

  /**
   * Resuelve una petición del agente con lo que el humano dejó listo (ADR-0025 §6). El
   * agente recibe una línea: qué quedó, con qué operaciones y con qué política.
   */
  private answerSetup(
    uow: UnitOfWork,
    approvalId: string,
    result: { connection_id?: string | undefined; note?: string | undefined },
  ) {
    const a = this.repo.getApproval(approvalId)
    const op = a ? (JSON.parse(a.operation_json) as { tool?: string }) : null
    if (!a || op?.tool !== "setup.request" || a.state !== "pending")
      throw rpcError(ErrorCode.invalidTransition, "esa petición del agente ya no está abierta")
    let message = result.note?.trim() || "el humano lo dejó listo"
    if (result.connection_id) {
      const conn = brokerCall(() => this.broker.find(a.project_id, result.connection_id as string))
      const ops = this.broker
        .view(conn)
        .operations.map((o) => `${o.operation} (${o.effective})`)
        .join(", ")
      message = `conexión ${conn.name} lista (${conn.environment}): ${ops}${result.note ? ` · ${result.note}` : ""}`
    }
    this.setupMessages.set(a.run_id, message)
    this.repo.setApproval(a.id, "approved", uow.actorId)
    uow.emit("approval.resolved", a.run_id, {
      approval_id: a.id,
      decision: "approved",
      setup: { ...result, message },
    })
    uow.afterCommit(() => this.approvalWaiters.get(a.id)?.({ decision: "approved" }))
    return { approval_id: a.id, state: "approved" as const }
  }

  /** El perfil confirmado o, si no hay, el detectado. */
  private profileOf(projectId: string): ProjectProfile | null {
    const row = this.repo.getProfile(projectId)
    if (row) {
      const parsed = ProjectProfileSchema.safeParse(JSON.parse(row.profile_json))
      if (parsed.success) return parsed.data
    }
    return this.detectedProfiles.get(projectId) ?? null
  }

  private async detectedProfile(projectId: string): Promise<ProjectProfile> {
    const root = this.repo.projectRoot(projectId) ?? this.rootPath
    const detected = await detectProfile(root)
    this.detectedProfiles.set(projectId, detected)
    return detected
  }

  private async profileView(projectId: string) {
    const detected = await this.detectedProfile(projectId)
    const row = this.repo.getProfile(projectId)
    return {
      project_id: projectId,
      profile: this.profileOf(projectId) ?? detected,
      detected,
      confirmed_by: row?.confirmed_by ?? null,
      confirmed_at: row?.confirmed_at ?? null,
    }
  }

  private flowViewOf(workItemId: string) {
    const flow = this.repo.getFlow(workItemId)
    if (!flow) return null
    const gate = this.repo.pendingStageGate(workItemId)
    const input = gate
      ? (
          JSON.parse(gate.operation_json) as {
            input: { gate: "brief" | "design" | "close"; to: Stage }
          }
        ).input
      : null
    return flowView(
      flow,
      gate && input
        ? {
            approval_id: gate.id,
            operation_hash: gate.operation_hash,
            gate: input.gate,
            to: input.to,
          }
        : null,
      this.lastGitPlan(workItemId),
    )
  }

  /** El último plan de git de la tarea, con lo que hizo y por qué paró. */
  private lastGitPlan(workItemId: string): TaskFlowView["git_plan"] {
    const a = this.repo.gitPlansFor(workItemId)[0]
    if (!a) return null
    const s = this.gitPlanState(a.id, a.state, a.expires_at)
    return {
      plan_id: a.id,
      run_id: a.run_id,
      state: s.state,
      reason: s.reason,
      done: s.steps.filter((x) => x.state === "done").map((x) => x.op),
    }
  }

  /** Lo que el agente debe saber del plan anterior al retomar el cierre. */
  private gitPlanNote(workItemId: string): string {
    const p = this.lastGitPlan(workItemId)
    if (!p || (p.state !== "failed" && p.state !== "expired")) return ""
    const done = p.done.length ? ` Ya se hizo: ${p.done.join(", ")}.` : ""
    return `\n[Keel · git] El último plan de git ${p.state === "failed" ? "falló" : "caducó"}${p.reason ? `: ${p.reason}` : ""}.${done} Si el cierre sigue pendiente, propón otro con git_propose con sólo lo que falta.`
  }

  /** La última versión de cada documento, con su contenido. */
  private docSet(workItemId: string): DocSet {
    const out: DocSet = {}
    for (const d of this.repo.latestTaskDocs(workItemId)) out[d.kind] = this.repo.taskDocContent(d)
    return out
  }

  /**
   * La conversación del proyecto (ADR-0024 §1): una tarea oculta que Keel crea la
   * primera vez. No emite `work_item.created`: no va al tablero ni a las listas.
   */
  private conversationFor(projectId: string): WorkItemRow {
    const found = this.repo.conversationOf(projectId)
    if (found) return found
    return this.repo.db.transaction(
      () =>
        this.repo.conversationOf(projectId) ??
        this.repo.createWorkItem({
          project_id: projectId,
          title: "Conversación del proyecto",
          kind: "research",
          display_id: "CHAT",
          dedupe_key: CONVERSATION_KEY,
          spec_markdown:
            "Consultas sobre el proyecto, de sólo lectura. Lo que haya que hacer nace aquí como tarea.",
        }),
    )()
  }

  /** Un agente sólo opera sobre la tarea de su run. */
  private requireOwnTask(ctx: HandlerContext, workItemId: string): WorkItemRow {
    if (ctx.actor.kind === "agent" && ctx.actor.work_item_id !== workItemId)
      throw rpcError(ErrorCode.unauthorized, "el agente sólo opera sobre la tarea de su run")
    return this.requireWorkItem(workItemId)
  }

  /**
   * Arranca el siguiente run de la conversación de la tarea, con el propósito
   * que pide su etapa, como hijo del último: misma carpeta, misma sesión.
   */
  private startFlowRun(
    uow: UnitOfWork,
    w: WorkItemRow,
    prompt: string,
    o: {
      source: "human" | "keel"
      profile?: "claude" | "codex" | undefined
      options?: Params<"runs.start">["options"]
    },
  ): ReturnType<Repo["runView"]> {
    const flow = this.repo.getFlow(w.id) as NonNullable<ReturnType<Repo["getFlow"]>>
    const purpose = purposeForStage(flow.stage)
    const last = this.repo.lastRunFor(w.id)
    const lastManifest = last
      ? (JSON.parse(last.context_manifest_json) as {
          provider?: string
          options?: Params<"runs.start">["options"]
        })
      : {}
    let item = w
    if (purpose === "execute") {
      // Seguir trabajando es decisión del humano que escribe (aristas de ADR-0006).
      if (["waiting_human", "failed", "needs_review"].includes(item.lifecycle))
        item = this.transition(uow, item, "planned", "human", {
          reason: "seguir trabajando la tarea",
          keepWorkspaces: true,
        })
      else if (item.lifecycle === "running")
        item = this.transition(uow, item, "planned", "system", {
          reason: "el run anterior terminó sin asentar la tarea",
          keepWorkspaces: true,
        })
    }
    // ADR-0028: sólo se hereda el tope de turnos que eligió el humano, no el de antes por defecto.
    const base = { ...inheritedOptions(last), ...o.options }
    // ADR-0022 §2: una subtarea sale de la rama de la feature; el padre revisa la feature
    // en un worktree nuevo sobre esa rama.
    const parentFeat = item.parent_work_item_id ? this.featureOf(item.parent_work_item_id) : null
    const ownFeat = this.featureOf(item.id)
    const featureBase =
      parentFeat?.branch ?? (ownFeat && purpose === "execute" ? ownFeat.branch : null)
    const lastBase = last
      ? (JSON.parse(last.context_manifest_json) as { worktree_base?: string }).worktree_base
      : undefined
    return this.startRunIn(uow, {
      work_item_id: item.id,
      purpose,
      prompt,
      prompt_source: o.source,
      profile: o.profile ?? lastManifest.provider ?? "claude",
      options: {
        ...base,
        // Planear es sólo lectura; al ejecutar vuelve el modo que tenía el humano.
        permission_mode:
          purpose === "plan"
            ? "plan"
            : base.permission_mode && base.permission_mode !== "plan"
              ? base.permission_mode
              : "ask",
      },
      parent_run_id: last?.id ?? null,
      task_worktree: true,
      ...(featureBase ? { worktree_base: featureBase } : {}),
      ...(featureBase && lastBase !== featureBase ? { fresh_worktree: true } : {}),
    })
  }

  /** Sin run vivo, abre el siguiente; con run vivo, le escribe. */
  private continueFlow(workItemId: string, why: string): void {
    const w = this.repo.getWorkItem(workItemId)
    const flow = this.repo.getFlow(workItemId)
    if (!w || !flow) return
    const live = this.repo.liveRunFor(workItemId)
    if (live) {
      // Mismo propósito: el agente sigue en este turno. Otro: termina y Keel abre el siguiente.
      const text =
        live.purpose === purposeForStage(flow.stage)
          ? why
          : `${why} La etapa ${flow.stage} sigue en un run nuevo que Keel abre al terminar este turno: cierra con un resumen breve.`
      if (this.providerOf(live).sendMessage(live.id, text))
        this.emitSystem("run.keel_message", live.id, { text })
      return
    }
    try {
      runUnitOfWork(this.uowDeps(), this.systemScope(w.project_id), (uow) =>
        this.startFlowRun(uow, w, continuationPrompt(w, flow.stage, why, flow.ceremony), {
          source: "keel",
        }),
      )
    } catch (e) {
      this.emitSystem("task.flow_stalled", null, {
        work_item_id: w.id,
        stage: flow.stage,
        message: e instanceof Error ? e.message : String(e),
      })
    }
  }

  /** Al terminar un run: si la etapa pide otro propósito, la conversación sigue sola. */
  private afterFlowRun(final: RunRow): void {
    const flow = this.repo.getFlow(final.work_item_id)
    if (!flow || final.status !== "completed") return
    if (this.repo.pendingStageGate(final.work_item_id)) return
    // ADR-0022 §4: el padre espera a sus hijas sin run vivo; Keel lo despierta al final.
    if (this.repo.getWorkItem(final.work_item_id)?.lifecycle === "blocked") return
    if (purposeForStage(flow.stage) !== final.purpose)
      this.continueFlow(final.work_item_id, `La tarea pasó a la etapa ${flow.stage}.`)
  }

  /**
   * Aplica una etapa ya legal y autorizada: mueve el lifecycle cuando toca y,
   * al confirmar, ajusta el run vivo y corre la verificación de la etapa.
   */
  private applyStage(
    uow: UnitOfWork,
    w: WorkItemRow,
    to: Stage,
    o: { authorizedBy: string; delegated: boolean; reason?: string | undefined },
  ): void {
    const flow = this.repo.getFlow(w.id) as NonNullable<ReturnType<Repo["getFlow"]>>
    const from = flow.stage
    this.repo.updateFlow(w.id, { stage: to })
    let item = this.repo.getWorkItem(w.id) as WorkItemRow
    if (item.lifecycle === "triage" && lifecycleForStage(to) !== "triage")
      item = this.transition(uow, item, "planned", "human", {
        reason: o.delegated
          ? `trabajo directo: lo autorizó ${o.authorizedBy} al pedir trabajar la tarea`
          : "el humano aprobó el diseño",
      })
    const run = this.repo.lastRunFor(w.id)
    uow.emit("task.stage_changed", run?.id ?? null, {
      work_item_id: w.id,
      from,
      to,
      ceremony: flow.ceremony,
      authorized_by: o.authorizedBy,
      delegated: o.delegated,
      reason: o.reason ?? null,
    })
    uow.emit("work_item.updated", run?.id ?? null, this.repo.workItemView(item))
    uow.afterCommit(() => {
      const live = this.repo.liveRunFor(w.id)
      // El agente que sigue vivo recibe el objetivo de la etapa nueva: el encabezado del
      // prompt sólo lo vio al empezar el run.
      if (live && live.purpose === purposeForStage(to)) {
        const text = stageMessage(to, this.repo.getFlow(w.id)?.ceremony ?? null)
        if (this.providerOf(live).sendMessage(live.id, text))
          this.emitSystem("run.keel_message", live.id, { text })
      }
      // Revisar es sólo lectura también para el SDK; implementar vuelve al modo del run.
      if (live?.purpose === "execute") {
        const mode = to === "review" ? "plan" : runOptionsFor(live).permission_mode
        this.applyLive(live, (a) =>
          a.setMode(live.id, mode === "plan" && to !== "review" ? "ask" : mode),
        )
      }
      if (to === "implement" && !this.repo.getFlow(w.id)?.baseline_json)
        this.track(this.taskVerify(w.id, { baseline: true }))
      if (to === "review") this.track(this.taskVerify(w.id, { notify: true }))
    })
  }

  /** Abre el gate humano de una transición (ADR-0021 §2). */
  private openStageGate(
    uow: UnitOfWork,
    w: WorkItemRow,
    gate: "brief" | "design" | "close",
    from: Stage,
    to: Stage,
    reason: "stage" | "contract",
  ): { approval_id: string; gate: "brief" | "design" | "close" } {
    const run = this.repo.liveRunFor(w.id) ?? this.repo.lastRunFor(w.id)
    if (!run) throw rpcError(ErrorCode.invalidTransition, "la tarea no tiene runs")
    const docs = this.repo.latestTaskDocs(w.id).map((d) => ({
      kind: d.kind,
      version: d.version,
      sha256: d.sha256,
    }))
    const flow = this.repo.getFlow(w.id)
    const input = {
      work_item_id: w.id,
      gate,
      from,
      to,
      reason,
      ceremony: flow?.ceremony ?? null,
      ceremony_reason: flow?.ceremony_reason ?? null,
      docs,
    }
    const hash = createHash("sha256")
      .update(canonicalJson({ tool: "stage.gate", input, run_id: run.id }))
      .digest("hex")
    const approvalId = this.repo.createApproval({
      project_id: w.project_id,
      run_id: run.id,
      operation_hash: hash,
      operation: { tool: "stage.gate", input, run_id: run.id },
      expires_at: null,
    })
    uow.emit("approval.requested", run.id, {
      approval_id: approvalId,
      operation_hash: hash,
      tool: "stage.gate",
      input,
      expires_at: null,
    })
    return { approval_id: approvalId, gate }
  }

  /** El humano decide un gate del método: aprobar avanza; negar devuelve el trabajo al agente. */
  private resolveStageGate(
    uow: UnitOfWork,
    a: NonNullable<ReturnType<Repo["getApproval"]>>,
    input: unknown,
    p: Params<"approvals.resolve">,
  ) {
    if (p.decision !== "approve_once" && p.decision !== "deny")
      throw rpcError(
        ErrorCode.invalidParams,
        "un gate del método se aprueba (approve_once) o se niega (deny)",
      )
    const g = input as {
      work_item_id: string
      gate: "brief" | "design" | "close"
      from: Stage
      to: Stage
      reason: "stage" | "contract"
      docs: { kind: TaskDocKind; sha256: string }[]
    }
    const w = this.requireWorkItem(g.work_item_id)
    const flow = this.repo.getFlow(w.id)
    const current = new Map(this.repo.latestTaskDocs(w.id).map((d) => [d.kind, d.sha256]))
    const stale =
      !flow || flow.stage !== g.from || g.docs.some((d) => current.get(d.kind) !== d.sha256)
    if (stale) {
      this.repo.setApproval(a.id, "expired", null)
      uow.emit("approval.resolved", a.run_id, { approval_id: a.id, decision: "expired" })
      throw rpcError(
        ErrorCode.conflict,
        "la tarea o sus documentos cambiaron desde que se pidió el gate; el agente debe pedirlo de nuevo",
      )
    }
    const reason = p.reason?.trim() ?? ""
    const label = { brief: "brief", design: "diseño", close: "cierre" }[g.gate]
    if (p.decision === "deny") {
      this.repo.setApproval(a.id, "denied", uow.actorId)
      uow.emit("approval.resolved", a.run_id, {
        approval_id: a.id,
        decision: "denied",
        ...(reason ? { reason } : {}),
      })
      uow.afterCommit(() =>
        this.continueFlow(
          w.id,
          `El humano no aprobó el ${label}${reason ? `: ${reason}` : "."} Corrígelo y vuelve a pedir el gate con stage_advance.`,
        ),
      )
      return { approval_id: a.id, state: "denied" as const }
    }
    this.repo.setApproval(a.id, "consumed", uow.actorId)
    uow.emit("approval.resolved", a.run_id, { approval_id: a.id, decision: "approved" })
    // El contrato congelado es el hash de su sección en el diseño aprobado.
    if (g.gate === "design") {
      const design = this.docSet(w.id).design ?? ""
      this.repo.updateFlow(w.id, {
        contract_sha256: createHash("sha256")
          .update(contractSection(design) ?? "")
          .digest("hex"),
      })
    }
    if (g.reason === "contract") {
      uow.afterCommit(() =>
        this.continueFlow(
          w.id,
          "El humano aprobó el cambio de contrato; sigue implementando contra el nuevo.",
        ),
      )
      return { approval_id: a.id, state: "approved" as const }
    }
    this.applyStage(uow, w, g.to, { authorizedBy: uow.actorId, delegated: false, reason })
    // ADR-0022 §1: aprobar el contrato aprueba también el árbol de subtareas.
    const planned = g.gate === "design" ? this.plannedSubtasks(w) : []
    if (planned.length > 0) {
      this.bornSubtasks(uow, w, planned, {
        approver: uow.actorId,
        autoIntegrate: p.auto_integrate === true,
      })
      uow.afterCommit(() => {
        const live = this.repo.liveRunFor(w.id)
        const text = `El humano aprobó el diseño: nacieron ${planned.length} subtareas que Keel trabaja en orden en la rama de la feature. Cierra este turno con un resumen breve.`
        if (live && this.providerOf(live).sendMessage(live.id, text))
          this.emitSystem("run.keel_message", live.id, { text })
      })
      return { approval_id: a.id, state: "approved" as const }
    }
    uow.afterCommit(() =>
      this.continueFlow(w.id, `El humano aprobó el ${label}${reason ? ` («${reason}»)` : ""}.`),
    )
    return { approval_id: a.id, state: "approved" as const }
  }

  // --- feature y subtareas (ADR-0022) ------------------------------------------------

  /** Features cuya siguiente hija no pudo arrancar por límites: se reintenta al liberar. */
  private readonly waitingFeatures = new Set<string>()

  /** La feature de un padre, si sus subtareas ya nacieron. */
  private featureOf(workItemId: string): FeatureInfo | null {
    const raw = this.repo.getFlow(workItemId)?.feature_json
    return raw ? (JSON.parse(raw) as FeatureInfo) : null
  }

  private subtaskOf(workItemId: string): SubtaskInfo | null {
    const raw = this.repo.getFlow(workItemId)?.subtask_json
    return raw ? (JSON.parse(raw) as SubtaskInfo) : null
  }

  /** El plan de una tarea formal, si da para subtareas: dos líneas o más y sin abuelo. */
  private plannedSubtasks(w: WorkItemRow): PlannedTask[] {
    if (w.parent_work_item_id) return []
    const flow = this.repo.getFlow(w.id)
    if (flow?.ceremony !== "formal") return []
    const tasks = parseTasks(this.docSet(w.id).tasks ?? "")
    return tasks.length >= 2 ? tasks : []
  }

  /**
   * Al aprobar el diseño, el documento `tasks` se convierte en subtareas (ADR-0022 §1):
   * cada una en `planned`, en implementar, con la ceremonia y el contrato del padre y
   * su story; las de fases siguientes esperan a las anteriores. El padre queda
   * `blocked` con su avance. La rama de la feature se crea al confirmar.
   */
  private bornSubtasks(
    uow: UnitOfWork,
    parent: WorkItemRow,
    tasks: PlannedTask[],
    o: { approver: string; autoIntegrate: boolean },
  ): void {
    const repo = this.repo
    const docs = this.docSet(parent.id)
    const flow = repo.getFlow(parent.id) as NonNullable<ReturnType<Repo["getFlow"]>>
    const profile = this.profileOf(parent.project_id)
    const branch = featureBranchName(
      profile?.branch_prefixes.feature ?? "feat/",
      parent.display_id,
      parent.title,
    )
    const ids: Record<string, string> = {}
    const born: WorkItemRow[] = []
    for (const t of tasks) {
      const story = storyFor(t, docs.spec ?? "", docs.design ?? "")
      let child = repo.createWorkItem({
        project_id: parent.project_id,
        title: t.title,
        kind: parent.kind ?? "feature",
        source: "agent",
        spec_markdown: story,
        ...(parent.priority ? { priority: parent.priority } : {}),
        parent_work_item_id: parent.id,
      })
      ids[t.key] = child.id
      child = this.transition(uow, child, "planned", "human", {
        reason: `nació del diseño de ${parent.display_id}, que aprobó ${o.approver}`,
      })
      repo.createFlow(child.id, "implement", o.approver)
      repo.updateFlow(child.id, {
        ceremony: flow.ceremony,
        contract_sha256: flow.contract_sha256,
        subtask_json: JSON.stringify({
          key: t.key,
          phase: t.phase,
          phase_title: t.phase_title,
          frontier: t.frontier,
          requirements: t.requirements,
        } satisfies SubtaskInfo),
      })
      repo.putTaskDoc({
        work_item_id: child.id,
        kind: "story",
        content: story,
        author: "system:keel",
      })
      born.push(child)
    }
    for (const t of tasks)
      for (const dep of t.after) {
        const waiting = ids[t.key] as string
        const blocking = ids[dep]
        if (!blocking) continue
        repo.addDependency({ project_id: parent.project_id, waiting, blocking })
        repo.addBlock({
          work_item_id: waiting,
          kind: "dependency",
          reason_key: `task:${blocking}`,
          details: { blocking, key: dep },
        })
      }
    for (const c of born) {
      let row = repo.getWorkItem(c.id) as WorkItemRow
      if (repo.openBlocks(c.id).length > 0)
        row = this.transition(uow, row, "blocked", "system", {
          reason: "espera a las subtareas de la fase anterior",
        })
      uow.emit("work_item.created", null, { ...repo.workItemView(row), actor: { id: o.approver } })
    }
    repo.updateFlow(parent.id, {
      feature_json: JSON.stringify({
        branch,
        base: "HEAD",
        base_sha: null,
        auto_integrate: o.autoIntegrate,
        approved_by: o.approver,
        subtasks: ids,
      } satisfies FeatureInfo),
    })
    repo.addBlock({
      work_item_id: parent.id,
      kind: "dependency",
      reason_key: "subtasks",
      details: { done: 0, total: tasks.length },
    })
    const p = this.transition(
      uow,
      repo.getWorkItem(parent.id) as WorkItemRow,
      "blocked",
      "system",
      {
        reason: `0/${tasks.length} subtareas`,
      },
    )
    uow.emit("work_item.updated", null, repo.workItemView(p))
    uow.emit("feature.planned", repo.lastRunFor(parent.id)?.id ?? null, {
      work_item_id: parent.id,
      branch,
      auto_integrate: o.autoIntegrate,
      subtasks: tasks.map((t) => ({
        id: ids[t.key],
        key: t.key,
        title: t.title,
        phase: t.phase,
        phase_title: t.phase_title,
        after: t.after,
        frontier: t.frontier,
      })),
    })
    uow.afterCommit(() => this.track(this.prepareFeature(parent.id)))
  }

  /** Crea la rama de la feature desde la rama actual del proyecto y arranca la primera hija. */
  private async prepareFeature(parentId: string): Promise<void> {
    const parent = this.repo.getWorkItem(parentId)
    const feat = this.featureOf(parentId)
    if (!parent || !feat) return
    const root = this.repo.projectRoot(parent.project_id) ?? this.rootPath
    try {
      const base = (await currentBranch(root).catch(() => null)) ?? "HEAD"
      const r = await createFeatureBranch(root, feat.branch, base)
      this.repo.updateFlow(parentId, {
        feature_json: JSON.stringify({ ...feat, base, base_sha: r.sha } satisfies FeatureInfo),
      })
      this.emitSystem("feature.branch_created", this.repo.lastRunFor(parentId)?.id ?? null, {
        work_item_id: parentId,
        branch: feat.branch,
        base,
        sha: r.sha,
        created: r.created,
      })
    } catch (e) {
      this.emitSystem("task.flow_stalled", this.repo.lastRunFor(parentId)?.id ?? null, {
        work_item_id: parentId,
        stage: "implement",
        message: `no se pudo crear la rama de la feature: ${e instanceof Error ? e.message : String(e)}`,
      })
      return
    }
    this.scheduleFeature(parentId)
  }

  /**
   * El orden de la feature (ADR-0022 §3), con código: desbloquea las hijas cuyas
   * dependencias terminaron, actualiza el «n/m» del padre y arranca la siguiente lista
   * si no hay otra trabajando. Con todas integradas, el padre revisa la feature.
   */
  private scheduleFeature(parentId: string): void {
    const repo = this.repo
    const parent = repo.getWorkItem(parentId)
    const feat = this.featureOf(parentId)
    if (!parent || !feat?.base_sha) return
    const children = repo.childrenOf(parentId)
    runUnitOfWork(this.uowDeps(), this.systemScope(parent.project_id), (uow) => {
      for (const c of children) {
        for (const d of repo.dependenciesOf(c.id))
          if (repo.getWorkItem(d.blocking)?.lifecycle === "done")
            repo.clearBlock(c.id, "dependency", `task:${d.blocking}`)
        const row = repo.getWorkItem(c.id) as WorkItemRow
        if (row.lifecycle === "blocked" && repo.openBlocks(c.id).length === 0) {
          const ready = this.transition(uow, row, "planned", "system", {
            reason: "sus dependencias ya se integraron",
          })
          uow.emit("work_item.updated", null, repo.workItemView(ready))
        }
      }
      const done = children.filter((c) => repo.getWorkItem(c.id)?.lifecycle === "done").length
      repo.setBlockDetails(parentId, "dependency", "subtasks", { done, total: children.length })
      uow.emit(
        "work_item.updated",
        null,
        repo.workItemView(repo.getWorkItem(parentId) as WorkItemRow),
      )
    })
    const now = repo.childrenOf(parentId)
    if (now.length > 0 && now.every((c) => c.lifecycle === "done")) {
      this.finishFeature(parentId)
      return
    }
    // Una a la vez por defecto (ADR-0002 regla 5): nada nuevo mientras otra trabaja o espera.
    const busy = now.some(
      (c) =>
        repo.liveRunFor(c.id) !== null ||
        ["running", "waiting_human", "needs_review", "failed"].includes(c.lifecycle),
    )
    // Si la hija que acaba de integrarse aún figura con su run vivo, se reintenta cuando
    // ese run termine (sin esto la feature se quedaba esperando para siempre).
    if (busy) {
      this.waitingFeatures.add(parentId)
      return
    }
    const next = now.find((c) => c.lifecycle === "planned" && repo.openBlocks(c.id).length === 0)
    if (!next) {
      this.waitingFeatures.delete(parentId)
      return
    }
    try {
      runUnitOfWork(this.uowDeps(), this.systemScope(parent.project_id), (uow) => {
        const run = this.startFlowRun(uow, next, workPrompt(next, "implement"), { source: "keel" })
        uow.emit("feature.subtask_started", repo.lastRunFor(parentId)?.id ?? null, {
          work_item_id: parentId,
          subtask_id: next.id,
          key: this.subtaskOf(next.id)?.key ?? null,
          title: next.title,
          run_id: run.id,
        })
      })
      this.waitingFeatures.delete(parentId)
    } catch (e) {
      // Sin lugar de concurrencia o sin presupuesto: arranca cuando termine otro run.
      this.waitingFeatures.add(parentId)
      this.emitSystem("feature.waiting", repo.lastRunFor(parentId)?.id ?? null, {
        work_item_id: parentId,
        subtask_id: next.id,
        message: e instanceof Error ? e.message : String(e),
      })
    }
  }

  /** Todas integradas: el padre vuelve a `planned` y revisa la feature entera (ADR-0022 §4). */
  private finishFeature(parentId: string): void {
    const repo = this.repo
    const parent = repo.getWorkItem(parentId)
    if (parent?.lifecycle !== "blocked") return
    try {
      runUnitOfWork(this.uowDeps(), this.systemScope(parent.project_id), (uow) => {
        repo.clearBlock(parentId, "dependency", "subtasks")
        const row = this.transition(uow, parent, "planned", "system", {
          reason: "todas las subtareas se integraron",
        })
        const flow = repo.getFlow(parentId) as NonNullable<ReturnType<Repo["getFlow"]>>
        repo.updateFlow(parentId, { stage: "review" })
        const last = repo.lastRunFor(parentId)
        uow.emit("task.stage_changed", last?.id ?? null, {
          work_item_id: parentId,
          from: flow.stage,
          to: "review",
          ceremony: flow.ceremony,
          authorized_by: "system:keel",
          delegated: true,
          reason: "todas las subtareas se integraron a la feature",
        })
        uow.emit("work_item.updated", last?.id ?? null, repo.workItemView(row))
        this.startFlowRun(
          uow,
          row,
          continuationPrompt(
            row,
            "review",
            `Todas las subtareas se integraron en la rama ${this.featureOf(parentId)?.branch}. Revisa la feature entera contra la spec: corre verify_run y escribe el QA.`,
            flow.ceremony,
          ),
          { source: "keel" },
        )
      })
    } catch (e) {
      this.emitSystem("task.flow_stalled", repo.lastRunFor(parentId)?.id ?? null, {
        work_item_id: parentId,
        stage: "review",
        message: e instanceof Error ? e.message : String(e),
      })
    }
  }

  /**
   * Integrar una subtarea es su cierre (ADR-0022 §2): su rama entra en la de la
   * feature. Un conflicto la devuelve a implementar con los archivos; si se repite en
   * el mismo archivo, se marca en el padre (fronteras mal puestas).
   */
  private async integrateSubtask(
    item: WorkItemRow,
    plan: GitPlan,
  ): Promise<{ ok: true } | { ok: false; message: string }> {
    const parentId = item.parent_work_item_id as string
    const feat = this.featureOf(parentId)
    if (!feat) return { ok: false, message: "el padre no tiene rama de feature" }
    const root = this.repo.projectRoot(item.project_id) ?? this.rootPath
    const key = this.subtaskOf(item.id)?.key ?? item.display_id
    const r = await integrateInto(root, feat.branch, `refs/heads/${plan.branch}`, {
      message: `Integra ${key} · ${item.title} (${item.display_id})`,
      env: {
        GIT_AUTHOR_NAME: "Keel",
        GIT_AUTHOR_EMAIL: "keel@agents.keel.local",
        GIT_COMMITTER_NAME: "Keel",
        GIT_COMMITTER_EMAIL: "keel@agents.keel.local",
      },
    })
    const parentRun = this.repo.lastRunFor(parentId)?.id ?? null
    if (r.ok) {
      this.emitSystem("feature.subtask_integrated", parentRun, {
        work_item_id: parentId,
        subtask_id: item.id,
        key,
        title: item.title,
        branch: feat.branch,
        sha: r.sha,
        mode: r.mode,
      })
      return { ok: true }
    }
    const before = this.repo
      .eventsAbout("feature.subtask_returned", parentId)
      .flatMap((e) => (JSON.parse(e.payload_json) as { conflicts?: string[] }).conflicts ?? [])
    const repeated = r.conflicts.filter((f) => before.includes(f))
    this.emitSystem("feature.subtask_returned", parentRun, {
      work_item_id: parentId,
      subtask_id: item.id,
      key,
      title: item.title,
      conflicts: r.conflicts,
      message: r.message,
      ...(repeated.length ? { frontier_warning: repeated } : {}),
    })
    return {
      ok: false,
      message: `${r.message}${r.conflicts.length ? `: ${r.conflicts.join(", ")}` : ""}`,
    }
  }

  /**
   * La integración automática que el humano eligió en el gate (b) (ADR-0022 §2): sólo
   * con QA PASS, verificación sin rojo nuevo y un diff dentro de la frontera.
   */
  private autoIntegrable(item: WorkItemRow, plan: GitPlan): string | null {
    if (!item.parent_work_item_id) return "no es una subtarea"
    const feat = this.featureOf(item.parent_work_item_id)
    if (!feat?.auto_integrate) return "el humano no eligió la integración automática"
    const flow = this.repo.getFlow(item.id)
    if (flow?.stage !== "close") return "la subtarea no está en el cierre"
    if (plan.operations.some((o) => o.op !== "commit")) return "el plan publica algo"
    const qa = this.docSet(item.id).qa
    if (!qa || qaVerdict(qa) !== "PASS") return "el QA no es PASS"
    const last = flow.last_verify_json
      ? (JSON.parse(flow.last_verify_json) as VerifyResult[])
      : null
    if (!last) return "no hay verificación"
    const base = flow.baseline_json ? (JSON.parse(flow.baseline_json) as VerifyResult[]) : null
    if (!verifyDelta(base, last).green) return "la verificación tiene rojo nuevo"
    const frontier = this.subtaskOf(item.id)?.frontier ?? []
    const outside = plan.files.filter((f) => !withinFrontier(f.path, frontier)).map((f) => f.path)
    if (outside.length) return `toca archivos fuera de su frontera: ${outside.join(", ")}`
    return null
  }

  /** Dónde verificar la tarea: el worktree de su último run, o la raíz. */
  private taskCwd(w: WorkItemRow): string {
    const last = this.repo.lastRunFor(w.id)
    const wt = last
      ? this.repo
          .runWorktrees(last.id)
          .find((x) => x.slot === "root" && existsSync(x.worktree_path))
      : undefined
    return wt?.worktree_path ?? this.repo.projectRoot(w.project_id) ?? this.rootPath
  }

  /**
   * Corre la verificación del proyecto en el worktree de la tarea (ADR-0021 §4),
   * guarda baseline o último resultado y, si se pide, se lo cuenta al agente en
   * pocas líneas. Una a la vez por tarea.
   */
  private async taskVerify(
    workItemId: string,
    o: { baseline?: boolean; notify?: boolean } = {},
  ): Promise<{
    results: VerifyResult[]
    delta: ReturnType<typeof verifyDelta>
    baseline: boolean
  }> {
    const previous = this.verifying.get(workItemId) ?? Promise.resolve()
    const job = previous
      .catch(() => undefined)
      .then(async () => {
        const w = this.requireWorkItem(workItemId)
        const profile = this.profileOf(w.project_id) ?? (await this.detectedProfile(w.project_id))
        const results = profile.verify.length
          ? await runVerify(this.taskCwd(w), profile.verify, {
              store: (text) => this.artifacts.put(text, "text/plain").ref,
            })
          : []
        const flow = this.repo.getFlow(w.id)
        const isBaseline = o.baseline === true || !flow?.baseline_json
        const base = isBaseline
          ? results
          : (JSON.parse(flow?.baseline_json ?? "[]") as VerifyResult[])
        const delta = verifyDelta(base, results)
        runUnitOfWork(this.uowDeps(), this.systemScope(w.project_id), (uow) => {
          if (flow)
            this.repo.updateFlow(w.id, {
              last_verify_json: JSON.stringify(results),
              ...(isBaseline ? { baseline_json: JSON.stringify(results) } : {}),
            })
          uow.emit("verify.completed", this.repo.lastRunFor(w.id)?.id ?? null, {
            work_item_id: w.id,
            baseline: isBaseline,
            results,
            delta,
          })
        })
        const live = this.repo.liveRunFor(w.id)
        if (o.notify && live && results.length) {
          const text = `Keel corrió la verificación: ${verifySummary(results, delta)}`
          if (this.providerOf(live).sendMessage(live.id, text))
            this.emitSystem("run.keel_message", live.id, { text })
        }
        return { results, delta, baseline: isBaseline }
      })
    this.verifying.set(workItemId, job)
    try {
      return await job
    } finally {
      if (this.verifying.get(workItemId) === job) this.verifying.delete(workItemId)
    }
  }

  private providerName(run: RunRow): "claude" | "codex" {
    const m = JSON.parse(run.context_manifest_json) as { provider?: string }
    return m.provider === "codex" ? "codex" : "claude"
  }

  private requireLiveRun(id: string): RunRow {
    const run = this.repo.getRun(id)
    if (!run) throw rpcError(ErrorCode.notFound, "el run no existe")
    if (!ACTIVE_RUN_STATUSES.includes(run.status))
      throw rpcError(ErrorCode.invalidTransition, `el run está ${run.status}`)
    return run
  }

  /** Aplica en el proveedor un cambio ya registrado; si no puede, queda el evento. */
  private applyLive(
    run: RunRow,
    change: (a: ClaudeAdapter | CodexAdapter) => Promise<LiveChange>,
  ): void {
    this.track(
      change(this.providerOf(run))
        .catch((e: unknown) => ({ error: e instanceof Error ? e.message : String(e) }))
        .then((r) => {
          if ("error" in r) this.emitSystem("run.live_change_failed", run.id, { message: r.error })
        }),
    )
  }

  /**
   * ADR-0020 §7: contestar o rechazar una pregunta del agente. Aprobar exige
   * respuestas; un plan aprobado puede cambiar el modo del run.
   */
  private resolveQuestion(
    uow: UnitOfWork,
    a: NonNullable<ReturnType<Repo["getApproval"]>>,
    tool: string,
    p: Params<"approvals.resolve">,
  ) {
    if (p.decision !== "approve_once" && p.decision !== "deny")
      throw rpcError(
        ErrorCode.invalidParams,
        "una pregunta del agente se contesta (approve_once) o se rechaza (deny)",
      )
    const answers = p.answers ?? {}
    if (p.decision === "approve_once" && tool === "AskUserQuestion") {
      const op = JSON.parse(a.operation_json) as { input?: { questions?: { question?: string }[] } }
      const asked = (op.input?.questions ?? []).map((q) => String(q.question ?? ""))
      const missing = asked.filter((q) => !answers[q]?.trim())
      if (asked.length === 0 || missing.length > 0)
        throw rpcError(ErrorCode.invalidParams, "faltan respuestas", { missing })
    }
    const decision = p.decision === "deny" ? "denied" : "approved"
    this.repo.setApproval(a.id, decision, uow.actorId)
    const run = this.repo.getRun(a.run_id)
    if (decision === "approved" && tool === "ExitPlanMode" && p.then_mode && run) {
      const mode = p.then_mode
      const before = runOptionsFor(run)
      const checked = this.runOptions(run.project_id, run.purpose, this.providerName(run), {
        permission_mode: mode,
      })
      const updated = this.repo.mergeManifest(run.id, {
        options: { ...before, permission_mode: checked.permission_mode },
      })
      uow.emit("run.mode_changed", run.id, {
        from: before.permission_mode,
        to: checked.permission_mode,
        applies: "now",
        actor: { id: uow.actorId },
      })
      uow.emit("run.updated", run.id, this.repo.runView(updated))
    }
    const resolution: ApprovalResolution = {
      decision,
      ...(decision === "approved" && p.then_mode ? { then_mode: p.then_mode } : {}),
      ...(decision === "approved" && tool === "AskUserQuestion" ? { answers } : {}),
      ...(p.annotations ? { annotations: p.annotations } : {}),
      ...(p.reason ? { reason: p.reason } : {}),
    }
    uow.afterCommit(() => this.approvalWaiters.get(a.id)?.(resolution))
    return { approval_id: a.id, state: decision as "approved" | "denied" }
  }

  private providerOf(run: RunRow): ClaudeAdapter | CodexAdapter {
    const m = JSON.parse(run.context_manifest_json) as { provider?: string }
    return m.provider === "codex" ? this.codex : this.claude
  }

  /**
   * Sesión del proveedor del run padre, para retomarla (ADR-0019 §3). Sólo si
   * el hijo trabaja en la misma carpeta: el proveedor busca la sesión por ella.
   */
  private resumeOf(run: RunRow, cwd: string): string | null {
    if (!run.parent_run_id) return null
    const parent = this.repo.getRun(run.parent_run_id)
    if (!parent) return null
    const m = JSON.parse(parent.context_manifest_json) as {
      session_id?: string
      cwd?: string
      provider_process?: { session_id?: string; cwd?: string | null }
    }
    const id = m.session_id ?? m.provider_process?.session_id ?? null
    const parentCwd = m.cwd ?? m.provider_process?.cwd ?? null
    if (id && parentCwd && parentCwd !== cwd) {
      this.emitSystem("run.resume_skipped", run.id, {
        reason: "el worktree del run anterior ya no existe; el agente empieza una sesión nueva",
        parent_cwd: parentCwd,
        cwd,
      })
      return null
    }
    return id
  }

  /**
   * El sandbox de un run `execute` (ADR-0018 §3): sólo escribe en su worktree,
   * en el `.git` común del repo (para commitear) y en el estado del proveedor;
   * no ve la puerta humana ni el estado de Keel, salvo su token y la puerta de
   * agentes. null si no hay bubblewrap o está apagado.
   */
  async sandboxFor(run: RunRow, cwd: string): Promise<{ bwrap: string; spec: SandboxSpec } | null> {
    if (run.purpose !== "execute" || this.opts.sandbox === "off") return null
    const bwrap = bwrapPath()
    if (!bwrap) return null
    const writable = [cwd]
    try {
      writable.push((await openRepo(cwd)).commonDir)
    } catch {
      // Sin git (modo sin VCS): sólo la carpeta del run.
    }
    const providerState = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude")
    if (existsSync(providerState)) writable.push(providerState)
    const humanDoor = this.server.path
    const hidden = [dirname(this.opts.dbPath)]
    if (!isNamedPipe(humanDoor)) hidden.push(dirname(humanDoor))
    // ADR-0025 §10: ni el llavero (por el bus de D-Bus en $XDG_RUNTIME_DIR), ni ~/.ssh,
    // ni el ssh-agent del humano. Lo que no existe no se tapa.
    for (const p of [
      process.env.XDG_RUNTIME_DIR,
      join(homedir(), ".ssh"),
      process.env.SSH_AUTH_SOCK ? dirname(process.env.SSH_AUTH_SOCK) : undefined,
    ])
      if (p && existsSync(p) && p !== homedir() && p !== "/" && !p.startsWith("/tmp"))
        hidden.push(p)
    return {
      bwrap,
      spec: {
        writable,
        hidden: [...new Set(hidden)],
        reopened: [this.agentServer.path, this.agentTokens.dirFor(run.id)],
        unsetenv: ["SSH_AUTH_SOCK", "DBUS_SESSION_BUS_ADDRESS", "GNOME_KEYRING_CONTROL"],
      },
    }
  }

  /** La conexión viva que pidió este emparejamiento, si sigue abierta. */
  private pairingClient(pairingId: string): ClientState | null {
    for (const c of [...this.server.clients, ...this.agentServer.clients])
      if (c.actor && "pairing_id" in c.actor && c.actor.pairing_id === pairingId && !c.closed)
        return c
    return null
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

  private semanticList(projectId: string, p: Params<"semantic.list">) {
    const where = ["project_id = ?", "seq > ?"]
    const args: (string | number)[] = [projectId, p.after_seq ?? 0]
    if (p.run_id) {
      where.push("run_id = ?")
      args.push(p.run_id)
    }
    if (p.work_item_id) {
      where.push("work_item_id = ?")
      args.push(p.work_item_id)
    }
    if (p.kinds?.length) {
      where.push(`kind IN (${p.kinds.map(() => "?").join(",")})`)
      args.push(...p.kinds)
    }
    type Row = {
      seq: number
      id: string
      kind: string
      schema_version: number
      coverage: "instrumented" | "observed" | "inferred"
      sensitivity: "internal" | "restricted"
      interpreter: string
      run_id: string | null
      work_item_id: string | null
      tool_use_id: string | null
      source_event_ids_json: string
      artifact_refs_json: string
      payload_json: string
      occurred_at: string | null
      created_at: string
    }
    return (
      this.store.db
        .query<Row, (string | number)[]>(
          `SELECT * FROM semantic_events WHERE ${where.join(" AND ")} ORDER BY seq LIMIT ${Math.min(p.limit ?? 500, 1000)}`,
        )
        .all(...args)
        // created_at es de la proyección, no del hecho: reconstruir lo cambia y no se expone.
        .map(
          ({ source_event_ids_json, artifact_refs_json, payload_json, created_at: _c, ...r }) => ({
            ...r,
            source_event_ids: JSON.parse(source_event_ids_json) as string[],
            artifact_refs: JSON.parse(artifact_refs_json) as string[],
            payload: JSON.parse(payload_json) as unknown,
          }),
        )
    )
  }

  /**
   * ADR-0015 §7: al cerrar el run, los commits de su rama que no pasaron por un
   * plan aprobado se registran para que el intérprete los dé como `inferred`.
   */
  private async detectCommits(runId: string): Promise<void> {
    const planned = new Set(
      this.store.db
        .query<{ sha: string }, [string]>(
          `SELECT json_extract(payload_json, '$.sha') sha FROM events
            WHERE run_id = ? AND kind = 'git.commit.created' AND json_extract(payload_json, '$.plan_id') IS NOT NULL`,
        )
        .all(runId)
        .map((r) => r.sha),
    )
    for (const wt of this.repo.runWorktrees(runId)) {
      if (!existsSync(wt.worktree_path)) continue
      let log: string
      try {
        log = (
          await gitExec(["log", "--format=%H%x00%s%x00%D", `${wt.base_sha}..HEAD`], {
            cwd: wt.worktree_path,
          })
        ).stdout
      } catch {
        continue
      }
      const commits = log
        .split("\n")
        .filter(Boolean)
        .map((l) => {
          const [sha, message] = l.split("\0")
          return { sha: sha as string, message: message ?? "", branch: wt.branch_name }
        })
        .filter((c) => !planned.has(c.sha))
      if (commits.length)
        this.emitSystem("git.commits.detected", runId, { worktree: wt.worktree_path, commits })
    }
  }

  /**
   * Una operación que necesita al humano (ADR-0013): aprobación con el hash de
   * la operación exacta, en el inbox y en el chat del run, con deny-on-timeout.
   */
  private async askHuman(
    projectId: string,
    runId: string,
    op: { tool: string; input: unknown },
  ): Promise<"approved" | "denied" | "expired"> {
    const hash = await sha256Hex(canonicalJson({ ...op, run_id: runId }))
    const timeout = this.settingsView().approvals.timeout_ms
    const expires = timeout === null ? null : new Date(Date.now() + timeout).toISOString()
    const saved = redact({ ...op, run_id: runId }).value as { input?: unknown }
    const approvalId = this.repo.createApproval({
      project_id: projectId,
      run_id: runId,
      operation_hash: hash,
      operation: saved,
      expires_at: expires,
    })
    runUnitOfWork(this.uowDeps(), this.systemScope(projectId), (uow) =>
      uow.emit("approval.requested", runId, {
        approval_id: approvalId,
        operation_hash: hash,
        tool: op.tool,
        input: saved.input,
        expires_at: expires,
      }),
    )
    const { decision } = await this.waitApproval(approvalId, timeout)
    if (decision === "expired") this.repo.setApproval(approvalId, "expired", null)
    else if (decision === "approved") this.repo.setApproval(approvalId, "consumed", null)
    runUnitOfWork(this.uowDeps(), this.systemScope(projectId), (uow) =>
      uow.emit("approval.resolved", runId, { approval_id: approvalId, decision }),
    )
    return decision
  }

  private gitPlanDeps(): GitPlansDeps {
    return {
      artifacts: this.artifacts,
      emit: (runId, kind, payload) => this.emitSystem(kind, runId, payload),
      gh: this.opts.gh === undefined ? (Bun.which("gh") ?? null) : this.opts.gh,
    }
  }

  /** El worktree del run: el del agente, o el que nombra el humano. */
  private worktreeFor(ctx: HandlerContext, runId?: string): { runId: string; worktree: string } {
    const agent = ctx.actor.kind === "agent" ? ctx.actor : null
    if (agent && runId && runId !== agent.run_id)
      throw rpcError(ErrorCode.unauthorized, "el agente sólo opera en el worktree de su run")
    const id = agent ? agent.run_id : (runId ?? null)
    if (!id)
      throw rpcError(
        ErrorCode.invalidParams,
        "las tools de git necesitan un run de Keel con worktree (una sesión externa no tiene)",
      )
    const wt = this.repo
      .runWorktrees(id)
      .find((w) => w.slot === "root" && existsSync(w.worktree_path))
    if (!wt) throw rpcError(ErrorCode.notFound, "el run no tiene worktree")
    return { runId: id, worktree: wt.worktree_path }
  }

  private resolveGitPlan(
    uow: UnitOfWork,
    a: NonNullable<ReturnType<Repo["getApproval"]>>,
    input: unknown,
    decision: Params<"approvals.resolve">["decision"],
  ) {
    if (decision === "approve_session" || decision === "approve_always" || decision === "amend")
      throw rpcError(ErrorCode.invalidParams, "un plan de git se aprueba una vez o se deniega")
    if (a.expires_at && a.expires_at < nowIso()) {
      this.repo.setApproval(a.id, "expired", null)
      uow.emit("git.plan.expired", a.run_id, { plan_id: a.id, reason: "venció sin decisión" })
      throw rpcError(ErrorCode.invalidTransition, "el plan caducó; hace falta proponer otro")
    }
    if (decision === "deny") {
      this.repo.setApproval(a.id, "denied", uow.actorId)
      uow.emit("approval.resolved", a.run_id, { approval_id: a.id, decision: "denied" })
      return { approval_id: a.id, state: "denied" as const }
    }
    const plan = GitPlanSchema.parse(input)
    this.repo.setApproval(a.id, "approved", uow.actorId)
    uow.emit("approval.resolved", a.run_id, { approval_id: a.id, decision: "approved" })
    uow.emit("git.plan.approved", a.run_id, { plan_id: a.id, plan_hash: a.operation_hash })
    uow.afterCommit(() => this.track(this.runGitPlan(a.id, plan)))
    return { approval_id: a.id, state: "approved" as const }
  }

  private async runGitPlan(planId: string, plan: GitPlan): Promise<void> {
    const run = this.repo.getRun(plan.run_id)
    const item = run ? this.repo.getWorkItem(run.work_item_id) : null
    if (!run || !item) return
    const manifest = JSON.parse(run.context_manifest_json) as { provider?: string }
    const env = agentEnv(run, item, manifest.provider === "codex" ? "Codex" : "Claude")
    const approver = this.repo.getApproval(planId)?.decision_actor ?? null
    const r = await executePlan(this.gitPlanDeps(), planId, plan, env)
    this.repo.setApproval(planId, r.ok ? "consumed" : "expired", null)
    // ADR-0022 §2: el cierre de una subtarea es integrarla a la feature; si choca, vuelve.
    if (r.ok && item.parent_work_item_id && this.repo.getFlow(item.id)?.stage === "close") {
      const integrated = await this.integrateSubtask(item, plan)
      if (!integrated.ok) {
        runUnitOfWork(this.uowDeps(), this.systemScope(run.project_id), (uow) => {
          this.repo.updateFlow(item.id, { stage: "implement" })
          uow.emit("task.stage_changed", run.id, {
            work_item_id: item.id,
            from: "close",
            to: "implement",
            ceremony: this.repo.getFlow(item.id)?.ceremony ?? null,
            authorized_by: "system:keel",
            delegated: true,
            reason: integrated.message,
          })
        })
        this.closedByPlan.delete(item.id)
        this.continueFlow(
          item.id,
          `No se pudo integrar a la feature: ${integrated.message}. Resuelve el conflicto en tu frontera y vuelve a cerrar.`,
        )
        return
      }
    }
    // ADR-0021 §4: en el cierre del método, el plan aprobado es el gate (c): la tarea termina.
    const flow = this.repo.getFlow(item.id)
    const current = this.repo.getWorkItem(item.id)
    // Si el run sigue vivo, la tarea aún no espera la revisión: se cierra al asentarlo.
    if (r.ok && flow?.stage === "close" && current?.lifecycle === "running")
      this.closedByPlan.set(item.id, approver ?? "system:daemon")
    if (r.ok && flow?.stage === "close" && current?.lifecycle === "needs_review")
      runUnitOfWork(
        this.uowDeps(),
        { projectId: run.project_id, actorId: approver ?? "system:daemon" },
        (uow) => {
          this.transition(uow, current, "done", "human_close", {
            runId: run.id,
            reason: "el humano aprobó el plan de cierre",
          })
          uow.emit("task.closed", run.id, { work_item_id: item.id, plan_id: planId, approver })
        },
      )
    // El diff aprobado queda como evidencia de la tarea (ADR-0015 §6, ADR-0012).
    if (r.ok && plan.diff_ref) {
      const sha = parseArtifactRef(plan.diff_ref) as string
      runUnitOfWork(this.uowDeps(), this.systemScope(run.project_id), (uow) => {
        const ev = this.repo.addEvidence({
          project_id: run.project_id,
          work_item_id: run.work_item_id,
          run_id: run.id,
          kind: "diff",
          title: `Diff aprobado · ${plan.files.length} archivo(s)`,
          artifact_ref: plan.diff_ref as string,
          sha256: sha,
          metadata: { plan_id: planId, files: plan.files },
          provenance: {
            actor: { id: "system:daemon", kind: "system" },
            captured_at: nowIso(),
            source: { git_plan: planId, branch: plan.branch, head: plan.expected_head_sha },
            input_sha256: plan.content_hash,
          },
          created_by: "system:daemon",
          supersedes_id: null,
        })
        uow.emit("evidence.attached", run.id, this.evidenceView(ev))
      })
    }
  }

  /** Estado del plan a partir de su aprobación y de sus eventos. */
  private gitPlanState(planId: string, approvalState: string, expiresAt: string | null) {
    const events = this.store.db
      .query<{ kind: string; payload_json: string }, [string]>(
        `SELECT kind, payload_json FROM events
          WHERE kind LIKE 'git.%' AND json_extract(payload_json, '$.plan_id') = ? ORDER BY event_seq`,
      )
      .all(planId)
    const lastEvent = events.at(-1)
    const last = lastEvent?.kind
    const reason =
      last === "git.plan.failed" || last === "git.plan.expired"
        ? ((JSON.parse(lastEvent?.payload_json ?? "{}") as { reason?: string }).reason ?? null)
        : null
    const steps = events
      .filter((e) => /^git\.(commit|push|pull_request)\./.test(e.kind))
      .map((e) => ({
        op: e.kind,
        state: e.kind.endsWith(".pending") ? "skipped" : "done",
        detail: JSON.parse(e.payload_json) as unknown,
      }))
    const state =
      last === "git.plan.completed"
        ? "completed"
        : last === "git.plan.failed"
          ? "failed"
          : last === "git.plan.expired" || approvalState === "expired"
            ? "expired"
            : approvalState === "denied"
              ? "denied"
              : approvalState === "approved" || approvalState === "consumed"
                ? "executing"
                : expiresAt && expiresAt < nowIso()
                  ? "expired"
                  : "pending"
    return {
      state: state as "pending" | "denied" | "expired" | "executing" | "completed" | "failed",
      reason,
      steps,
    }
  }

  evidenceView(e: EvidenceRow) {
    const sha = parseArtifactRef(e.artifact_ref)
    const a = sha ? this.artifacts.get(sha) : null
    return {
      id: e.id,
      work_item_id: e.work_item_id,
      run_id: e.run_id,
      kind: e.kind,
      title: e.title,
      artifact_ref: e.artifact_ref,
      sha256: e.sha256,
      size: a?.size ?? null,
      media_type: a?.media_type ?? null,
      sensitivity: a?.sensitivity ?? null,
      integrity: a?.integrity ?? null,
      metadata: JSON.parse(e.metadata_json) as unknown,
      provenance: JSON.parse(e.provenance_json) as unknown,
      created_by: e.created_by,
      supersedes_id: e.supersedes_id,
      created_at: e.created_at,
    }
  }

  /**
   * Purga explícita (ADR-0012 §7): eventos del proyecto más viejos que el
   * corte (filtrados por tipo si se pide), su evidencia sólo si se nombra, y
   * los artefactos que quedan sin referencias. Deja la marca de la purga para
   * que un cursor anterior reciba `cursor_expired`.
   */
  private purge(
    projectId: string,
    p: Params<"retention.purge">,
    actorId: string,
  ): { events: number; evidence: number; artifacts: number; dry_run: boolean } {
    const db = this.store.db
    const cutoff = new Date(Date.now() - p.older_than_days * 86_400_000).toISOString()
    const kinds = p.event_kinds ?? []
    const kindSql = kinds.length ? ` AND kind IN (${kinds.map(() => "?").join(",")})` : ""
    const evWhere = `project_id = ? AND received_at < ?${kindSql}`
    const evArgs = [projectId, cutoff, ...kinds]
    const events =
      db
        .query<{ n: number }, string[]>(`SELECT count(*) n FROM events WHERE ${evWhere}`)
        .get(...evArgs)?.n ?? 0
    const evidenceWhere = "project_id = ? AND created_at < ?"
    const evidence = p.include_evidence
      ? (db
          .query<{ n: number }, string[]>(`SELECT count(*) n FROM evidence WHERE ${evidenceWhere}`)
          .get(projectId, cutoff)?.n ?? 0)
      : 0
    if (p.dry_run) return { events, evidence, artifacts: 0, dry_run: true }
    const maxSeq =
      db
        .query<{ m: number | null }, string[]>(
          `SELECT max(event_seq) m FROM events WHERE ${evWhere}`,
        )
        .get(...evArgs)?.m ?? null
    // Los eventos son append-only: el trigger sólo deja borrar con la purga marcada.
    const purgeId = ulid()
    db.query("INSERT INTO retention_in_progress(purge_id, actor_id) VALUES (?, ?)").run(
      purgeId,
      actorId,
    )
    db.query(`DELETE FROM events WHERE ${evWhere}`).run(...evArgs)
    db.query("DELETE FROM retention_in_progress WHERE purge_id = ?").run(purgeId)
    if (p.include_evidence)
      db.query(`DELETE FROM evidence WHERE ${evidenceWhere}`).run(projectId, cutoff)
    if (maxSeq !== null)
      db.query(
        "INSERT INTO event_purges(project_id, before_event_seq, events_deleted, reason, actor_id) VALUES (?,?,?,?,?)",
      ).run(projectId, maxSeq + 1, events, `older_than_days=${p.older_than_days}`, actorId)
    return { events, evidence, artifacts: this.collectArtifacts(), dry_run: false }
  }

  /** Artefactos sin referencias en eventos, tool calls ni evidencia: se recolectan. */
  private collectArtifacts(): number {
    const db = this.store.db
    const referenced = new Set<string>()
    const add = (text: string | null) => {
      for (const m of (text ?? "").matchAll(/artifact:sha256:([0-9a-f]{64})/g))
        referenced.add(m[1] as string)
    }
    for (const r of db.query<{ v: string }, []>("SELECT artifact_ref v FROM evidence").all())
      add(r.v)
    for (const r of db
      .query<{ v: string | null }, []>(
        "SELECT artifact_ref v FROM tool_calls WHERE artifact_ref IS NOT NULL",
      )
      .all())
      add(r.v)
    // Los documentos de la tarea (ADR-0021) no se purgan mientras su fila exista.
    for (const r of db.query<{ v: string }, []>("SELECT artifact_ref v FROM task_docs").all())
      add(r.v)
    for (const r of db
      .query<{ v: string }, []>(
        "SELECT payload_json v FROM events WHERE payload_json LIKE '%artifact:sha256:%'",
      )
      .all())
      add(r.v)
    let removed = 0
    for (const a of db.query<{ sha256: string }, []>("SELECT sha256 FROM artifacts").all())
      if (!referenced.has(a.sha256)) {
        this.artifacts.remove(a.sha256)
        removed++
      }
    return removed
  }

  private projectViewOf(projectId: string) {
    const row = this.repo.listProjects().find((x) => x.id === projectId)
    if (!row) throw rpcError(ErrorCode.notFound, "el proyecto no existe")
    return projectView(row)
  }

  /** Un evento del sistema en un proyecto concreto, sin run. */
  private emitIn(projectId: string, kind: string, payload: unknown): void {
    runUnitOfWork(this.uowDeps(), this.systemScope(projectId), (uow) =>
      uow.emit(kind, null, payload),
    )
  }

  private emitSystem(kind: string, runId: string | null, payload: unknown): void {
    const projectId = runId ? this.repo.getRun(runId)?.project_id : undefined
    runUnitOfWork(this.uowDeps(), this.systemScope(projectId), (uow) =>
      uow.emit(kind, runId, payload),
    )
  }

  /** Tras un run terminal, la tarea sale de `running` y, si el final lo pide, se encola la liberación. */
  private settleWorkItem(final: RunRow, origin: ReleaseOrigin): void {
    runUnitOfWork(this.uowDeps(), this.systemScope(final.project_id), (uow) =>
      this.settleInTransaction(uow, final, origin),
    )
  }

  private settleInTransaction(uow: UnitOfWork, final: RunRow, origin: ReleaseOrigin): void {
    if (final.purpose !== "execute") return
    // ADR-0021: en el método, terminar un turno no es terminar la tarea. Sólo el cierre
    // espera la revisión humana; antes, la tarea espera a que el humano le escriba.
    const flow = this.repo.getFlow(final.work_item_id)
    const to: Lifecycle =
      final.status === "completed"
        ? flow && flow.stage !== "close"
          ? "waiting_human"
          : "needs_review"
        : final.status === "cancelled"
          ? "planned"
          : "failed"
    const w = this.repo.getWorkItem(final.work_item_id)
    if (w?.lifecycle === "running") {
      const settled = this.transition(uow, w, to, "system", {
        runId: final.id,
        reason: `run ${final.status}`,
      })
      // El plan de cierre ya se aplicó con el run vivo: el humano lo aprobó, la tarea termina.
      const approver = this.closedByPlan.get(w.id)
      if (approver && settled.lifecycle === "needs_review") {
        this.closedByPlan.delete(w.id)
        this.transition(uow, settled, "done", "human_close", {
          runId: final.id,
          reason: `el humano (${approver}) aprobó el plan de cierre`,
        })
        uow.emit("task.closed", final.id, { work_item_id: w.id, approver })
      }
    }
    if (releasesOnFinish(final.status)) this.enqueueRelease(uow, final.id, origin)
  }

  /** Los eventos del sistema van al proyecto de su run; sin run, al proyecto por defecto. */
  private systemScope(projectId?: string) {
    return { projectId: projectId ?? this.project.project_id, actorId: "system:daemon" }
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

/** Clave del ajuste de ADR-0008 §2 (migración 0011). */
/** Opciones efectivas guardadas en el manifest del run (ADR-0019 §4, ADR-0020 §4). */
type RunOptionsRecord = {
  model: string | null
  max_turns: number | null
  permission_mode: PermissionMode
  effort?: Effort | null
}

function runOptionsFor(run: RunRow): RunOptionsRecord {
  const m = JSON.parse(run.context_manifest_json) as { options?: Partial<RunOptionsRecord> }
  return {
    model: m.options?.model ?? null,
    max_turns: m.options?.max_turns ?? null,
    permission_mode: m.options?.permission_mode ?? "ask",
    effort: m.options?.effort ?? null,
  }
}

/** Codex no tiene `xhigh` ni `max`: se quedan en su nivel más alto. */
function codexEffort(e: Effort): "low" | "medium" | "high" {
  return e === "low" || e === "medium" ? e : "high"
}

const CODEX_SUBSCRIPTION = "codex.subscription_enabled"
const APPROVALS_TIMEOUT = "approvals.timeout_ms"
const PROMPT_SUGGESTIONS = "claude.prompt_suggestions"
/** ADR-0019 §4: el modelo con que arranca una tarea nueva, por proveedor. */
const DEFAULT_MODELS = "runs.default_models"
type DefaultModels = Partial<Record<"claude" | "codex", { model: string; effort: Effort | null }>>
const LIMITS = "daemon.limits"

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

/** Código corto que el humano compara entre la sesión del agente y la bandeja de Keel. */
function pairingCode(): string {
  const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"
  return [...randomBytes(6)].map((b) => alphabet[b % alphabet.length]).join("")
}

/**
 * Atribución en el proceso del agente (ADR-0018 §1): los commits salen a su
 * nombre sin tocar la configuración de git del usuario, y el correo lleva el
 * run. `KEEL_RUN_ID` y `KEEL_ACTOR` sirven para que hooks y herramientas
 * etiqueten lo que hacen; no son seguridad.
 */
export function agentEnv(run: RunRow, item: WorkItemRow, who: string): Record<string, string> {
  const name = `${who} (Keel ${item.display_id})`
  const email = `${run.id.toLowerCase()}@agents.keel.local`
  return {
    GIT_AUTHOR_NAME: name,
    GIT_AUTHOR_EMAIL: email,
    GIT_COMMITTER_NAME: name,
    GIT_COMMITTER_EMAIL: email,
    KEEL_RUN_ID: run.id,
    KEEL_ACTOR: `agent:${run.id}`,
  }
}

function projectView(p: ReturnType<Repo["listProjects"]>[number]) {
  // Los proyectos de antes de ADR-0019 se llaman «default»: se muestra su carpeta.
  const name = p.name === "default" ? basename(p.root_path) || p.root_path : p.name
  return { id: p.id, name, root_path: p.root_path, vcs: p.vcs, last_opened_at: p.last_opened_at }
}

/** ADR-0022: lo que el agente de una feature o de una subtarea tiene que saber de su rama. */
export function featureHeader(own: FeatureInfo | null, parent: FeatureInfo | null): string {
  if (parent)
    return `\n[Keel] Es una subtarea de la feature (rama ${parent.branch}): trabaja sólo en su frontera (la story la nombra) y lee los documentos del padre con task_doc_get. Al cerrar, propone con git_propose sólo el commit: Keel la integra a la rama de la feature; no hagas push ni PR.`
  if (own)
    return `\n[Keel] Es una feature: sus subtareas ya se integraron en la rama ${own.branch}, que es tu worktree. Revisa la feature entera contra la spec. Al cerrar, propone con git_propose el push a ${own.branch} y la PR a ${own.base}.`
  return ""
}

/** ADR-0024: el encabezado de la conversación del proyecto. Aquí no hay tarea que trabajar. */
export function conversationHeader(): string {
  return [
    "[Keel] Conversación del proyecto, de sólo lectura: responde preguntas sobre el código; no edites nada.",
    "Si encuentras algo que hay que hacer (un bug, un issue de seguridad, una mejora), créalo con la tool task_create:",
    "título, kind, priority (urgent si es de seguridad) y en context_markdown los archivos, la evidencia y por qué importa.",
    "Antes, busca con context_search: puede que ya exista. Lo que valga guardar sin ser tarea, guárdalo con note_add.",
    "Las tools de Keel funcionan aunque estés en modo plan.",
  ].join(" ")
}

/** Encabezado corto del prompt (ADR-0017 §1): tarea, id y cómo pedir el contexto. */
export function promptHeader(item: WorkItemRow): string {
  return [
    `[Keel] Tarea ${item.display_id} «${item.title}» (id ${item.id}).`,
    "Su especificación, notas y evidencia están en el recurso keel://task/current;",
    "el contexto del proyecto, en keel://project/context; busca lo demás con la tool context_search.",
  ].join(" ")
}

function reportView(r: {
  id: string
  work_item_id: string
  version: number
  sha256: string
  markdown: string
  created_by: string
  created_at: string
}) {
  return {
    id: r.id,
    work_item_id: r.work_item_id,
    version: r.version,
    sha256: r.sha256,
    markdown: r.markdown,
    created_by: r.created_by,
    created_at: r.created_at,
  }
}

function researchFailure(e: unknown): RpcFailure {
  if (e instanceof RpcFailure) return e
  if (e instanceof ResearchError)
    return rpcError(
      e.code === "not_found"
        ? ErrorCode.notFound
        : e.code === "denied"
          ? ErrorCode.unauthorized
          : ErrorCode.invalidParams,
      e.message,
    )
  return rpcError(ErrorCode.internal, e instanceof Error ? e.message : String(e))
}

function researchCall<T>(f: () => T): T {
  try {
    return f()
  } catch (e) {
    throw researchFailure(e)
  }
}

/** Errores del intermediario → errores del protocolo. */
function brokerFailure(e: unknown): RpcFailure {
  if (e instanceof RpcFailure) return e
  if (e instanceof BrokerError)
    return rpcError(
      e.code === "not_found"
        ? ErrorCode.notFound
        : e.code === "denied"
          ? ErrorCode.unauthorized
          : e.code === "invalid"
            ? ErrorCode.invalidParams
            : ErrorCode.internal,
      e.message,
    )
  return rpcError(ErrorCode.internal, e instanceof Error ? e.message : String(e))
}

function brokerCall<T>(f: () => T): T {
  try {
    return f()
  } catch (e) {
    throw brokerFailure(e)
  }
}

function ruleView(r: PermissionRuleRow) {
  const pattern = { tool: r.tool, prefix: r.prefix, exact: r.exact === 1 }
  return {
    id: r.id,
    ...pattern,
    effect: r.effect,
    label: describePattern(pattern),
    source_approval_id: r.source_approval_id,
    created_by: r.created_by,
    created_at: r.created_at,
    expires_at: r.expires_at,
    revoked_at: r.revoked_at,
  }
}

function pairingView(p: PairingRow) {
  return {
    id: p.id,
    code: p.code,
    client_name: p.client_name,
    cwd: p.cwd,
    state: p.state,
    project_id: p.project_id,
    work_item_id: p.work_item_id,
    scopes: JSON.parse(p.scopes_json) as AgentScope[],
    created_at: p.created_at,
  }
}

function runRequestView(r: RunRequestRow) {
  return {
    id: r.id,
    work_item_id: r.work_item_id,
    purpose: r.purpose,
    prompt: r.prompt,
    profile: r.profile,
    reason: r.reason,
    requested_by: r.requested_by,
    state: r.state,
    run_id: r.run_id,
    created_at: r.created_at,
  }
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

/** Tipo de un archivo adjuntado desde el worktree, por su extensión. */
function mediaTypeOf(path: string): string {
  const types: Record<string, string> = {
    ".json": "application/json",
    ".md": "text/markdown",
    ".txt": "text/plain",
    ".log": "text/plain",
    ".csv": "text/csv",
    ".html": "text/html",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".svg": "image/svg+xml",
    ".diff": "text/x-diff",
    ".patch": "text/x-diff",
    ".xml": "application/xml",
  }
  return types[extname(path).toLowerCase()] ?? "application/octet-stream"
}

/** El resultado de la verificación en una línea: lo que lee el agente (ADR-0021 §4). */
function verifySummary(
  results: readonly VerifyResult[],
  delta: { green: boolean; newRed: string[]; stillRed: string[]; fixed: string[] },
): string {
  const head = delta.green ? "sin rojo nuevo" : `rojo nuevo en ${delta.newRed.join(", ")}`
  const parts = results.map(
    (r) =>
      `${r.name} ${r.ok ? "✓" : delta.stillRed.includes(r.name) ? "✗ (ya estaba rojo)" : "✗"} ${Math.round(r.duration_ms / 1000)} s`,
  )
  const fail = results.filter((r) => !r.ok && delta.newRed.includes(r.name))
  return `${head}. ${parts.join(" · ")}${fail.length ? `\n${fail.map((r) => `--- ${r.name}\n${r.tail}`).join("\n")}` : ""}`
}

/**
 * El envoltorio de `keel askpass` (ADR-0025 §4): `ssh` lo ejecuta sin shell, con el
 * prompt como argumento. Vive en el estado de Keel, que el sandbox tapa.
 */
function writeAskpass(path: string): void {
  const main = join(import.meta.dir, "main.ts")
  const cmd = existsSync(main)
    ? `exec '${process.execPath}' '${main}' askpass "$@"`
    : `exec '${process.execPath}' askpass "$@"`
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  writeFileSync(path, `#!/bin/sh\n${cmd}\n`, { mode: 0o700 })
}

/** ADR-0028: para GIT_ASKPASS; git no pide usuario ni contraseña por Keel. */
function writeNoAskpass(path: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  writeFileSync(path, "#!/bin/sh\nexit 1\n", { mode: 0o700 })
}

/**
 * Las opciones de un run anterior para el siguiente (ADR-0019 §3), con el tope de
 * turnos sólo si lo eligió el humano (ADR-0028): el 12 de antes por defecto no viaja.
 */
function inheritedOptions(run: RunRow | null): Params<"runs.start">["options"] {
  if (!run) return {}
  const m = JSON.parse(run.context_manifest_json) as {
    options?: Params<"runs.start">["options"] & { max_turns?: number | null }
    turns_explicit?: boolean
  }
  const { max_turns, ...rest } = m.options ?? {}
  return {
    ...rest,
    ...(m.turns_explicit && typeof max_turns === "number" ? { max_turns } : {}),
  } as Params<"runs.start">["options"]
}
