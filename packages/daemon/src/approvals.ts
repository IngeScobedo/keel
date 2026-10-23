/**
 * Gate de herramientas del daemon (SDD 02 §9): cada herramienta no
 * auto-aprobada abre una solicitud en `approval_requests`, pone el run en
 * `waiting_human` y espera la decisión humana hasta el plazo; al vencer,
 * deniega (deny-on-timeout) y la solicitud queda en el inbox. El SDK no lo hace
 * por su cuenta (FINDINGS §3). No depende del proveedor.
 */

import { redact } from "@keel/core"
import type { RunContext, ToolDecision, ToolGate, ToolRequest } from "./adapters/provider.js"
import { canonicalJson, sha256Hex } from "./ids.js"
import type { Repo } from "./store/repo.js"

export type ApprovalWaiter = (
  approvalId: string,
  timeoutMs: number,
) => Promise<"approved" | "denied" | "expired">

export type ApprovalGateDeps = {
  repo: Repo
  waitApproval: ApprovalWaiter
  timeoutMs: number
}

export class ApprovalGate implements ToolGate {
  private readonly deps: ApprovalGateDeps
  constructor(deps: ApprovalGateDeps) {
    this.deps = deps
  }

  async decide(ctx: RunContext, req: ToolRequest): Promise<ToolDecision> {
    const { repo, waitApproval, timeoutMs } = this.deps
    const run = ctx.run
    const operation = { tool: req.tool, input: req.input, run_id: run.id }
    // El hash es de la operación real (la que se ejecuta); lo guardado es la copia saneada.
    const hash = await sha256Hex(canonicalJson(operation))
    const expires = new Date(Date.now() + timeoutMs).toISOString()
    const approvalId = repo.createApproval({
      project_id: run.project_id,
      run_id: run.id,
      operation_hash: hash,
      operation: redact(operation).value,
      expires_at: expires,
    })
    repo.updateRun(run.id, { status: "waiting_human" })
    ctx.record(
      "approval.requested",
      `approval:${approvalId}`,
      { approval_id: approvalId, operation_hash: hash, tool: req.tool, expires_at: expires },
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
