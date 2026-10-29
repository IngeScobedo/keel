import type { Effort, TaskFlowView } from "@keel/core"
import { Flag, MessageSquare, Play, Send } from "lucide-react"
import { useEffect, useState } from "react"
import { useBaseGuard } from "./BaseGuard.js"
import { ModelPill } from "./Composer.js"
import { STAGE_LABEL } from "./chat-model.js"
import { mutationMeta } from "./client.js"
import { LiveTaskActions } from "./LiveTaskActions.js"
import { StageTrack } from "./MethodCards.js"
import type { Run, WorkItem } from "./model.js"
import { Select } from "./ui/index.js"
import { Button, Status } from "./ui.js"
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
  // ADR-0019 §4: el modelo se elige al arrancar; parte del default de Ajustes.
  const [pick, setPick] = useState<{ model: string | null; effort: Effort | null } | null>(null)
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
  const first = !latest
  useEffect(() => {
    if (!first) return
    let alive = true
    call("settings.get", {})
      .then((s) => {
        const d = s.default_models?.[provider]
        if (alive) setPick(d ? { model: d.model, effort: d.effort } : null)
      })
      .catch(() => alive && setPick(null))
    return () => {
      alive = false
    }
  }, [call, first, provider])
  // ADR-0028: el primer run abre el worktree; antes, la base al día.
  const base = useBaseGuard(call)
  async function work() {
    if (busy) return
    if (!latest && !task.parent_work_item_id) await base.guard(start)
    else await start()
  }
  async function start() {
    setBusy(true)
    setError("")
    try {
      const r = await call("tasks.work", {
        ...mutationMeta(),
        work_item_id: task.id,
        ...(text.trim() ? { text: text.trim() } : {}),
        ...(latest ? {} : { profile: provider }),
        ...(latest || !pick?.model
          ? {}
          : { options: { model: pick.model, ...(pick.effort ? { effort: pick.effort } : {}) } }),
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
  const plan = flow?.git_plan
  return (
    <section className="task-work" data-testid="task-work">
      {base.modal}
      {base.checking && <p className="muted">Consultando el remoto antes de abrir el worktree…</p>}
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
      {!gate && plan?.state === "pending" && (
        <button
          type="button"
          className="task-gate"
          onClick={() => onRun(runs.find((r) => r.id === plan.run_id) ?? (latest as Run))}
          data-testid="task-plan"
        >
          <Flag size={13} /> Espera tu decisión: aprobar el plan de git → ver en el chat
        </button>
      )}
      {flow?.stage === "close" && (plan?.state === "failed" || plan?.state === "expired") && (
        <p className="task-plan-failed" role="status" data-testid="task-plan-failed">
          El plan de git {plan.state === "failed" ? "falló" : "caducó"}
          {plan.reason ? `: ${plan.reason}` : ""}.
          {plan.done.length > 0 && ` Ya se hizo: ${plan.done.map(planStep).join(", ")}.`} Escríbele
          al agente que proponga otro plan con lo que falta.
        </p>
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
              <Select
                aria-label="Agente"
                value={provider}
                onChange={(v) => setProvider(v as "claude" | "codex")}
                options={[
                  { value: "claude", label: "Claude" },
                  { value: "codex", label: "Codex" },
                ]}
              />
            )}
            {!latest && (
              <ModelPill
                call={call}
                provider={provider}
                model={pick?.model ?? null}
                effort={pick?.effort ?? null}
                onPick={(model, effort) => setPick({ model, effort })}
                foot="Para esta tarea · después se cambia desde su chat"
              />
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

const PLAN_STEP: Record<string, string> = {
  "git.commit.created": "el commit",
  "git.push.completed": "el push",
  "git.pull_request.created": "la PR",
}
function planStep(op: string): string {
  return PLAN_STEP[op] ?? op
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
        <Select
          aria-label="Etapa a la que devolver"
          value={to}
          onChange={(v) => setTo(v)}
          options={earlier.map((s) => ({ value: String(s), label: STAGE_LABEL[s] }))}
        />
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

/** ADR-0022 §5: el plan de la feature por fases, con el estado de cada subtarea. */
export function FeaturePlan({
  task,
  subtasks,
  onOpen,
  waitingYou,
}: {
  task: WorkItem
  subtasks: WorkItem[]
  onOpen?: (item: WorkItem) => void
  /** Subtareas con algo esperando tu decisión: se abren desde aquí. */
  waitingYou?: Set<string> | undefined
}) {
  const feature = task.feature
  if (!feature) return null
  const phases = [...new Set(subtasks.map((t) => t.subtask?.phase ?? 1))].sort((a, b) => a - b)
  return (
    <section className="feature-plan" data-testid="feature-plan">
      <h3>
        Feature · {feature.done}/{feature.total} integradas
      </h3>
      <p className="mono muted">
        {feature.branch}
        {feature.auto_integrate ? " · se integran solas" : " · cada integración te pregunta"}
      </p>
      {phases.map((ph) => {
        const items = subtasks.filter((t) => (t.subtask?.phase ?? 1) === ph)
        return (
          <div key={ph} className="feature-tree">
            <h4>
              Fase {ph}
              {items[0]?.subtask?.phase_title ? ` — ${items[0].subtask.phase_title}` : ""}
            </h4>
            {items.map((c) => (
              <button
                type="button"
                key={c.id}
                className="subtask-row"
                onClick={() => onOpen?.(c)}
                disabled={!onOpen}
              >
                <Status state={c.visual_state} dot />
                <span className="mono muted">{c.subtask?.key ?? c.display_id}</span>
                <span>{c.title}</span>
                <span className={`rc-pill ${waitingYou?.has(c.id) ? "needs-you" : ""}`}>
                  {waitingYou?.has(c.id)
                    ? "espera tu decisión → abrir"
                    : c.lifecycle === "done"
                      ? "integrada"
                      : c.lifecycle === "blocked"
                        ? "en cola"
                        : c.stage
                          ? (STAGE_LABEL[c.stage] ?? c.stage)
                          : c.lifecycle}
                </span>
              </button>
            ))}
          </div>
        )
      })}
    </section>
  )
}
