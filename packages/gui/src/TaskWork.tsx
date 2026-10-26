import type { TaskFlowView } from "@keel/core"
import { Flag, MessageSquare, Play, Send } from "lucide-react"
import { useEffect, useState } from "react"
import { STAGE_LABEL } from "./chat-model.js"
import { mutationMeta } from "./client.js"
import { LiveTaskActions } from "./LiveTaskActions.js"
import { StageTrack } from "./MethodCards.js"
import type { Run, WorkItem } from "./model.js"
import { Button } from "./ui.js"
import type { useWorkspace } from "./useWorkspace.js"

type Call = ReturnType<typeof useWorkspace>["call"]
const TERMINAL = new Set(["completed", "failed", "cancelled", "interrupted"])
const GATE_LABEL = {
  brief: "aprobar el brief",
  design: "congelar el contrato",
  close: "aprobar el cierre",
} as const

/**
 * Trabajar una tarea (ADR-0021 §3): un solo botón. Keel decide la etapa, el
 * tipo de run, el worktree y si hay que escribirle al agente que ya trabaja.
 * El control manual queda en «Avanzado».
 */
export function TaskWork({
  task,
  runs,
  call,
  onRun,
}: {
  task: WorkItem
  runs: Run[]
  call: Call
  onRun: (run: Run) => void
}) {
  const [flow, setFlow] = useState<TaskFlowView | null>(null)
  const [text, setText] = useState("")
  const [provider, setProvider] = useState<"claude" | "codex">("claude")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const live = runs.find((r) => !TERMINAL.has(r.status))
  const latest = runs[0]
  const runState = runs.map((r) => r.status).join(",")
  // biome-ignore lint/correctness/useExhaustiveDependencies: la etapa, la revisión y los runs sólo disparan la relectura.
  useEffect(() => {
    let alive = true
    call("tasks.flow", { work_item_id: task.id })
      .then((r) => alive && setFlow(r.flow))
      .catch(() => alive && setFlow(null))
    return () => {
      alive = false
    }
  }, [call, task.id, task.revision, task.stage, runState])
  const done = task.lifecycle === "done"
  async function work() {
    if (busy) return
    setBusy(true)
    setError("")
    try {
      const r = await call("tasks.work", {
        ...mutationMeta(),
        work_item_id: task.id,
        ...(text.trim() ? { text: text.trim() } : {}),
        ...(latest ? {} : { profile: provider }),
      })
      setText("")
      setFlow(r.flow)
      onRun(r.run)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }
  const gate = flow?.pending_gate
  return (
    <section className="task-work" data-testid="task-work">
      <h3>Trabajo</h3>
      {flow && (
        <StageTrack
          stage={flow.stage}
          ceremony={flow.ceremony}
          waiting={gate !== null && gate !== undefined}
        />
      )}
      {gate && (
        <button
          type="button"
          className="task-gate"
          onClick={() => latest && onRun(latest)}
          data-testid="task-gate"
        >
          <Flag size={13} /> Espera tu decisión: {GATE_LABEL[gate.gate]} → ver en el chat
        </button>
      )}
      {!done && (
        <form
          onSubmit={(e) => {
            e.preventDefault()
            void work()
          }}
        >
          <textarea
            aria-label="Qué necesitas"
            rows={3}
            placeholder={
              live
                ? "Escríbele al agente mientras trabaja"
                : flow
                  ? `Sigue en ${STAGE_LABEL[flow.stage] ?? flow.stage}; puedes darle una indicación`
                  : "Qué necesitas (opcional): Keel empieza por el brief"
            }
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault()
                void work()
              }
            }}
          />
          <div className="task-work-bar">
            {!latest && (
              <select
                aria-label="Agente"
                value={provider}
                onChange={(e) => setProvider(e.target.value as "claude" | "codex")}
              >
                <option value="claude">Claude</option>
                <option value="codex">Codex</option>
              </select>
            )}
            <button
              type="submit"
              className="button primary"
              disabled={busy || (live !== undefined && !text.trim())}
            >
              {live ? <Send size={13} /> : <Play size={13} />}
              {live ? "Escribirle" : flow ? "Seguir trabajando" : "Trabajar"}
            </button>
            {latest && (
              <Button variant="ghost" icon={MessageSquare} onClick={() => onRun(live ?? latest)}>
                Ver el chat
              </Button>
            )}
          </div>
        </form>
      )}
      {error && (
        <p className="deleted" role="alert">
          {error}
        </p>
      )}
      <details className="task-advanced">
        <summary>Avanzado</summary>
        {flow && <ReturnStage task={task} flow={flow} call={call} />}
        <LiveTaskActions task={task} runs={runs} call={call} onRun={onRun} />
      </details>
    </section>
  )
}

/** Devolver la tarea a una etapa anterior: es del humano y lleva motivo (ADR-0021 §2). */
function ReturnStage({ task, flow, call }: { task: WorkItem; flow: TaskFlowView; call: Call }) {
  const order = ["brief", "design", "implement", "review", "close"]
  const earlier = order.slice(0, order.indexOf(flow.stage))
  const [to, setTo] = useState(earlier.at(-1) ?? "")
  const [why, setWhy] = useState("")
  const [error, setError] = useState("")
  if (earlier.length === 0) return null
  return (
    <form
      className="task-return"
      onSubmit={(e) => {
        e.preventDefault()
        setError("")
        call("stages.return", {
          ...mutationMeta(),
          work_item_id: task.id,
          to: to as TaskFlowView["stage"],
          reason: why.trim(),
        })
          .then(() => setWhy(""))
          .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
      }}
    >
      <label>
        Devolver a
        <select
          aria-label="Etapa a la que devolver"
          value={to}
          onChange={(e) => setTo(e.target.value)}
        >
          {earlier.map((s) => (
            <option key={s} value={s}>
              {STAGE_LABEL[s]}
            </option>
          ))}
        </select>
      </label>
      <input
        aria-label="Motivo"
        placeholder="Por qué"
        value={why}
        onChange={(e) => setWhy(e.target.value)}
      />
      <button type="submit" className="button" disabled={!why.trim()}>
        Devolver
      </button>
      {error && <p className="deleted">{error}</p>}
    </form>
  )
}
