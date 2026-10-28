/**
 * Gate de herramientas del daemon (SDD 02 §9): cada herramienta no
 * auto-aprobada abre una solicitud en `approval_requests`, pone el run en
 * `waiting_human` y espera la decisión humana. ADR-0020 §3: la espera no vence
 * salvo que el humano fije un límite; si vence, se niega (el tiempo nunca
 * aprueba). El SDK no lo hace por su cuenta (FINDINGS §3). No depende del
 * proveedor.
 *
 * `AskUserQuestion` y `ExitPlanMode` no son permisos sino preguntas (ADR-0020
 * §7): ninguna regla, concesión ni plazo las resuelve, y la respuesta del
 * humano vuelve al agente dentro de la entrada aprobada.
 */

import { isAbsolute, relative, resolve } from "node:path"
import {
  canonWritable,
  describePattern,
  filePathOf,
  matchesPattern,
  type PermissionMode,
  type PermissionPattern,
  redact,
  shellCommand,
} from "@keel/core"
import type { RunContext, ToolDecision, ToolGate, ToolRequest } from "./adapters/provider.js"
import { canonicalJson, sha256Hex, ulid } from "./ids.js"
import type { Repo } from "./store/repo.js"

/** Lo que decidió el humano, con lo que el agente necesita para seguir. */
export type ApprovalResolution = {
  decision: "approved" | "denied" | "expired"
  /** `AskUserQuestion`: texto de la pregunta → respuesta. */
  answers?: Record<string, string>
  annotations?: Record<string, { notes?: string | undefined; preview?: string | undefined }>
  /** Lo que el agente lee si se niega. */
  reason?: string
  /** Al aprobar un plan: el modo con el que sigue el run. */
  then_mode?: PermissionMode
}

/** null = sin límite. */
export type ApprovalWaiter = (
  approvalId: string,
  timeoutMs: number | null,
) => Promise<ApprovalResolution>

/** Herramientas que preguntan al humano: nunca se resuelven solas (ADR-0020 §7). */
export const QUESTION_TOOLS = new Set(["AskUserQuestion", "ExitPlanMode"])

/** Las tools que escriben un archivo; Codex manda sus cambios como `Edit`, sin ruta. */
const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"])

export type ApprovalGateDeps = {
  repo: Repo
  waitApproval: ApprovalWaiter
  /** Límite vigente de la espera; null = sin límite (ADR-0020 §3). */
  timeoutMs: number | null | (() => number | null)
  /** Dónde trabaja el run: una regla nunca cubre archivos fuera de ahí (ADR-0019 §4). */
  cwdOf?: (runId: string) => string | null
  /**
   * ADR-0021 §3: la etapa de la tarea del run. En una de sólo lectura Keel niega
   * sin preguntar; `inMethod` dice si la tarea la conduce el método.
   */
  stageOf?: (run: RunContext["run"]) => {
    stage: string | null
    readOnly: boolean
    inMethod: boolean
    /** ADR-0029 §3: en `close`, lo único que el agente puede editar. */
    canon?: { adr_dirs: string[]; sdd_dirs: string[]; roadmap: string | null }
  }
}

const GIT_PUSH = /(?:^|[\s;&|(])git(?:\s+-C\s+\S+)?\s+push\b/

/** «Aprobar para esta sesión»: dura el resto del run y como mucho 15 min (SDD 01 §10). */
export const SESSION_GRANT_MS = 15 * 60_000

type SessionGrant = PermissionPattern & { expires: number; approval_id: string }

export class ApprovalGate implements ToolGate {
  private readonly deps: ApprovalGateDeps
  private readonly grants = new Map<string, SessionGrant[]>()
  constructor(deps: ApprovalGateDeps) {
    this.deps = deps
  }

  /** El humano aprobó el patrón para el resto del run. */
  grantSession(runId: string, pattern: PermissionPattern, approvalId: string): void {
    const list = this.grants.get(runId) ?? []
    list.push({ ...pattern, expires: Date.now() + SESSION_GRANT_MS, approval_id: approvalId })
    this.grants.set(runId, list)
  }

  /** El run terminó: sus concesiones de sesión se olvidan. */
  forgetRun(runId: string): void {
    this.grants.delete(runId)
  }

  /** ¿La operación cae dentro del directorio del run? Sin ruta, no aplica. */
  /** La ruta que edita, relativa al worktree del run, cae en el canon. Sin ruta, no. */
  private inCanon(
    runId: string,
    input: unknown,
    canon: Parameters<typeof canonWritable>[1],
  ): boolean {
    const path = filePathOf(input)
    const cwd = this.deps.cwdOf?.(runId)
    if (path === null || !cwd) return false
    return canonWritable(relative(cwd, resolve(cwd, path)), canon)
  }

  private insideRun(runId: string, input: unknown): boolean {
    const path = filePathOf(input)
    if (path === null) return true
    const cwd = this.deps.cwdOf?.(runId)
    if (!cwd) return false
    const rel = relative(cwd, resolve(cwd, path))
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))
  }

  /**
   * Reglas del proyecto (primero `deny`) y concesiones de sesión. Lo que decide
   * una regla queda como evento `approval.auto`, para que se vea qué pasó sin
   * preguntar.
   */
  private automatic(
    ctx: RunContext,
    req: ToolRequest,
  ): { effect: "auto" | "deny"; source: string; label: string } | null {
    const run = ctx.run
    const rules = this.deps.repo
      .listPermissionRules(run.project_id)
      .map((r) => ({ ...r, pattern: { tool: r.tool, prefix: r.prefix, exact: r.exact === 1 } }))
      .filter((r) => matchesPattern(r.pattern, req.tool, req.input))
    const deny = rules.find((r) => r.effect === "deny")
    if (deny)
      return { effect: "deny", source: `rule:${deny.id}`, label: describePattern(deny.pattern) }
    if (!this.insideRun(run.id, req.input)) return null
    const auto = rules.find((r) => r.effect === "auto")
    if (auto)
      return { effect: "auto", source: `rule:${auto.id}`, label: describePattern(auto.pattern) }
    const now = Date.now()
    const grant = (this.grants.get(run.id) ?? []).find(
      (g) => g.expires > now && matchesPattern(g, req.tool, req.input),
    )
    if (grant)
      return {
        effect: "auto",
        source: `session:${grant.approval_id}`,
        label: describePattern(grant),
      }
    return null
  }

  /** Una negación que no pregunta: queda como `approval.auto` para verla en el chat. */
  private refuse(ctx: RunContext, req: ToolRequest, source: string, message: string): ToolDecision {
    ctx.record(
      "approval.auto",
      `approval.auto:${ctx.run.id}:${ulid()}`,
      {
        tool: req.tool,
        input: (redact({ input: req.input }).value as { input: unknown }).input,
        effect: "deny",
        source,
        label: source === "stage" ? "etapa de sólo lectura" : source,
      },
      null,
    )
    return { behavior: "deny", message }
  }

  async decide(ctx: RunContext, req: ToolRequest): Promise<ToolDecision> {
    const { repo, waitApproval } = this.deps
    const run = ctx.run
    // Las tools de Keel las autoriza el daemon en cada operación (ADR-0009): en modo
    // plan Claude Code igual las manda aquí, y negarlas dejaría al agente sin método.
    if (req.tool.startsWith("mcp__keel__")) return { behavior: "allow", input: req.input }
    const stage = this.deps.stageOf?.(run) ?? { stage: null, readOnly: false, inMethod: false }
    // En el método, salir de plan es avanzar de etapa: lo decide Keel, no un permiso.
    if (stage.inMethod && req.tool === "ExitPlanMode")
      return this.refuse(
        ctx,
        req,
        "stage",
        "Keel: en el método no se sale de plan con ExitPlanMode. Guarda el documento de la etapa con task_doc_put y avanza con stage_advance; Keel valida y, si hay gate, se lo pide al humano.",
      )
    if (stage.readOnly && !QUESTION_TOOLS.has(req.tool))
      return this.refuse(
        ctx,
        req,
        "stage",
        `Keel: la etapa ${stage.stage ?? "de planeación"} es de sólo lectura (ADR-0021). No edites ni corras comandos que cambien algo; guarda lo que produces con task_doc_put y avanza con stage_advance.`,
      )
    if (stage.canon && EDIT_TOOLS.has(req.tool) && !this.inCanon(run.id, req.input, stage.canon))
      return this.refuse(
        ctx,
        req,
        "stage",
        "Keel: en close sólo se escribe el canon del proyecto (ADR, SDD, roadmap) y los documentos de la tarea con task_doc_put (ADR-0029). Para cambiar código, vuelve a implement con stage_advance y el motivo en reason; después hay que revisar otra vez.",
      )
    const question = QUESTION_TOOLS.has(req.tool)
    // Una pregunta espera siempre: el tiempo no contesta por el humano.
    const limit =
      typeof this.deps.timeoutMs === "function" ? this.deps.timeoutMs() : this.deps.timeoutMs
    const timeoutMs = question ? null : limit
    // ADR-0015 §7: el perfil por defecto no empuja por shell; el plan aprobado sí.
    // Es una comodidad, no una frontera: el texto se puede disfrazar.
    const cmd = shellCommand(req.input)
    if (cmd !== null && GIT_PUSH.test(cmd)) {
      ctx.record(
        "approval.auto",
        `approval.auto:${run.id}:${ulid()}`,
        {
          tool: req.tool,
          input: { command: cmd },
          effect: "deny",
          source: "profile:git_push",
          label: "git push por shell",
        },
        null,
      )
      return {
        behavior: "deny",
        message:
          "Keel: git push por shell está desactivado. Usa la tool git_propose: arma un plan con commit, push y PR que el humano aprueba.",
      }
    }
    const auto = question ? null : this.automatic(ctx, req)
    if (auto) {
      ctx.record(
        "approval.auto",
        `approval.auto:${run.id}:${ulid()}`,
        {
          tool: req.tool,
          input: (redact({ input: req.input }).value as { input: unknown }).input,
          effect: auto.effect,
          source: auto.source,
          label: auto.label,
        },
        null,
      )
      return auto.effect === "auto"
        ? { behavior: "allow", input: req.input }
        : { behavior: "deny", message: `Keel: una regla del proyecto lo niega (${auto.label}).` }
    }
    const operation = { tool: req.tool, input: req.input, run_id: run.id }
    // El hash es de la operación real (la que se ejecuta); lo guardado es la copia saneada.
    const hash = await sha256Hex(canonicalJson(operation))
    const expires = timeoutMs === null ? null : new Date(Date.now() + timeoutMs).toISOString()
    const saved = redact(operation).value as { input?: unknown }
    const approvalId = repo.createApproval({
      project_id: run.project_id,
      run_id: run.id,
      operation_hash: hash,
      operation: saved,
      expires_at: expires,
    })
    repo.updateRun(run.id, { status: "waiting_human" })
    ctx.record(
      "approval.requested",
      `approval:${approvalId}`,
      // La entrada va redactada: quien decide desde el timeline ve qué se pide.
      {
        approval_id: approvalId,
        operation_hash: hash,
        tool: req.tool,
        input: saved.input,
        expires_at: expires,
      },
      null,
    )
    ctx.notifyRun()
    const resolution = await Promise.race([
      waitApproval(approvalId, timeoutMs),
      new Promise<ApprovalResolution>((resolve) =>
        req.signal.addEventListener("abort", () => resolve({ decision: "denied" }), {
          once: true,
        }),
      ),
    ])
    const decision = resolution.decision
    if (repo.getRun(run.id)?.status === "waiting_human")
      repo.updateRun(run.id, { status: "running" })
    if (decision === "expired") repo.setApproval(approvalId, "expired", null)
    ctx.record(
      "approval.resolved",
      `approval:${approvalId}:${decision}`,
      {
        approval_id: approvalId,
        decision,
        ...(resolution.answers ? { answers: resolution.answers } : {}),
        ...(resolution.annotations ? { annotations: resolution.annotations } : {}),
        ...(resolution.reason ? { reason: resolution.reason } : {}),
      },
      null,
    )
    ctx.notifyRun()
    if (decision === "approved") {
      repo.setApproval(approvalId, "consumed", null)
      // La respuesta viaja en la entrada aprobada: así la recibe el SDK (ADR-0020 §7).
      const input =
        req.tool === "AskUserQuestion"
          ? {
              ...req.input,
              answers: resolution.answers ?? {},
              ...(resolution.annotations ? { annotations: resolution.annotations } : {}),
            }
          : req.input
      return {
        behavior: "allow",
        input,
        ...(req.tool === "ExitPlanMode" && resolution.then_mode
          ? { mode: resolution.then_mode }
          : {}),
      }
    }
    const why = resolution.reason?.trim()
    return {
      behavior: "deny",
      message:
        decision === "expired"
          ? `Keel: sin decisión humana en ${Math.round((timeoutMs ?? 0) / 1000)} s; denegado al vencer el límite. La solicitud ${approvalId} queda en el inbox.`
          : req.tool === "AskUserQuestion"
            ? `Keel: el humano no quiso contestar la pregunta${why ? `: ${why}` : "."}`
            : req.tool === "ExitPlanMode"
              ? `Keel: el humano no aprueba el plan todavía; sigue planeando${why ? `. Indicación: ${why}` : "."}`
              : `Keel: denegado por el humano (${approvalId})${why ? `: ${why}` : "."}`,
    }
  }
}
