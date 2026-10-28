/**
 * Qué tareas tienen algo esperando una decisión del humano (un gate, un plan de git, una
 * pregunta, un permiso). Sale de las aprobaciones pendientes, que ya traen su tarea: así la
 * feature dice qué subtarea te espera sin que el daemon recalcule al padre (ADR-0022 §5).
 */
import { useEffect, useState } from "react"
import type { useWorkspace } from "./useWorkspace.js"

type Workspace = ReturnType<typeof useWorkspace>

export function useNeedsYou(workspace: Workspace): Set<string> {
  const [ids, setIds] = useState<Set<string>>(() => new Set())
  const live = workspace.mode === "live"
  const { call, inboxTick } = workspace
  // biome-ignore lint/correctness/useExhaustiveDependencies: inboxTick sólo dispara la relectura.
  useEffect(() => {
    if (!live) {
      setIds(new Set())
      return
    }
    let alive = true
    call("approvals.list", {})
      .then((r) => {
        if (alive) setIds(new Set(r.approvals.map((a) => a.work_item_id)))
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [live, call, inboxTick])
  return ids
}
