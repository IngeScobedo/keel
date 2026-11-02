/**
 * ADR-0041 y ADR-0035 en la GUI, como los frames `CTO / 01…04` del canvas: la
 * conversación vacía que invita a empezar, el plan del lote como superficie principal
 * mientras el hilo se angosta, y el lote en vivo con un carril por tarjeta. Lo que
 * decide si un intent está listo es el mismo `readyCheck` que corre el daemon.
 */
import {
  type BatchIntent,
  type BatchPlan,
  type EventNotification,
  lanesFor,
  type Methods,
  readyCheck,
} from "@keel/core"
import {
  ArrowRight,
  ArrowUpRight,
  Check,
  CornerDownRight,
  FileText,
  GitBranch,
  LayoutTemplate,
  ListChecks,
  Network,
  Play,
  Undo2,
} from "lucide-react"
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react"
import type { Approval } from "./chat-model.js"
import { STAGE_LABEL } from "./chat-model.js"
import { mutationMeta } from "./client.js"
import type { Run, WorkItem } from "./model.js"
import { agentName, laneName, leaseOf, stepOf } from "./orchestration-model.js"
import { Select, Switch } from "./ui/index.js"
import { Button } from "./ui.js"
import type { useWorkspace } from "./useWorkspace.js"
import "./Orchestration.css"

type Call = ReturnType<typeof useWorkspace>["call"]
type Lanes = ReturnType<(typeof Methods)["features.lanes"]["result"]["parse"]>
type LaneSubtask = Lanes["subtasks"][number]

const TERMINAL = new Set(["completed", "failed", "cancelled", "interrupted"])

/**
 * El plan está en la superficie principal: en el hilo basta una tarjeta que apunte a él
 * (ds/CTO/ChatCard/Plan), no la tabla entera dos veces.
 */
export const PlanOnSurface = createContext<{ approvalId: string; focus: () => void } | null>(null)

// --- CTO / 01: la conversación vacía ---------------------------------------------------

export function EmptyThread({
  composer,
  onAttach,
  onPrefill,
}: {
  composer: ReactNode
  onAttach: () => void
  onPrefill: (text: string) => void
}) {
  const starts = [
    {
      icon: FileText,
      title: "Convertir una reunión en un plan",
      hint: "Adjunta notas o la transcripción de un Meet",
      act: onAttach,
    },
    {
      icon: LayoutTemplate,
      title: "Revisar un diseño",
      hint: "Pega el link de un artifact o del canvas",
      act: () => onPrefill("Revisa este diseño y propón los cambios: "),
    },
    {
      icon: ListChecks,
      title: "Describir unos cambios",
      hint: "Un mensaje. Sin formularios de tareas.",
      act: () => onPrefill(""),
    },
  ]
  return (
    <div className="cto-empty cto-enter">
      <p className="cto-eyebrow">
        <span className="cto-diamond" aria-hidden /> Chat to orchestrate
      </p>
      <h1>¿Qué vamos a construir?</h1>
      <p className="cto-lede">
        Cuéntalo como lo dirías. Keel convierte tus pedidos en un plan visible, arranca lo que está
        listo y mantiene cada decisión conectada.
      </p>
      {composer}
      <p className="cto-section-label">Empieza con lo que tienes</p>
      <ul className="cto-starts">
        {starts.map((s, i) => (
          <li key={s.title} style={{ "--i": i } as React.CSSProperties}>
            <button type="button" onClick={s.act}>
              <s.icon size={16} aria-hidden />
              <span>
                <strong>{s.title}</strong>
                <span>{s.hint}</span>
              </span>
              <ArrowUpRight size={14} aria-hidden className="cto-starts-go" />
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}

/** El lote en vivo antes de que haya lote: qué va a pasar. */
export function LiveBatchEmpty({ sources }: { sources: number }) {
  return (
    <section className="lb lb-empty" aria-label="Lote en vivo">
      <p className="cto-section-label">Lote en vivo</p>
      <Network size={20} aria-hidden className="lb-empty-icon" />
      <h2>Aún no hay lote</h2>
      <p className="muted">
        Tu primer pedido ejecutable crea un lote. Nada corre hasta que su objetivo, alcance y
        criterio de aceptación están claros.
      </p>
      <ol className="lb-steps-intro">
        <li>
          <strong>Capturar todo</strong>
          <span>Los pedidos se vuelven borradores visibles.</span>
        </li>
        <li>
          <strong>Arrancar lo que está listo</strong>
          <span>Las preguntas abiertas se quedan dando forma.</span>
        </li>
        <li>
          <strong>Cerrar con evidencia</strong>
          <span>Los gates nunca desaparecen en el chat.</span>
        </li>
      </ol>
      <p className="muted lb-sources">
        <FileText size={13} aria-hidden /> Fuentes del proyecto · {sources}
      </p>
    </section>
  )
}

// --- CTO / 03: el plan como superficie --------------------------------------------------

type PlanInput = { plan: BatchPlan }

const KIND_LABEL: Record<string, string> = {
  "ui-change": "ui-change",
  "design-proposal": "propuesta",
  release: "despliegue",
  correction: "regla",
  ratification: "ratifica",
}

const PROFILES: { value: string; label: string }[] = [
  { value: "default", label: "Por defecto" },
  { value: "claude|claude-haiku-5-5|low", label: "Haiku · bajo" },
  { value: "claude|claude-sonnet-5-5|medium", label: "Sonnet · medio" },
  { value: "claude|claude-opus-5-5|high", label: "Opus · alto" },
  { value: "codex||", label: "Codex" },
]
const profileValue = (p: BatchIntent["profile"]) =>
  p ? `${p.provider}|${p.model ?? ""}|${p.effort ?? ""}` : "default"

function orderLabel(i: BatchIntent): string {
  if (i.ordering === "deferred") return "Diferido"
  if (i.kind === "release") return "Al cierre"
  if (typeof i.ordering === "object") return `Después de ${i.ordering.after.join(", ")}`
  return i.ordering === "end-of-batch" ? "Al final" : "Ahora"
}

/**
 * El plan del lote que el humano corrige antes de arrancar (ADR-0035 §2): títulos
 * editables en su lugar, el agente por intent, diferir lo que no va, y las preguntas de
 * lo que no está listo a la vista. `⌘↵` arranca lo listo.
 */
export function PlanSurface({
  plan: a,
  call,
  provenance,
}: {
  plan: Approval
  call: Call
  provenance: string
}) {
  const input = a.input as PlanInput
  const [intents, setIntents] = useState<BatchIntent[]>(() => input.plan.intents)
  const [auto, setAuto] = useState(input.plan.auto_integrate)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const checks = useMemo(
    () => Object.fromEntries(intents.map((i) => [i.key, readyCheck(i)])),
    [intents],
  )
  const startable = intents.filter(
    (i) => i.ordering !== "deferred" && i.kind !== "release" && checks[i.key]?.ready,
  )
  const open = intents.filter(
    (i) => i.ordering !== "deferred" && i.kind !== "release" && !checks[i.key]?.ready,
  )
  const lanes = lanesFor(startable)
  const laneOf = (key: string) => {
    const n = lanes.findIndex((l) => l.includes(key))
    return n < 0 ? "—" : laneName(n)
  }
  const edit = (key: string, patch: Partial<BatchIntent>) =>
    setIntents((all) => all.map((i) => (i.key === key ? { ...i, ...patch } : i)))
  const original = (key: string) => input.plan.intents.find((x) => x.key === key)?.ordering
  const decide = useCallback(
    async (decision: "approve_once" | "deny") => {
      setBusy(true)
      setError("")
      try {
        await call("approvals.resolve", {
          ...mutationMeta(),
          approval_id: a.approval_id,
          operation_hash: a.operation_hash,
          decision,
          ...(decision === "approve_once"
            ? { batch: { ...input.plan, intents, auto_integrate: auto } }
            : {}),
        })
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
        setBusy(false)
      }
    },
    [call, a, input.plan, intents, auto],
  )
  // ⌘↵ arranca lo listo, como en el canvas.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !busy) {
        e.preventDefault()
        void decide("approve_once")
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [decide, busy])
  const start =
    startable.length > 0
      ? `Arrancar ${startable.length} listo${startable.length === 1 ? "" : "s"}`
      : "Mandar todo al backlog"
  return (
    <section className="plan-surface cto-enter" data-testid="batch-plan" aria-label="Plan del lote">
      <header className="plan-head">
        <h1>{input.plan.title}</h1>
        <p className="plan-meta">
          {intents.length} pedido{intents.length === 1 ? "" : "s"}
          {provenance && ` · extraídos de ${provenance}`}
          {input.plan.summary && ` · ${input.plan.summary}`}
        </p>
        <div className="plan-status">
          <span>
            <span className="cto-diamond" aria-hidden /> Plan listo para revisar
            <span className="muted">
              · {startable.length} de {intents.length} listos
            </span>
          </span>
          <span className="plan-spacer" />
          <Switch checked={auto} onChange={setAuto}>
            Integrar solas con QA PASS
          </Switch>
        </div>
      </header>
      <ul className="plan-table" aria-label="Pedidos del plan">
        <li className="plan-row plan-row-head" aria-hidden>
          <span>Pedido · aceptación</span>
          <span>Carril</span>
          <span>Orden</span>
          <span>Agente</span>
          <span>Listo</span>
        </li>
        {intents.map((i, n) => {
          const rc = checks[i.key]
          const deferred = i.ordering === "deferred"
          const ready = Boolean(rc?.ready) && !deferred
          const state = deferred
            ? "deferred"
            : i.kind === "release"
              ? "close"
              : ready
                ? "ready"
                : "questions"
          return (
            <li
              key={i.key}
              className="plan-row"
              data-state={state}
              style={{ "--i": n } as React.CSSProperties}
            >
              <span className="plan-intent">
                <span className="mono plan-key">{i.key}</span>
                <span className="plan-intent-text">
                  <input
                    className="plan-title-input"
                    aria-label={`Título de ${i.key}`}
                    value={i.title}
                    onChange={(e) => edit(i.key, { title: e.target.value })}
                  />
                  <span className="plan-kind">
                    {KIND_LABEL[i.kind] ?? i.kind}
                    {i.scope.length > 0 && <span className="mono"> · {i.scope.join(" ")}</span>}
                  </span>
                </span>
              </span>
              <span className="mono plan-lane">{ready ? laneOf(i.key) : "—"}</span>
              <span className="plan-order">{orderLabel(i)}</span>
              <span>
                <Select
                  aria-label={`Agente de ${i.key}`}
                  size="sm"
                  value={profileValue(i.profile)}
                  onChange={(v) => {
                    const [provider, model, effort] = v.split("|")
                    setIntents((all) =>
                      all.map((x) => {
                        if (x.key !== i.key) return x
                        const { profile: _p, ...rest } = x
                        return v === "default"
                          ? rest
                          : {
                              ...rest,
                              profile: {
                                provider: provider as "claude" | "codex",
                                ...(model ? { model } : {}),
                                ...(effort ? { effort: effort as "low" } : {}),
                              },
                            }
                      }),
                    )
                  }}
                  options={
                    PROFILES.some((p) => p.value === profileValue(i.profile))
                      ? PROFILES
                      : [
                          { value: profileValue(i.profile), label: agentName(i.profile ?? null) },
                          ...PROFILES.slice(1),
                        ]
                  }
                />
              </span>
              <span className="plan-ready">
                <span className="plan-ready-label">
                  {state === "ready" && (
                    <>
                      <span className="plan-dot" aria-hidden /> Listo
                    </>
                  )}
                  {state === "questions" && (
                    <>
                      <span className="plan-tri" aria-hidden /> {rc?.questions.length ?? 0} pregunta
                      {rc?.questions.length === 1 ? "" : "s"}
                    </>
                  )}
                  {state === "deferred" && (
                    <>
                      <span className="plan-pause" aria-hidden /> Diferido
                    </>
                  )}
                  {state === "close" && (
                    <>
                      <span className="plan-pause" aria-hidden /> Al cierre
                    </>
                  )}
                </span>
                {i.kind !== "release" && (
                  <button
                    type="button"
                    className="plan-defer"
                    aria-label={deferred ? `Incluir ${i.key}` : `Diferir ${i.key}`}
                    title={deferred ? "Volver a incluirlo" : "Sacarlo del lote: va al backlog"}
                    onClick={() =>
                      edit(i.key, {
                        ordering: deferred
                          ? original(i.key) === "deferred"
                            ? "now"
                            : (original(i.key) ?? "now")
                          : "deferred",
                      })
                    }
                  >
                    {deferred ? <Undo2 size={13} /> : "Diferir"}
                  </button>
                )}
              </span>
            </li>
          )
        })}
      </ul>
      {open.map((i) => (
        <div key={i.key} className="plan-question">
          <CornerDownRight size={15} aria-hidden />
          <div>
            <strong>
              {i.key} · {i.title}
            </strong>
            <ul>
              {checks[i.key]?.questions.map((q) => (
                <li key={q.slot}>{q.question}</li>
              ))}
            </ul>
            <span className="muted">
              Contéstalas en el hilo y el orquestador corrige el plan; o difiérelo al backlog.
            </span>
          </div>
          <Button size="sm" onClick={() => edit(i.key, { ordering: "deferred" })}>
            Diferir {i.key}
          </Button>
        </div>
      ))}
      <footer className="plan-foot">
        <p className="muted">
          {startable.length} pedido{startable.length === 1 ? "" : "s"} pasa
          {startable.length === 1 ? "" : "n"} objetivo, alcance y aceptación.
          {open.length > 0 &&
            ` ${open.map((i) => i.key).join(", ")} espera${open.length === 1 ? "" : "n"} tus respuestas.`}
        </p>
        <Button variant="ghost" disabled={busy} onClick={() => void decide("deny")}>
          Rechazar
        </Button>
        <Button
          variant="primary"
          icon={Play}
          disabled={busy}
          onClick={() => void decide("approve_once")}
        >
          {start} <kbd className="cto-kbd">⌘↵</kbd>
        </Button>
      </footer>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </section>
  )
}

/** ds/CTO/ChatCard/Plan: en el hilo, la tarjeta que lleva al plan de la superficie. */
export function PlanPointer({ a, onOpen }: { a: Approval; onOpen: () => void }) {
  const plan = (a.input as PlanInput).plan
  const ready = plan.intents.filter((i) => i.ordering !== "deferred" && readyCheck(i).ready)
  const questions = plan.intents.length - ready.length
  return (
    <button type="button" className="cto-card" data-kind="plan" onClick={onOpen}>
      <span className="cto-card-eyebrow">
        <span className="cto-diamond" aria-hidden /> Plan
      </span>
      <strong>
        {plan.intents.length} pedido{plan.intents.length === 1 ? "" : "s"}, un lote
      </strong>
      <span className="muted">
        {questions > 0
          ? `${questions} con preguntas abiertas. Arranca los ${ready.length} listos.`
          : `Todo listo para arrancar.`}
      </span>
      <span className="cto-card-link">
        Revisar plan <ArrowRight size={12} aria-hidden />
      </span>
    </button>
  )
}

/** Un plan ya decidido: en el hilo queda lo que se decidió, no la tabla entera. */
export function PlanDecided({ a }: { a: Approval }) {
  const plan = (a.input as PlanInput).plan
  const approved = a.decision === "approved"
  return (
    <div className="cto-card cto-card-static" data-kind="plan" data-decision={a.decision}>
      <span className="cto-card-eyebrow">
        <span className="cto-diamond" aria-hidden /> Plan ·{" "}
        {approved ? "aprobado" : a.decision === "denied" ? "rechazado" : "venció"}
      </span>
      <strong>{plan.title}</strong>
      <span className="muted">
        {plan.intents.length} pedido{plan.intents.length === 1 ? "" : "s"}:{" "}
        {plan.intents.map((i) => `${i.key} ${i.title}`).join(" · ")}
      </span>
    </div>
  )
}

/** En el hilo: si el plan ya está en la superficie, sólo su puntero. */
export function usePlanOnSurface(a: Approval): (() => void) | null {
  const ctx = useContext(PlanOnSurface)
  return ctx && ctx.approvalId === a.approval_id ? ctx.focus : null
}

// --- CTO / 04: el lote en vivo -----------------------------------------------------------

const WAIT: Record<string, string> = {
  waiting_limit: "Espera lugar: el límite de runs está lleno",
  waiting_lane: "Espera su carril",
  waiting_deps: "Espera sus dependencias",
  ready: "Lista para arrancar",
}

type Shown = {
  sub: LaneSubtask
  item: WorkItem | undefined
  tone: "done" | "running" | "you" | "waiting" | "failed"
  line: string
}

function shown(
  sub: LaneSubtask,
  item: WorkItem | undefined,
  live: Run | undefined,
  waitingYou: ReadonlySet<string> | undefined,
): Shown {
  if (sub.state === "done") return { sub, item, tone: "done", line: "Integrada a la feature" }
  if (live)
    return {
      sub,
      item,
      tone: "running",
      line: `${sub.stage ? (STAGE_LABEL[sub.stage] ?? sub.stage) : "Trabajando"}`,
    }
  if (item?.lifecycle === "failed") return { sub, item, tone: "failed", line: "El run falló" }
  if (
    waitingYou?.has(sub.id) ||
    item?.lifecycle === "waiting_human" ||
    item?.lifecycle === "needs_review"
  )
    return {
      sub,
      item,
      tone: "you",
      line: waitingYou?.has(sub.id) ? "espera tu decisión" : "espera tu revisión",
    }
  return {
    sub,
    item,
    tone: "waiting",
    line: `${WAIT[sub.state] ?? "En cola"}${sub.waiting_for ? ` · ${sub.waiting_for}` : ""}`,
  }
}

/** «2:14» desde que arrancó el run vivo. */
function Clock({ since }: { since: string | undefined }) {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    if (!since) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [since])
  if (!since) return null
  const s = Math.max(0, Math.floor((now - Date.parse(since)) / 1000))
  return (
    <span className="mono lb-clock">
      {Math.floor(s / 60)}:{String(s % 60).padStart(2, "0")}
    </span>
  )
}

/**
 * El lote en vivo (CTO / 04): el avance de la feature, cuántos runs contra el límite y
 * un carril por tarjeta con lo que está haciendo, su frontera y lo que sigue. Lo
 * integrado se pliega abajo. Se usa en la conversación y en la vista de la feature.
 */
export function LiveBatch({
  call,
  parent,
  subtasks,
  runs,
  events,
  waitingYou,
  onOpen,
  compact = false,
}: {
  call: Call
  parent: WorkItem
  subtasks: WorkItem[]
  runs: Run[]
  events: EventNotification[]
  waitingYou?: ReadonlySet<string> | undefined
  onOpen: (item: WorkItem) => void
  /** En el panel lateral de la tarea: sin su propio margen. */
  compact?: boolean
}) {
  const [lanes, setLanes] = useState<Lanes | null>(null)
  const [showDone, setShowDone] = useState(false)
  const liveRuns = runs.filter((r) => !TERMINAL.has(r.status))
  const signature = `${subtasks.map((x) => `${x.id}:${x.lifecycle}:${x.stage}`).join()}|${liveRuns.length}`
  // biome-ignore lint/correctness/useExhaustiveDependencies: la firma sólo dispara la relectura.
  useEffect(() => {
    let alive = true
    call("features.lanes", { work_item_id: parent.id })
      .then((r) => alive && setLanes(r))
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [call, parent.id, signature])
  const byId = new Map(subtasks.map((s) => [s.id, s]))
  const liveOf = (id: string) => liveRuns.find((r) => r.work_item_id === id)
  const startedOf = (run: Run | undefined) =>
    run
      ? events.find((e) => e.kind === "run.created" && e.run_id === run.id)?.received_at
      : undefined
  const all = (lanes?.subtasks ?? []).map((s) => shown(s, byId.get(s.id), liveOf(s.id), waitingYou))
  const total = all.length || (parent.feature?.total ?? 0)
  const done = all.filter((x) => x.tone === "done")
  const waitingLimit = all.filter((x) => x.sub.state === "waiting_limit").length
  // Un carril por tarjeta: su subtarea actual y lo que sigue en él.
  const cards = (lanes?.lanes ?? [])
    .map((keys, n) => {
      const items = keys
        .map((k) => all.find((x) => x.sub.key === k))
        .filter((x): x is Shown => x !== undefined)
      const current = items.find((x) => x.tone !== "done")
      return { n, items, current }
    })
    .filter((l) => l.current)
  const rank = { you: 0, failed: 1, running: 2, waiting: 3, done: 4 } as const
  cards.sort((a, b) => rank[(a.current as Shown).tone] - rank[(b.current as Shown).tone])
  const feature = parent.feature
  return (
    <section
      className={compact ? "lb lb-compact" : "lb"}
      data-testid="feature-plan"
      aria-label="Lote en vivo"
    >
      <header className="lb-head">
        <p className="cto-section-label">Lote en vivo</p>
        {lanes && (
          <span className="lb-capacity" data-testid="feature-lanes">
            <span className="lb-dot" data-tone={lanes.live_runs > 0 ? "running" : "idle"} />
            {lanes.lanes.length} carril{lanes.lanes.length === 1 ? "" : "es"} · {lanes.live_runs} de{" "}
            {lanes.max_concurrent_runs} run{lanes.max_concurrent_runs === 1 ? "" : "s"} en uso
          </span>
        )}
      </header>
      <div className="lb-progress">
        <div className="lb-bar" aria-hidden>
          {all.map((x) => (
            <span key={x.sub.id} data-tone={x.tone} title={`${x.sub.key} · ${x.sub.title}`} />
          ))}
        </div>
        <span className="lb-count">
          <strong>
            {done.length}/{total}
          </strong>{" "}
          integradas
        </span>
      </div>
      {feature && (
        <p className="lb-branch mono">
          <GitBranch size={12} aria-hidden /> {feature.branch}
          <span className="muted">
            {feature.auto_integrate ? " · se integran solas" : " · cada integración te pregunta"}
          </span>
        </p>
      )}
      {waitingLimit > 0 && (
        <p className="lb-note">
          {waitingLimit} lista{waitingLimit === 1 ? "" : "s"} esperando lugar: subir el límite
          (Ajustes) es tu decisión.
        </p>
      )}
      <div className="lb-lanes">
        {cards.map(({ n, items, current }) => {
          const c = current as Shown
          const live = liveOf(c.sub.id)
          const step = stepOf(c.sub.stage)
          const next = items.slice(items.indexOf(c) + 1).map((x) => x.sub.key)
          return (
            <button
              type="button"
              key={c.sub.id}
              className="lb-lane"
              data-tone={c.tone}
              onClick={() => c.item && onOpen(c.item)}
            >
              <span className="lb-lane-head">
                <span className="lb-dot" data-tone={c.tone} />
                <strong>
                  Carril {laneName(n)} · {agentName(c.sub.profile)}
                </strong>
                <span className="lb-lane-steps" aria-hidden>
                  {items.map((x) => (
                    <span key={x.sub.id} data-tone={x.tone} />
                  ))}
                </span>
              </span>
              <span className="lb-task">
                <span className="mono">{c.sub.key}</span> {c.sub.title}
              </span>
              <span
                className="lb-now"
                data-tone={c.tone}
                {...(c.tone === "waiting"
                  ? { "data-testid": "subtask-wait", "data-state": c.sub.state }
                  : {})}
              >
                {c.line}
                {live && <Clock since={startedOf(live)} />}
              </span>
              <span className="lb-meta">
                <span>Frontera</span>
                <span className="mono">{leaseOf(c.sub.frontier)}</span>
              </span>
              <span className="lb-foot mono">
                {c.sub.display_id}
                {step.n > 0 && ` · paso ${step.n} de ${step.of}`}
                {next.length > 0 && ` · luego ${next.join(", ")}`}
              </span>
            </button>
          )
        })}
      </div>
      {done.length > 0 && (
        <div className="lb-done" data-testid="subtask-done" data-open={showDone || undefined}>
          <button
            type="button"
            className="lb-done-toggle"
            aria-expanded={showDone}
            onClick={() => setShowDone((v) => !v)}
          >
            <Check size={13} aria-hidden /> Integradas
            <span className="lb-done-keys mono">{done.map((x) => x.sub.key).join(" ")}</span>
          </button>
          <div className="lb-collapse">
            <div>
              {done.map((x) => (
                <button
                  type="button"
                  key={x.sub.id}
                  className="lb-done-row"
                  onClick={() => x.item && onOpen(x.item)}
                >
                  <span className="mono">{x.sub.key}</span>
                  <span>{x.sub.title}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </section>
  )
}
