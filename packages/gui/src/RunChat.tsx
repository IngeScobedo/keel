import type { Effort, EventNotification, PermissionMode } from "@keel/core"
import { Check, CircleAlert, X } from "lucide-react"
import { type ReactNode, useContext, useLayoutEffect, useRef, useState } from "react"
import { ApprovalCard, PlanCard, QuestionCard } from "./ApprovalCard.js"
import { Composer, ComposerExtrasContext, ModelPill, ModePill } from "./Composer.js"
import {
  type Approval,
  buildChat,
  buildLedger,
  type ChatItem,
  METHOD_TOOLS,
  type ToolCall,
} from "./chat-model.js"
import { mutationMeta } from "./client.js"
import { CommitRuns, PrCard } from "./GitHub.js"
import { InfraCard } from "./InfraCard.js"
import { Markdown } from "./Markdown.js"
import { GateCard, MethodRow } from "./MethodCards.js"
import type { Run } from "./model.js"
import { BatchPlanCard } from "./Orchestrator.js"
import { RunLedger } from "./RunLedger.js"
import { SetupCard } from "./SetupCard.js"
import { type Density, ExploreGroup, isExplore, StoryLine, ToolCard } from "./ToolCards.js"
import { Empty } from "./ui.js"
import type { useWorkspace } from "./useWorkspace.js"

type Call = ReturnType<typeof useWorkspace>["call"]
const QUESTIONS = new Set(["AskUserQuestion", "ExitPlanMode"])

/**
 * El run como chat de foco (ADR-0020): tarjetas por intención, permisos y
 * preguntas resueltos en su tarjeta, y al lado lo que pasó en el run. Lo más
 * nuevo abajo; la vista se queda pegada al final mientras no subas a leer.
 */
export function RunChat({
  events,
  call,
  run,
  running,
  density,
  task,
  onContinued,
  onTask,
}: {
  events: EventNotification[]
  call?: Call
  run: Run
  running: boolean
  density: Density
  task?: { id: string; display_id: string; title: string }
  /** Al continuar un run terminado nace uno nuevo: la vista pasa a él. */
  onContinued?: (run: Run) => void
  onTask?: (id: string) => void
}) {
  const items = buildChat(events)
  const ledger = buildLedger(items, events)
  const provider = events.some((e) => e.kind.startsWith("codex.")) ? "codex" : "claude"
  const [sending, setSending] = useState(false)
  const [error, setError] = useState("")
  const [peek, setPeek] = useState<string | null>(null)
  const [docPeek, setDocPeek] = useState<{ kind: string; version?: number } | null>(null)
  /** Lo que el humano eligió con el run terminado: va en `runs.continue`. */
  const [next, setNext] = useState<{
    model?: string
    effort?: Effort
    permission_mode?: PermissionMode
  }>({})
  const seen = useRef<Set<string> | null>(null)
  if (seen.current === null) seen.current = new Set(items.map((i) => i.key))
  const box = useRef<HTMLDivElement>(null)
  const pinned = useRef(true)
  useLayoutEffect(() => {
    const el = box.current
    if (el && pinned.current) el.scrollTop = el.scrollHeight
  })

  async function attempt(work: () => Promise<unknown>): Promise<boolean> {
    setError("")
    try {
      await work()
      return true
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      return false
    }
  }
  const extras = useContext(ComposerExtrasContext)
  async function send(raw: string): Promise<boolean> {
    if (!call) return false
    // ADR-0040: en la conversación, las fuentes adjuntas viajan con el mensaje.
    const text = `${raw}${extras?.suffix() ?? ""}`
    setSending(true)
    const ok = await attempt(async () => {
      if (running) await call("runs.message", { ...mutationMeta(), run_id: run.id, text })
      else {
        const child = await call("runs.continue", {
          ...mutationMeta(),
          run_id: run.id,
          text,
          ...(Object.keys(next).length ? { options: next } : {}),
        })
        onContinued?.(child)
      }
    })
    setSending(false)
    if (ok) {
      pinned.current = true
      extras?.onSent()
    }
    return ok
  }
  const setMode = (permission_mode: PermissionMode) =>
    running && call
      ? void attempt(() =>
          call("runs.set_mode", { ...mutationMeta(), run_id: run.id, permission_mode }),
        )
      : setNext((o) => ({ ...o, permission_mode }))
  const setModel = (model: string, effort: Effort | null) =>
    running && call
      ? void attempt(() =>
          call("runs.set_model", {
            ...mutationMeta(),
            run_id: run.id,
            model,
            ...(effort ? { effort } : {}),
          }),
        )
      : setNext((o) => ({ ...o, model, ...(effort ? { effort } : {}) }))
  function jump(key: string) {
    const el = document.getElementById(`rc-${key}`)
    if (!el) return
    pinned.current = false
    el.scrollIntoView({ block: "center", behavior: "smooth" })
    el.classList.remove("rc-jumped")
    void el.offsetWidth
    el.classList.add("rc-jumped")
  }

  const mode = next.permission_mode ?? run.options?.permission_mode ?? "ask"
  const firstPending = ledger.waiting[0]?.approval_id ?? null
  const rows = layout(items, density)
  return (
    <div className="rc">
      <div className="rc-main">
        <div
          className="rc-scroll"
          ref={box}
          onScroll={(e) => {
            const el = e.currentTarget
            pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
          }}
        >
          <div className="rc-column">
            {rows.map((row) => (
              <div key={row.key} id={`rc-${row.key}`} className="rc-row">
                <Row
                  row={row}
                  density={density}
                  fresh={(k) => !seen.current?.has(k)}
                  firstPending={firstPending}
                  onOpenTask={setPeek}
                  onDoc={(kind, version) => setDocPeek({ kind, ...(version ? { version } : {}) })}
                  agent={provider === "codex" ? "Codex" : "Claude"}
                  {...(call ? { call } : {})}
                />
              </div>
            ))}
            {items.length === 0 && <Empty title="El agente aún no ha dicho nada" />}
            {running && ledger.waiting.length === 0 && (
              <p className="rc-typing muted">
                <span className="rc-pulse" /> El agente está trabajando…
              </p>
            )}
          </div>
        </div>
        <div className="rc-column rc-bottom">
          {error && (
            <p className="error-banner" role="alert">
              {error}
            </p>
          )}
          <Composer
            running={running}
            disabled={!call}
            sending={sending}
            suggestion={ledger.suggestion}
            onSend={send}
            mode={mode}
            onMode={setMode}
            pills={
              <>
                <ModelPill
                  {...(call ? { call } : {})}
                  provider={provider}
                  model={next.model ?? ledger.model ?? run.options?.model ?? null}
                  effort={next.effort ?? ledger.effort ?? run.options?.effort ?? null}
                  onPick={setModel}
                />
                <ModePill mode={mode} onPick={setMode} disabled={!call} />
              </>
            }
          />
        </div>
      </div>
      <RunLedger
        ledger={ledger}
        run={run}
        {...(task ? { task } : {})}
        onJump={jump}
        peek={peek}
        onPeek={setPeek}
        docPeek={docPeek}
        onDocPeek={setDocPeek}
        {...(onTask ? { onTask } : {})}
        {...(call ? { call } : {})}
      />
    </div>
  )
}

type LayoutRow =
  | { kind: "item"; key: string; item: ChatItem }
  | { kind: "explore"; key: string; tools: ToolCall[] }
  | { kind: "story"; key: string; tools: ToolCall[] }

/** ¿Hay que mostrarla entera aunque la densidad sea «Historia»? */
function needsYou(item: ChatItem): boolean {
  if (item.kind === "approval" && (item.tool === "stage.gate" || item.tool === "setup.request"))
    return true
  if (item.kind === "approval") return item.decision === null || QUESTIONS.has(item.tool)
  if (item.kind === "tool")
    return (item.approval !== null && item.approval.decision === null) || QUESTIONS.has(item.name)
  return false
}

/** Agrupa según la densidad: Historia junta las acciones, Equilibrada sólo la exploración. */
function layout(items: ChatItem[], density: Density): LayoutRow[] {
  const rows: LayoutRow[] = []
  let run: ToolCall[] = []
  const flush = () => {
    if (run.length === 0) return
    const key = run[0]?.key ?? ""
    if (density === "story") rows.push({ kind: "story", key: `story:${key}`, tools: run })
    else if (run.length > 1) rows.push({ kind: "explore", key: `explore:${key}`, tools: run })
    else rows.push({ kind: "item", key, item: run[0] as ToolCall })
    run = []
  }
  for (const item of items) {
    // Las tools del método ya se ven como eventos de Keel; sólo la vista cruda las muestra.
    if (item.kind === "tool" && METHOD_TOOLS.has(item.name) && density !== "raw") continue
    if (density === "raw") {
      rows.push({ kind: "item", key: item.key, item })
      continue
    }
    const groupable =
      item.kind === "tool" &&
      // Terraform, Ansible y SSH se ven siempre: son lo que cambia la infraestructura.
      item.infra === null &&
      !needsYou(item) &&
      (density === "story" || (isExplore(item) && item.state !== "failed"))
    if (groupable) {
      run.push(item)
      continue
    }
    // Lo que permitió una regla ya se ve en la tarjeta; sólo la vista cruda lo repite.
    if (item.kind === "auto" && item.effect !== "deny") continue
    if (density === "story" && item.kind === "approval" && !needsYou(item)) continue
    flush()
    rows.push({ kind: "item", key: item.key, item })
  }
  flush()
  return rows
}

function Row({
  row,
  density,
  call,
  fresh,
  firstPending,
  onOpenTask,
  onDoc,
  agent,
}: {
  row: LayoutRow
  density: Density
  call?: Call
  fresh: (key: string) => boolean
  firstPending: string | null
  onOpenTask: (id: string) => void
  onDoc: (kind: string, version?: number) => void
  agent: string
}) {
  const c = call ? { call } : {}
  if (row.kind === "story") return <StoryLine tools={row.tools} />
  if (row.kind === "explore") return <ExploreGroup tools={row.tools} density={density} {...c} />
  const item = row.item
  switch (item.kind) {
    case "infra":
      return <InfraCard r={item} {...c} />
    case "github_pr":
      return call ? <PrCard call={call} number={item.number} /> : null
    case "github_runs":
      return call ? (
        <div className="gh-runs">
          <p className="muted gh-note">{item.label}</p>
          <CommitRuns call={call} sha={item.sha} />
        </div>
      ) : null
    case "prompt":
    case "human":
      return (
        <Said who="TÚ" kind="human" testid={item.kind === "prompt" ? "chat-prompt" : "chat-human"}>
          {item.text}
        </Said>
      )
    case "agent":
      return (
        <Said who={agent === "Codex" ? "X" : "C"} kind="agent" testid="chat-agent">
          {item.text}
        </Said>
      )
    case "method":
      return <MethodRow item={item} onDoc={onDoc} onOpenTask={onOpenTask} />
    case "divider":
      return (
        <p className="rc-divider" data-testid="chat-divider">
          {item.text}
        </p>
      )
    case "status":
      return (
        <p className={`rc-status ${item.tone}`} data-testid="chat-status">
          {item.tone === "error" && <CircleAlert size={13} aria-hidden="true" />}
          {item.text}
        </p>
      )
    case "auto":
      return (
        <p className={`rc-auto ${item.effect}`} data-testid="chat-auto">
          {item.effect === "deny" ? <X size={12} /> : <Check size={12} />}
          <code>{item.tool}</code>
          <span className="mono">{item.input}</span>
          <span className="muted">
            {item.effect === "deny" ? "negado" : "permitido"} por{" "}
            {item.source.startsWith("session:") ? "esta sesión" : "regla"} {item.label}
          </span>
        </p>
      )
    case "approval":
      return <Pending a={item} firstPending={firstPending} agent={agent} {...c} />
    case "tool": {
      if (item.approval && (item.approval.decision === null || QUESTIONS.has(item.name)))
        return <Pending a={item.approval} firstPending={firstPending} agent={agent} {...c} />
      if (item.name === "AskUserQuestion" || item.name === "ExitPlanMode") {
        // Sin aprobación de Keel (p. ej. bypass): se muestra lo que contestó el SDK.
        const r = (item.response ?? {}) as { answers?: Record<string, string> }
        return (
          <Pending
            a={{
              kind: "approval",
              key: item.key,
              approval_id: "",
              operation_hash: "",
              tool: item.name,
              input: item.input,
              expires_at: null,
              decision:
                item.state === "running" ? null : item.state === "done" ? "approved" : "denied",
              answers: r.answers ?? null,
              reason: item.error,
              plan: null,
            }}
            firstPending={null}
            agent={agent}
          />
        )
      }
      return (
        <ToolCard
          t={item}
          density={density}
          fresh={fresh(item.key)}
          onOpenTask={onOpenTask}
          {...c}
        />
      )
    }
  }
}

function Pending({
  a,
  call,
  firstPending,
  agent,
}: {
  a: Approval
  call?: Call
  firstPending: string | null
  agent: string
}) {
  const active = a.decision === null && a.approval_id === firstPending
  const c = call ? { call } : {}
  if (a.tool === "stage.gate") return <GateCard a={a} active={active} {...c} />
  if (a.tool === "batch.plan") return <BatchPlanCard a={a} active={active} {...c} />
  if (a.tool === "setup.request") return <SetupCard a={a} active={active} {...c} />
  if (a.tool === "AskUserQuestion")
    return <QuestionCard a={a} active={active} agent={agent} {...c} />
  if (a.tool === "ExitPlanMode") return <PlanCard a={a} active={active} {...c} />
  return <ApprovalCard a={a} active={active} {...c} />
}

function Said({
  who,
  kind,
  testid,
  children,
}: {
  who: string
  kind: "human" | "agent"
  testid: string
  children: ReactNode
}) {
  return (
    <div className={`rc-said ${kind} ${who === "X" ? "codex" : ""}`}>
      <span className="rc-glyph" aria-hidden="true">
        {who}
      </span>
      {kind === "agent" && typeof children === "string" ? (
        <div className="rc-text" data-testid={testid}>
          <Markdown text={children} />
        </div>
      ) : (
        <p className="text-block rc-text" data-testid={testid}>
          {children}
        </p>
      )}
    </div>
  )
}
