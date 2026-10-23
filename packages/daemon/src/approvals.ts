/**
 * Gate de herramientas del daemon (SDD 02 §9): cada herramienta no
 * auto-aprobada abre una solicitud en `approval_requests`, pone el run en
 * `waiting_human` y espera la decisión humana hasta el plazo; al vencer,
 * deniega (deny-on-timeout) y la solicitud queda en el inbox. El SDK no lo hace
 * por su cuenta (FINDINGS §3). No depende del proveedor.
 */

import { isAbsolute, relative, resolve } from "node:path"
import {
  describePattern,
  filePathOf,
  matchesPattern,
  type PermissionPattern,
  redact,
  shellCommand,
} from "@keel/core"
import type { RunContext, ToolDecision, ToolGate, ToolRequest } from "./adapters/provider.js"
import { canonicalJson, sha256Hex, ulid } from "./ids.js"
import type { Repo } from "./store/repo.js"

export type ApprovalWaiter = (
  approvalId: string,
  timeoutMs: number,
) => Promise<"approved" | "denied" | "expired">

export type ApprovalGateDeps = {
  repo: Repo
  waitApproval: ApprovalWaiter
  timeoutMs: number
  /** Dónde trabaja el run: una regla nunca cubre archivos fuera de ahí (ADR-0019 §4). */
  cwdOf?: (runId: string) => string | null
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

  async decide(ctx: RunContext, req: ToolRequest): Promise<ToolDecision> {
    const { repo, waitApproval, timeoutMs } = this.deps
    const run = ctx.run
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
    const auto = this.automatic(ctx, req)
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
    const expires = new Date(Date.now() + timeoutMs).toISOString()
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
    const decision = await Promise.race([
      waitApproval(approvalId, timeoutMs),
      new Promise<"denied">((resolve) =>
        req.signal.addEventListener("abort", () => resolve("denied"), { once: true }),
      ),
    ])
    if (repo.getRun(run.id)?.status === "waiting_human")
      repo.updateRun(run.id, { status: "running" })
    if (decision === "expired") repo.setApproval(approvalId, "expired", null)
    ctx.record(
      "approval.resolved",
      `approval:${approvalId}:${decision}`,
      { approval_id: approvalId, decision },
      null,
    )
    ctx.notifyRun()
    if (decision === "approved") {
      repo.setApproval(approvalId, "consumed", null)
      return { behavior: "allow", input: req.input }
    }
    return {
      behavior: "deny",
      message:
        decision === "expired"
          ? `Keel: sin decisión humana en ${Math.round(timeoutMs / 1000)} s; denegado (deny-on-timeout). La solicitud ${approvalId} queda en el inbox.`
          : `Keel: denegado por el humano (${approvalId}).`,
    }
  }
}
