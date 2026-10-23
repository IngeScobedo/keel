import { describePattern, patternFor } from "@keel/core"
import { Check, Clock, ShieldCheck, X } from "lucide-react"
import { useState } from "react"
import { mutationMeta } from "./client.js"
import { Button, Hint } from "./ui.js"
import type { useWorkspace } from "./useWorkspace.js"

type Call = ReturnType<typeof useWorkspace>["call"]
type Decision = "approve_once" | "approve_session" | "approve_always" | "deny"

/**
 * Las cuatro respuestas a una aprobación (ADR-0019 §4, SDD 01 §10). Antes de
 * elegir «sesión» o «siempre» se ve qué patrón cubre: `Bash(git status:*)`.
 */
export function ApprovalActions({
  approvalId,
  operationHash,
  tool,
  input,
  call,
  onDone,
}: {
  approvalId: string
  operationHash: string
  tool: string
  input: unknown
  call: Call
  onDone?: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const label = describePattern(patternFor(tool, input))
  async function decide(decision: Decision) {
    if (busy) return
    setBusy(true)
    setError("")
    try {
      await call("approvals.resolve", {
        ...mutationMeta(),
        approval_id: approvalId,
        operation_hash: operationHash,
        decision,
      })
      onDone?.()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="approval-choices">
      <Button
        variant="primary"
        icon={Check}
        disabled={busy}
        onClick={() => void decide("approve_once")}
      >
        Aprobar una vez
      </Button>
      <Button
        icon={Clock}
        disabled={busy}
        title={`${label} durante el resto de este run (máx. 15 min)`}
        onClick={() => void decide("approve_session")}
      >
        Esta sesión
      </Button>
      <Button
        icon={ShieldCheck}
        disabled={busy}
        title="Crea una regla del proyecto; se revoca en Permisos"
        onClick={() => void decide("approve_always")}
      >
        Siempre: <code>{label}</code>
      </Button>
      <Button variant="danger" icon={X} disabled={busy} onClick={() => void decide("deny")}>
        Denegar
      </Button>
      {error && <Hint>{error}</Hint>}
    </div>
  )
}
