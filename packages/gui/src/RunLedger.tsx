import { type Methods, shellCommand } from "@keel/core"
import {
  ArrowLeft,
  Coins,
  Cpu,
  FileDiff as FileDiffIcon,
  FileText,
  Hand,
  ListChecks,
  NotebookPen,
  Shield,
  SquarePlus,
  X,
} from "lucide-react"
import { useCallback, useEffect, useState } from "react"
import { MODES } from "./Composer.js"
import {
  type Approval,
  DOC_LABEL,
  EFFORT_LABEL,
  type Ledger,
  modelLabel,
  questionsOf,
} from "./chat-model.js"
import { mutationMeta } from "./client.js"
import { Markdown } from "./Markdown.js"
import { DocPeek, StageTrack } from "./MethodCards.js"
import { formatCost, type Run } from "./model.js"
import { shortPath } from "./ToolCards.js"
import type { useWorkspace } from "./useWorkspace.js"

type Call = ReturnType<typeof useWorkspace>["call"]
type TaskDetail = ReturnType<(typeof Methods)["work_items.get"]["result"]["parse"]>

/**
 * «En este run» (ADR-0020): lo que espera por ti, archivos tocados, tareas,
 * notas y la sesión. Cada fila lleva a su tarjeta sin salir del chat.
 */
export function RunLedger({
  ledger,
  run,
  task,
  onJump,
  peek,
  onPeek,
  docPeek,
  onDocPeek,
  onTask,
  call,
}: {
  ledger: Ledger
  run: Run
  task?: { id: string; display_id: string; title: string }
  onJump: (key: string) => void
  peek: string | null
  onPeek: (id: string | null) => void
  docPeek: { kind: string; version?: number } | null
  onDocPeek: (doc: { kind: string; version?: number } | null) => void
  onTask?: (id: string) => void
  call?: Call
}) {
  if (docPeek && call && task)
    return (
      <aside className="rc-ledger" aria-label="En este run">
        <DocPeek
          workItemId={task.id}
          kind={docPeek.kind}
          version={docPeek.version}
          call={call}
          onClose={() => onDocPeek(null)}
        />
      </aside>
    )
  if (peek && call)
    return (
      <aside className="rc-ledger" aria-label="En este run">
        <TaskPeek
          id={peek}
          call={call}
          onClose={() => onPeek(null)}
          {...(onTask ? { onTask } : {})}
        />
      </aside>
    )
  const todos = ledger.todos
  const mode = MODES.find((m) => m.id === (run.options?.permission_mode ?? "ask"))
  return (
    <aside className="rc-ledger" aria-label="En este run">
      {ledger.stage && (
        <Section title="Método">
          <StageTrack
            stage={ledger.stage.stage}
            ceremony={ledger.stage.ceremony}
            waiting={ledger.waiting.some((a) => a.tool === "stage.gate")}
          />
          {ledger.docs.map((d) => (
            <button
              key={d.doc}
              type="button"
              className="rc-ledger-row"
              onClick={() => onDocPeek({ kind: d.doc })}
            >
              <FileText size={14} />
              <span>
                {DOC_LABEL[d.doc] ?? d.doc} v{d.version}
              </span>
              <span className={d.ok ? "mono added" : "mono removed"}>
                {d.ok ? "valida" : "pendiente"}
              </span>
            </button>
          ))}
        </Section>
      )}
      <Section title="Esperando por ti" count={ledger.waiting.length}>
        {ledger.waiting.length === 0 && <p className="muted">Nada: el agente sigue solo.</p>}
        {ledger.waiting.map((a) => (
          <button
            key={a.key}
            type="button"
            className="rc-ledger-row waiting"
            onClick={() => onJump(a.key)}
          >
            <Hand size={14} />
            <span>{waitingLabel(a)}</span>
            <kbd>ir ↵</kbd>
          </button>
        ))}
      </Section>
      <Section title="Archivos" count={ledger.files.length}>
        {ledger.files.map((f) => (
          <button
            key={f.path}
            type="button"
            className="rc-ledger-row"
            onClick={() => onJump(f.key)}
            title={f.path}
          >
            <FileDiffIcon size={14} />
            <span className="mono">{shortPath(f.path)}</span>
            <span className="mono">
              <span className="added">+{f.added}</span>{" "}
              {f.removed > 0 && <span className="removed">−{f.removed}</span>}
            </span>
          </button>
        ))}
      </Section>
      <Section
        title="Tareas"
        count={(task ? 1 : 0) + ledger.tasks.filter((t) => t.id !== task?.id).length}
      >
        {task && (
          <button type="button" className="rc-ledger-row" onClick={() => onPeek(task.id)}>
            <ListChecks size={14} />
            <span>
              {task.display_id} · {task.title}
            </span>
            {todos && (
              <span className="mono muted">
                {todos.filter((t) => t.status === "completed").length}/{todos.length}
              </span>
            )}
          </button>
        )}
        {ledger.tasks
          .filter((t) => t.id !== task?.id)
          .map((t) => (
            <button key={t.id} type="button" className="rc-ledger-row" onClick={() => onPeek(t.id)}>
              <SquarePlus size={14} />
              <span>
                {t.display_id} · {t.title}
              </span>
              {t.created && <span className="mono accent">nueva</span>}
            </button>
          ))}
      </Section>
      <Section title="Notas" count={ledger.notes.length}>
        {ledger.notes.map((n) => (
          <button key={n.key} type="button" className="rc-ledger-row" onClick={() => onJump(n.key)}>
            <NotebookPen size={14} />
            <span>{n.text}</span>
            <time className="mono muted">{ago(n.at)}</time>
          </button>
        ))}
      </Section>
      <Section title="Sesión">
        <p className="rc-ledger-row static">
          <Cpu size={14} />
          <span>
            {ledger.model ? modelLabel(ledger.model) : (run.options?.model ?? "modelo del perfil")}
            {ledger.effort ? ` · esfuerzo ${EFFORT_LABEL[ledger.effort] ?? ledger.effort}` : ""}
          </span>
        </p>
        <p
          className={`rc-ledger-row static ${run.options?.permission_mode === "bypass" ? "danger" : ""}`}
        >
          <Shield size={14} />
          <span>Modo: {mode?.label}</span>
        </p>
        <p className="rc-ledger-row static">
          <Coins size={14} />
          <span>{formatCost(run)}</span>
        </p>
      </Section>
    </aside>
  )
}

function Section({
  title,
  count,
  children,
}: {
  title: string
  count?: number
  children: React.ReactNode
}) {
  return (
    <section className="rc-ledger-section">
      <h3>
        {title}
        {count !== undefined && <span>{count}</span>}
      </h3>
      {children}
    </section>
  )
}

function waitingLabel(a: Approval): string {
  if (a.tool === "stage.gate") {
    const g = (a.input as { gate?: string; reason?: string } | null) ?? {}
    return g.reason === "contract"
      ? "Cambio de contrato"
      : g.gate === "design"
        ? "Congelar el contrato"
        : g.gate === "close"
          ? "Aprobar el cierre"
          : "Aprobar el brief"
  }
  if (a.tool === "AskUserQuestion")
    return `Pregunta: ${questionsOf(a.input)[0]?.header ?? "del agente"}`
  if (a.tool === "ExitPlanMode") return "Revisar el plan"
  const i = (a.input ?? {}) as Record<string, unknown>
  return String(i.description ?? shellCommand(i) ?? i.file_path ?? a.tool)
}

function ago(iso: string): string {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000)
  if (s < 60) return "ahora"
  if (s < 3600) return `hace ${Math.floor(s / 60)} min`
  return `hace ${Math.floor(s / 3600)} h`
}

/** La tarea abierta al lado del chat, sin cambiar de pantalla (ADR-0020 §1). */
function TaskPeek({
  id,
  call,
  onClose,
  onTask,
}: {
  id: string
  call: Call
  onClose: () => void
  onTask?: (id: string) => void
}) {
  const [detail, setDetail] = useState<TaskDetail | null>(null)
  const [error, setError] = useState("")
  const load = useCallback(
    () =>
      call("work_items.get", { work_item_id: id })
        .then(setDetail)
        .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e))),
    [call, id],
  )
  useEffect(() => {
    void load()
  }, [load])
  async function plan() {
    try {
      await call("work_items.transition", { ...mutationMeta(), work_item_id: id, to: "planned" })
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }
  return (
    <div className="rc-peek" data-testid="task-peek">
      <header>
        <button type="button" className="button ghost" aria-label="Volver" onClick={onClose}>
          <ArrowLeft size={14} />
        </button>
        <span className="mono muted">{detail?.item.display_id}</span>
        <button type="button" className="button ghost" aria-label="Cerrar" onClick={onClose}>
          <X size={14} />
        </button>
      </header>
      {error && <p className="error">{error}</p>}
      {detail && (
        <>
          <h3>{detail.item.title}</h3>
          <p className="muted">
            {detail.item.kind} · {detail.item.lifecycle}
          </p>
          <div className="rc-actions">
            {detail.item.lifecycle === "triage" && (
              <button type="button" className="button" onClick={() => void plan()}>
                Mover a planned
              </button>
            )}
            {onTask && (
              <button type="button" className="button" onClick={() => onTask(id)}>
                Ir a la tarea
              </button>
            )}
          </div>
          {detail.spec_markdown && (
            <Markdown className="rc-peek-spec" text={detail.spec_markdown} />
          )}
          {detail.notes.length > 0 && <h4>Notas</h4>}
          {detail.notes.map((n) => (
            <Markdown key={n.id} className="rc-peek-note" text={n.content_markdown} />
          ))}
        </>
      )}
    </div>
  )
}
