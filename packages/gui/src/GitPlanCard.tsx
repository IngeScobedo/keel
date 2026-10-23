import { type GitPlan, GitPlanSchema } from "@keel/core"
import { Check, GitBranch, GitPullRequest, Upload, X } from "lucide-react"
import { useState } from "react"
import { mutationMeta } from "./client.js"
import { ArtifactView } from "./Evidence.js"
import { Button, Hint } from "./ui.js"
import type { useWorkspace } from "./useWorkspace.js"

type Call = ReturnType<typeof useWorkspace>["call"]

/**
 * Tarjeta de un plan de git (ADR-0015 §2): se aprueba el efecto, no un texto.
 * Archivos con +/-, mensaje, rama y remoto de destino, PR y worktree. Se
 * aprueba una vez o se deniega; al ejecutarlo, el daemon revalida todo.
 */
export function GitPlanCard({
  input,
  approvalId,
  operationHash,
  call,
  pending,
}: {
  input: unknown
  approvalId: string
  operationHash: string
  call?: Call
  pending: boolean
}) {
  const parsed = GitPlanSchema.safeParse(input)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [showDiff, setShowDiff] = useState(false)
  if (!parsed.success) return <Hint>Plan de git ilegible.</Hint>
  const plan: GitPlan = parsed.data
  const commit = plan.operations.find((o) => o.op === "commit")
  const push = plan.operations.find((o) => o.op === "push")
  const pr = plan.operations.find((o) => o.op === "pr.create")
  async function decide(approve: boolean) {
    if (!call || busy) return
    setBusy(true)
    setError("")
    try {
      await call("approvals.resolve", {
        ...mutationMeta(),
        approval_id: approvalId,
        operation_hash: operationHash,
        decision: approve ? "approve_once" : "deny",
      })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="git-plan" data-testid="git-plan">
      {commit?.op === "commit" && <p className="git-plan-message">{commit.message}</p>}
      <ul className="git-plan-files">
        {plan.files.map((f) => (
          <li key={f.path} className="mono">
            <span className="muted">{f.status}</span> {f.path}{" "}
            <span className="added">+{f.additions}</span>{" "}
            <span className="deleted">−{f.deletions}</span>
          </li>
        ))}
      </ul>
      <p className="mono muted">
        <GitBranch size={12} /> {plan.branch} · HEAD {plan.expected_head_sha?.slice(0, 10) ?? "—"}
      </p>
      {push?.op === "push" && (
        <p className="mono">
          <Upload size={12} /> push a {push.remote}/{push.branch}
        </p>
      )}
      {pr?.op === "pr.create" && (
        <p className="mono">
          <GitPullRequest size={12} /> PR «{pr.title}» → {pr.base}
        </p>
      )}
      <p className="mono muted wrap">{plan.worktree}</p>
      {plan.diff_ref && call && (
        <>
          <Button onClick={() => setShowDiff((v) => !v)}>
            {showDiff ? "Ocultar diff" : "Ver diff"}
          </Button>
          {showDiff && <ArtifactView call={call} artifactRef={plan.diff_ref} title="diff" />}
        </>
      )}
      {pending && call && (
        <span className="chat-approval-actions">
          <Button variant="primary" icon={Check} disabled={busy} onClick={() => void decide(true)}>
            Aprobar plan
          </Button>
          <Button variant="danger" icon={X} disabled={busy} onClick={() => void decide(false)}>
            Denegar
          </Button>
        </span>
      )}
      <Hint>
        Al aprobar, Keel revalida HEAD, contenido y destino; si algo cambió, el plan caduca. Nunca
        force push ni rama protegida.
      </Hint>
      {error && <p className="deleted">{error}</p>}
    </div>
  )
}
