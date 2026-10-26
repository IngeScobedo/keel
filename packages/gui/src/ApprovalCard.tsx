import { matchesPattern, parsePattern, patternFor, patternText, shellCommand } from "@keel/core"
import { Check, CircleHelp, Hand, ListTodo, X } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import {
  type Approval,
  clock,
  inputLine,
  optionLabel,
  type Question,
  questionsOf,
} from "./chat-model.js"
import { mutationMeta } from "./client.js"
import { GitPlanCard } from "./GitPlanCard.js"
import { Markdown } from "./Markdown.js"
import type { useWorkspace } from "./useWorkspace.js"

type Call = ReturnType<typeof useWorkspace>["call"]
type Loose = Record<string, unknown>

const SHELL = new Set(["Bash", "shell", "local_shell", "exec_command"])

/** Las teclas de la tarjeta activa, salvo mientras se escribe en un campo. */
function useKeys(active: boolean, onKey: (e: KeyboardEvent) => void) {
  const handler = useRef(onKey)
  handler.current = onKey
  useEffect(() => {
    if (!active) return
    const listener = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null
      if (e.metaKey || e.ctrlKey || e.altKey) return
      if (el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))) return
      handler.current(e)
    }
    window.addEventListener("keydown", listener)
    return () => window.removeEventListener("keydown", listener)
  }, [active])
}

function useResolve(a: Approval, call?: Call) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  async function resolve(params: Record<string, unknown>) {
    if (!call || busy) return
    setBusy(true)
    setError("")
    try {
      await call("approvals.resolve", {
        ...mutationMeta(),
        approval_id: a.approval_id,
        operation_hash: a.operation_hash,
        ...params,
      } as never)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }
  return { busy, error, resolve }
}

/** «esperando por ti · sin límite» o la cuenta atrás si el humano fijó un límite. */
function Waiting({ a }: { a: Approval }) {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    if (!a.expires_at || a.decision !== null) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [a.expires_at, a.decision])
  if (!a.expires_at) return <span className="rc-waiting">esperando por ti · sin límite</span>
  const left = Date.parse(a.expires_at) - now
  if (left <= 0) return <span className="rc-waiting">venció: se niega</span>
  return (
    <span className="rc-waiting">
      esperando por ti · se niega en {clock(new Date(now - left).toISOString(), now)}
    </span>
  )
}

const VERB: Record<string, string> = {
  Bash: "ejecutar",
  Edit: "editar",
  MultiEdit: "editar",
  Write: "escribir",
  NotebookEdit: "editar",
  WebFetch: "abrir",
}

/**
 * Permiso en el chat (ADR-0020 §2): Keel propone el patrón, el humano lo
 * corrige y ve si cubre la orden antes de elegir el alcance. Y/S/A/N.
 */
export function ApprovalCard({ a, call, active }: { a: Approval; call?: Call; active: boolean }) {
  const shell = SHELL.has(a.tool)
  const [pattern, setPattern] = useState(() => patternText(patternFor(a.tool, a.input)))
  const { busy, error, resolve } = useResolve(a, call)
  const parsed = shell ? parsePattern(a.tool, pattern) : patternFor(a.tool, a.input)
  const covers = parsed !== null && matchesPattern(parsed, a.tool, a.input)
  const pending = a.decision === null
  const expired = pending && a.expires_at !== null && Date.parse(a.expires_at) <= Date.now()
  const canAct = pending && !expired && !!call && !busy
  const decide = (decision: string) =>
    void resolve({
      decision,
      ...(shell && (decision === "approve_session" || decision === "approve_always")
        ? { pattern }
        : {}),
    })
  useKeys(active && canAct, (e) => {
    const k = e.key.toLowerCase()
    if (k === "y") decide("approve_once")
    else if (k === "n") decide("deny")
    else if (k === "s" && covers) decide("approve_session")
    else if (k === "a" && covers) decide("approve_always")
    else return
    e.preventDefault()
  })
  if (a.tool === "git.plan")
    return (
      <div className="rc-approval" data-state={a.decision ?? "pending"} data-testid="chat-approval">
        <header>
          <Hand size={15} /> <strong>Propone cambios de git</strong>
          {pending && <Waiting a={a} />}
        </header>
        <GitPlanCard
          input={a.input}
          approvalId={a.approval_id}
          operationHash={a.operation_hash}
          pending={canAct}
          {...(call ? { call } : {})}
        />
      </div>
    )
  return (
    <div className="rc-approval" data-state={a.decision ?? "pending"} data-testid="chat-approval">
      <header>
        <Hand size={15} />
        <strong>
          {pending
            ? `Pide permiso para ${VERB[a.tool] ?? `usar ${a.tool}`}`
            : `${a.tool}: ${a.decision === "approved" ? "aprobado" : a.decision === "expired" ? "venció, negado" : "negado"}`}
        </strong>
        {pending && <Waiting a={a} />}
      </header>
      <pre className="chat-approval-input">{shellCommand(a.input) ?? inputLine(a.input)}</pre>
      {pending && !expired && (
        <>
          <div className="rc-pattern">
            <span>Aprobar</span>
            {shell ? (
              <input
                aria-label="Patrón a aprobar"
                className="mono"
                value={pattern}
                spellCheck={false}
                onChange={(e) => setPattern(e.target.value)}
              />
            ) : (
              <code>{a.tool} en este run</code>
            )}
            {shell && (
              <span className={covers ? "ok" : "bad"}>
                {covers ? <Check size={12} /> : <X size={12} />}
                {parsed === null
                  ? "patrón no válido"
                  : covers
                    ? "cubre esta orden"
                    : "no cubre esta orden"}
              </span>
            )}
          </div>
          <div className="rc-actions">
            <button
              type="button"
              className="button primary"
              disabled={!canAct}
              onClick={() => decide("approve_once")}
            >
              Esta vez <kbd>Y</kbd>
            </button>
            <button
              type="button"
              className="button"
              disabled={!canAct || !covers}
              title="El resto de este run (máx. 15 min)"
              onClick={() => decide("approve_session")}
            >
              {shell ? "El patrón en la sesión" : "En la sesión"} <kbd>S</kbd>
            </button>
            <button
              type="button"
              className="button"
              disabled={!canAct || !covers}
              title="Crea una regla del proyecto; se revoca en Permisos"
              onClick={() => decide("approve_always")}
            >
              Siempre en el proyecto <kbd>A</kbd>
            </button>
            <button
              type="button"
              className="button danger rc-deny"
              disabled={!canAct}
              onClick={() => decide("deny")}
            >
              Negar <kbd>N</kbd>
            </button>
          </div>
        </>
      )}
      {error && <p className="error">{error}</p>}
    </div>
  )
}

/**
 * Pregunta del agente (ADR-0020 §7): no es un permiso. Opciones con 1–4,
 * «Otra respuesta» y una nota; la respuesta vuelve tal cual al agente.
 */
export function QuestionCard({
  a,
  call,
  active,
  agent,
}: {
  a: Approval
  call?: Call
  active: boolean
  agent: string
}) {
  const questions = questionsOf(a.input)
  const [step, setStep] = useState(0)
  const [answers, setAnswers] = useState<Record<string, string>>({})
  const [notes, setNotes] = useState<Record<string, string>>({})
  const [picked, setPicked] = useState<string[]>([])
  const [other, setOther] = useState("")
  const [otherOn, setOtherOn] = useState(false)
  const { busy, error, resolve } = useResolve(a, call)
  const current = questions[step] as Question | undefined
  const pending = a.decision === null
  const last = step === questions.length - 1
  const answer = [...picked, ...(otherOn && other.trim() ? [other.trim()] : [])].join(", ")
  function toggle(label: string) {
    setOtherOn(false)
    setPicked((old) =>
      current?.multiSelect
        ? old.includes(label)
          ? old.filter((x) => x !== label)
          : [...old, label]
        : [label],
    )
  }
  function next() {
    if (!current || !answer || busy) return
    const all = { ...answers, [current.question]: answer }
    setAnswers(all)
    setPicked([])
    setOther("")
    setOtherOn(false)
    if (!last) return setStep(step + 1)
    const annotations: Record<string, { notes?: string; preview?: string }> = {}
    for (const qq of questions) {
      const note = notes[qq.question]?.trim()
      const preview = qq.options.find((o) => o.label === all[qq.question])?.preview
      if (note || preview)
        annotations[qq.question] = {
          ...(note ? { notes: note } : {}),
          ...(preview ? { preview } : {}),
        }
    }
    void resolve({
      decision: "approve_once",
      answers: all,
      ...(Object.keys(annotations).length ? { annotations } : {}),
    })
  }
  useKeys(active && pending && !!call && !!current, (e) => {
    if (!current) return
    const n = Number(e.key)
    if (Number.isInteger(n) && n >= 1 && n <= current.options.length)
      toggle(current.options[n - 1]?.label ?? "")
    else if (n === current.options.length + 1) setOtherOn(true)
    else if (e.key === "Enter") next()
    else return
    e.preventDefault()
  })
  if (!pending || !current) return <AnsweredQuestion a={a} questions={questions} />
  const focused = current.options.find((o) => picked.includes(o.label) && o.preview)
  return (
    <div className="rc-question" data-testid="chat-question">
      <header>
        <CircleHelp size={15} />
        <span className="rc-chip">{current.header}</span>
        <span className="muted">{agent} te pregunta</span>
        {questions.length > 1 && (
          <span className="muted rc-step">
            pregunta {step + 1} de {questions.length}
          </span>
        )}
      </header>
      <h3>{current.question}</h3>
      <div className="rc-options">
        {current.options.map((o, n) => {
          const l = optionLabel(o.label)
          const on = picked.includes(o.label)
          return (
            <button
              key={o.label}
              type="button"
              aria-pressed={on}
              className={`rc-option ${on ? "on" : ""}`}
              onClick={() => toggle(o.label)}
            >
              <kbd>{n + 1}</kbd>
              <span>
                <span className="rc-option-title">
                  <strong>{l.text}</strong>
                  {l.recommended && <span className="rc-recommended">recomendada</span>}
                </span>
                <small>{o.description}</small>
              </span>
              {on && <Check size={15} />}
            </button>
          )
        })}
        <label className={`rc-option rc-other ${otherOn ? "on" : ""}`}>
          <kbd>{current.options.length + 1}</kbd>
          <input
            aria-label="Otra respuesta"
            placeholder="Otra respuesta…"
            value={other}
            onFocus={() => {
              setOtherOn(true)
              if (!current.multiSelect) setPicked([])
            }}
            onChange={(e) => setOther(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault()
                next()
              }
            }}
          />
        </label>
      </div>
      {focused?.preview && <pre className="rc-preview">{focused.preview}</pre>}
      <input
        className="rc-note"
        aria-label={`Nota opcional para ${agent}`}
        placeholder={`Nota opcional para ${agent}`}
        value={notes[current.question] ?? ""}
        onChange={(e) => setNotes((old) => ({ ...old, [current.question]: e.target.value }))}
      />
      <div className="rc-actions">
        <button
          type="button"
          className="button primary"
          disabled={!answer || busy || !call}
          onClick={next}
        >
          {last ? "Responder" : "Siguiente pregunta"} <kbd>↵</kbd>
        </button>
        <button
          type="button"
          className="button"
          disabled={busy || !call}
          onClick={() =>
            void resolve({
              decision: "deny",
              ...(notes[current.question]?.trim()
                ? { reason: notes[current.question]?.trim() }
                : {}),
            })
          }
        >
          No contestar
        </button>
        <span className="muted rc-foot">
          la respuesta vuelve al agente tal cual · no es un permiso
        </span>
      </div>
      {error && <p className="error">{error}</p>}
    </div>
  )
}

function AnsweredQuestion({ a, questions }: { a: Approval; questions: Question[] }) {
  return (
    <div className="rc-answered" data-testid="chat-question" data-state={a.decision ?? "pending"}>
      <CircleHelp size={13} />
      <div>
        {questions.map((q) => (
          <p key={q.question}>
            <span className="muted">{q.question}</span>{" "}
            {a.decision === "approved" ? (
              a.answers?.[q.question] ? (
                <strong>→ {optionLabel(a.answers[q.question] as string).text}</strong>
              ) : (
                // Antes de ADR-0020 Keel aprobaba la pregunta sin respuestas.
                <span className="muted">→ se aprobó sin tu respuesta</span>
              )
            ) : (
              <span className="muted">→ no contestaste{a.reason ? `: ${a.reason}` : ""}</span>
            )}
          </p>
        ))}
      </div>
    </div>
  )
}

/** `ExitPlanMode`: el plan como documento y tres salidas (ADR-0020 §7). */
export function PlanCard({ a, call, active }: { a: Approval; call?: Call; active: boolean }) {
  const [more, setMore] = useState(false)
  const [hint, setHint] = useState("")
  const { busy, error, resolve } = useResolve(a, call)
  const plan = String(((a.input ?? {}) as Loose).plan ?? "")
  const pending = a.decision === null
  useKeys(active && pending && !!call, (e) => {
    if (e.key.toLowerCase() === "y") void resolve({ decision: "approve_once" })
    else return
    e.preventDefault()
  })
  return (
    <div className="rc-plan" data-state={a.decision ?? "pending"} data-testid="chat-plan">
      <header>
        <ListTodo size={15} />
        <strong>
          {pending
            ? "Propone este plan"
            : a.decision === "approved"
              ? "Plan aprobado"
              : "Siguió planeando"}
        </strong>
        {pending && <Waiting a={a} />}
      </header>
      <div className="rc-plan-doc">
        <Markdown text={plan || "(el plan quedó en el archivo del agente)"} />
      </div>
      {pending && (
        <>
          <div className="rc-actions">
            <button
              type="button"
              className="button primary"
              disabled={busy || !call}
              onClick={() => void resolve({ decision: "approve_once" })}
            >
              Aprobar <kbd>Y</kbd>
            </button>
            <button
              type="button"
              className="button"
              disabled={busy || !call}
              onClick={() => void resolve({ decision: "approve_once", then_mode: "accept_edits" })}
            >
              Aprobar y aceptar ediciones
            </button>
            <button
              type="button"
              className="button"
              disabled={busy || !call}
              onClick={() => setMore(true)}
            >
              Seguir planeando
            </button>
          </div>
          {more && (
            <form
              className="rc-hint"
              onSubmit={(e) => {
                e.preventDefault()
                void resolve({ decision: "deny", ...(hint.trim() ? { reason: hint.trim() } : {}) })
              }}
            >
              <input
                aria-label="Indicación para seguir planeando"
                placeholder="Qué cambiarías del plan"
                value={hint}
                onChange={(e) => setHint(e.target.value)}
              />
              <button type="submit" className="button" disabled={busy}>
                Enviar
              </button>
            </form>
          )}
        </>
      )}
      {!pending && a.reason && <p className="muted">Indicación: {a.reason}</p>}
      {error && <p className="error">{error}</p>}
    </div>
  )
}
