import { type Methods, parseTasks } from "@keel/core"
import {
  ArrowLeft,
  Check,
  CircleAlert,
  FileText,
  Flag,
  GitMerge,
  MessageSquareText,
  Milestone,
  ShieldCheck,
  X,
} from "lucide-react"
import { useEffect, useState } from "react"
import { useKeys, useResolve, Waiting } from "./ApprovalCard.js"
import { type Approval, DOC_LABEL, duration, type MethodItem, STAGE_LABEL } from "./chat-model.js"
import { Markdown } from "./Markdown.js"
import type { useWorkspace } from "./useWorkspace.js"

type Call = ReturnType<typeof useWorkspace>["call"]
type Doc = NonNullable<ReturnType<(typeof Methods)["task_docs.get"]["result"]["parse"]>["doc"]>

const STAGES = ["brief", "design", "implement", "review", "close"] as const

/** Brief → Diseño → Implementar → Revisión → Cierre, con la etapa actual marcada. */
export function StageTrack({
  stage,
  ceremony,
  waiting,
}: {
  stage: string
  ceremony: string | null
  /** Hay un gate esperando al humano. */
  waiting?: boolean
}) {
  const at = STAGES.indexOf(stage as (typeof STAGES)[number])
  return (
    <ol className="stage-track" data-testid="stage-track" aria-label="Etapas del método">
      {STAGES.map((s, i) => {
        // En trabajo directo el diseño no existe: se ve, pero saltado.
        const skipped = s === "design" && ceremony === "direct"
        const state = skipped ? "skipped" : i < at ? "done" : i === at ? "current" : "next"
        return (
          <li key={s} data-state={state} aria-current={i === at ? "step" : undefined}>
            <span className="stage-dot">{state === "done" ? <Check size={10} /> : null}</span>
            {STAGE_LABEL[s]}
            {i === at && waiting && <span className="stage-wait">espera tu gate</span>}
          </li>
        )
      })}
      {ceremony && (
        <li className="stage-ceremony" data-ceremony={ceremony}>
          {ceremony === "direct" ? "trabajo directo" : "ciclo formal"}
        </li>
      )}
    </ol>
  )
}

/** Lo que hizo el método, en una línea del chat (ADR-0021). */
export function MethodRow({
  item,
  onDoc,
}: {
  item: MethodItem
  onDoc?: ((kind: string, version?: number) => void) | undefined
}) {
  switch (item.event) {
    case "started":
      return (
        <p className="rc-method" data-testid="chat-method">
          <Milestone size={13} /> Keel empezó a trabajar la tarea en la etapa{" "}
          <strong>{STAGE_LABEL[item.text] ?? item.text}</strong>
        </p>
      )
    case "stage":
      return (
        <p className="rc-method stage" data-testid="chat-method">
          <Milestone size={13} />
          {item.returned ? "Devolviste la tarea a" : "Pasó a"}{" "}
          <strong>{STAGE_LABEL[item.to] ?? item.to}</strong>
          <span className="muted">
            {" "}
            desde {STAGE_LABEL[item.from] ?? item.from}
            {item.ceremony
              ? ` · ${item.ceremony === "direct" ? "trabajo directo" : "ciclo formal"}`
              : ""}
            {item.reason ? ` · ${item.reason}` : ""}
          </span>
        </p>
      )
    case "doc":
      return (
        <p className={`rc-method ${item.ok ? "" : "warn"}`} data-testid="chat-method">
          <FileText size={13} />
          Guardó {DOC_LABEL[item.doc] ?? item.doc} v{item.version}
          <span className="muted">
            {item.ok ? " · valida" : ` · falta: ${item.missing.join("; ")}`}
          </span>
          {onDoc && (
            <button
              type="button"
              className="text-link"
              onClick={() => onDoc(item.doc, item.version)}
            >
              ver
            </button>
          )}
        </p>
      )
    case "verify":
      return <VerifyCard item={item} />
    case "keel":
      return (
        <p className="rc-method keel" data-testid="chat-method">
          <MessageSquareText size={13} /> <span className="muted">Keel al agente:</span>{" "}
          {item.text.split("\n")[0]}
        </p>
      )
    case "stalled":
      return (
        <p className="rc-method warn" data-testid="chat-method">
          <CircleAlert size={13} /> Keel no pudo seguir: {item.text}
        </p>
      )
    case "closed":
      return (
        <p className="rc-method done" data-testid="chat-method">
          <GitMerge size={13} /> Tarea cerrada: el plan de cierre se aplicó.
        </p>
      )
    case "feature":
      return (
        <p
          className={`rc-method ${item.tone === "warn" ? "warn" : item.tone === "done" ? "done" : ""}`}
          data-testid="chat-feature"
        >
          <GitMerge size={13} /> {item.text}
        </p>
      )
  }
}

/** La verificación que corrió Keel: verde o rojo nuevo, y la cola de lo que falló. */
function VerifyCard({ item }: { item: Extract<MethodItem, { event: "verify" }> }) {
  const [open, setOpen] = useState(!item.delta.green && !item.baseline)
  if (item.results.length === 0) return null
  return (
    <div className={`rc-verify ${item.delta.green ? "green" : "red"}`} data-testid="chat-verify">
      <button type="button" className="rc-verify-head" onClick={() => setOpen((v) => !v)}>
        <ShieldCheck size={14} />
        <strong>
          {item.baseline
            ? "Baseline de la verificación"
            : item.delta.green
              ? "Verificación sin rojo nuevo"
              : `Rojo nuevo en ${item.delta.newRed.join(", ")}`}
        </strong>
        <span className="rc-verify-checks">
          {item.results.map((r) => (
            <span
              key={r.name}
              className={r.ok ? "ok" : item.delta.stillRed.includes(r.name) ? "old" : "bad"}
            >
              {r.ok ? <Check size={11} /> : <X size={11} />} {r.name}
              <small className="mono">{duration(r.duration_ms)}</small>
            </span>
          ))}
        </span>
      </button>
      {open && (
        <div className="rc-verify-body">
          {item.delta.fixed.length > 0 && (
            <p className="muted">Arreglado: {item.delta.fixed.join(", ")}</p>
          )}
          {item.delta.stillRed.length > 0 && (
            <p className="muted">
              Ya estaba rojo antes de empezar: {item.delta.stillRed.join(", ")}
            </p>
          )}
          {item.results
            .filter((r) => !r.ok)
            .map((r) => (
              <pre key={r.name} className="rc-term">
                {r.tail}
              </pre>
            ))}
        </div>
      )}
    </div>
  )
}

const GATE_TITLE = {
  brief: "Aprobar el brief",
  design: "Congelar el contrato",
  close: "Aprobar el cierre",
} as const

/**
 * Un gate del método (ADR-0021 §2): el humano lee lo que el agente produjo y
 * aprueba o pide cambios con un motivo, que vuelve al agente.
 */
export function GateCard({ a, call, active }: { a: Approval; call?: Call; active: boolean }) {
  const input = (a.input ?? {}) as {
    work_item_id?: string
    gate?: "brief" | "design" | "close"
    from?: string
    to?: string
    reason?: "stage" | "contract"
    ceremony?: string | null
    ceremony_reason?: string | null
    docs?: { kind: string; version: number }[]
  }
  const gate = input.gate ?? "brief"
  const { busy, error, resolve } = useResolve(a, call)
  const [why, setWhy] = useState("")
  // ADR-0022 §1: aprobar el contrato aprueba también el árbol de subtareas que va a nacer.
  const tasksDoc = (input.docs ?? []).find((d) => d.kind === "tasks")
  const plan = useDoc(
    call,
    input.work_item_id ?? "",
    "tasks",
    tasksDoc?.version,
    gate === "design" && input.reason !== "contract" && !!tasksDoc && !!input.work_item_id,
  )
  const tree = plan ? parseTasks(plan.content_markdown ?? "") : []
  const [autoIntegrate, setAutoIntegrate] = useState(false)
  const approve = () =>
    resolve({
      decision: "approve_once",
      ...(tree.length >= 2 && autoIntegrate ? { auto_integrate: true } : {}),
    })
  const [asking, setAsking] = useState(false)
  const pending = a.decision === null
  const kinds = gate === "brief" ? ["brief"] : ["spec", "design"]
  // En el orden en que se leen: la spec explica qué, el diseño cómo.
  const docs = (input.docs ?? [])
    .filter((d) => kinds.includes(d.kind))
    .sort((x, y) => kinds.indexOf(x.kind) - kinds.indexOf(y.kind))
  useKeys(active && pending && !!call && !asking, (e) => {
    if (e.key.toLowerCase() !== "y") return
    e.preventDefault()
    void approve()
  })
  return (
    <div className="rc-gate" data-state={a.decision ?? "pending"} data-testid="chat-gate">
      <header>
        <Flag size={15} />
        <strong>
          {input.reason === "contract"
            ? "El agente cambió el contrato congelado"
            : GATE_TITLE[gate]}
        </strong>
        {pending ? (
          <Waiting a={a} />
        ) : (
          <span className="muted rc-step">
            {a.decision === "approved"
              ? "aprobado"
              : a.decision === "denied"
                ? `pediste cambios${a.reason ? `: ${a.reason}` : ""}`
                : "venció"}
          </span>
        )}
      </header>
      {input.ceremony && gate === "brief" && (
        <p className="muted">
          Ceremonia:{" "}
          <strong>{input.ceremony === "formal" ? "ciclo formal" : "trabajo directo"}</strong>
          {input.ceremony_reason ? ` · ${input.ceremony_reason}` : ""}
        </p>
      )}
      {input.work_item_id &&
        docs.map((d) => (
          <DocBlock
            key={d.kind}
            workItemId={input.work_item_id as string}
            kind={d.kind}
            version={d.version}
            open={pending}
            {...(call ? { call } : {})}
          />
        ))}
      {tree.length >= 2 && <FeatureTree tree={tree} />}
      {pending && tree.length >= 2 && (
        <label className="auto-integrate">
          <input
            type="checkbox"
            checked={autoIntegrate}
            onChange={(e) => setAutoIntegrate(e.target.checked)}
          />
          <span>
            Integrar solas las subtareas con QA PASS, sin rojo nuevo y con el diff dentro de su
            frontera. Si no cumplen, te pregunto.
          </span>
        </label>
      )}
      {pending && (
        <div className="rc-actions">
          <button
            type="button"
            className="button primary"
            disabled={busy || !call}
            onClick={() => void approve()}
          >
            {input.reason === "contract" ? "Aceptar el contrato nuevo" : "Aprobar"} <kbd>Y</kbd>
          </button>
          <button
            type="button"
            className="button"
            disabled={busy || !call}
            onClick={() => setAsking(true)}
          >
            Pedir cambios
          </button>
          <span className="muted rc-foot">
            {gate === "design"
              ? "al aprobar, Keel fija el hash del contrato; cambiarlo después vuelve a pedirte el gate"
              : "lo que digas vuelve al agente tal cual"}
          </span>
        </div>
      )}
      {pending && asking && (
        <form
          className="rc-hint"
          onSubmit={(e) => {
            e.preventDefault()
            if (why.trim()) void resolve({ decision: "deny", reason: why.trim() })
          }}
        >
          <input
            aria-label="Qué cambiar"
            placeholder="Qué falta o qué cambiarías"
            value={why}
            onChange={(e) => setWhy(e.target.value)}
          />
          <button type="submit" className="button" disabled={busy || !why.trim()}>
            Enviar
          </button>
        </form>
      )}
      {error && <p className="error">{error}</p>}
    </div>
  )
}

/** Un documento de la tarea, plegable, con su validación. */
/** El árbol que nace al aprobar el diseño: fases, subtareas, fronteras y dependencias. */
function FeatureTree({ tree }: { tree: ReturnType<typeof parseTasks> }) {
  const phases = [...new Set(tree.map((t) => t.phase))].sort((x, y) => x - y)
  return (
    <div className="feature-tree" data-testid="feature-tree">
      <p className="muted">
        Al aprobar nacen <strong>{tree.length} subtareas</strong> en la rama de la feature. Keel las
        trabaja una a la vez, en este orden.
      </p>
      {phases.map((ph) => {
        const items = tree.filter((t) => t.phase === ph)
        return (
          <div key={ph}>
            <h4>
              Fase {ph}
              {items[0]?.phase_title ? ` — ${items[0].phase_title}` : ""}
            </h4>
            <ol>
              {items.map((t) => (
                <li key={t.key}>
                  <span className="mono muted">{t.key}</span> {t.title}{" "}
                  {t.frontier.map((g) => (
                    <code key={g}>{g} </code>
                  ))}
                  {t.requirements.length > 0 && (
                    <span className="muted"> · {t.requirements.join(", ")}</span>
                  )}
                  {t.after.length > 0 && (
                    <span className="muted"> · después de {t.after.join(", ")}</span>
                  )}
                </li>
              ))}
            </ol>
          </div>
        )
      })}
    </div>
  )
}

function DocBlock({
  workItemId,
  kind,
  version,
  open: startOpen,
  call,
}: {
  workItemId: string
  kind: string
  version: number
  open: boolean
  call?: Call
}) {
  const [open, setOpen] = useState(startOpen)
  const doc = useDoc(call, workItemId, kind, version, open)
  return (
    <div className="rc-doc">
      <button
        type="button"
        className="rc-doc-head"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <FileText size={13} /> {DOC_LABEL[kind] ?? kind} v{version}
        {doc && <DocStatus doc={doc} />}
      </button>
      {open &&
        (doc ? (
          <Markdown className="rc-doc-body" text={doc.content_markdown ?? ""} />
        ) : (
          <p className="muted">Cargando…</p>
        ))}
    </div>
  )
}

function DocStatus({ doc }: { doc: Doc }) {
  const missing = doc.report.checks.filter((c) => !c.ok)
  return missing.length === 0 ? (
    <span className="rc-doc-ok">
      <Check size={11} /> valida
    </span>
  ) : (
    <span className="rc-doc-bad" title={missing.map((c) => c.msg).join("\n")}>
      <X size={11} /> {missing.length} pendiente(s)
    </span>
  )
}

function useDoc(
  call: Call | undefined,
  workItemId: string,
  kind: string,
  version: number | undefined,
  enabled: boolean,
) {
  const [doc, setDoc] = useState<Doc | null>(null)
  useEffect(() => {
    if (!call || !enabled) return
    let live = true
    call("task_docs.get", {
      work_item_id: workItemId,
      kind: kind as Doc["kind"],
      ...(version ? { version } : {}),
    })
      .then((r) => live && setDoc(r.doc))
      .catch(() => live && setDoc(null))
    return () => {
      live = false
    }
  }, [call, workItemId, kind, version, enabled])
  return doc
}

/** Un documento abierto al lado del chat, con su validación completa. */
export function DocPeek({
  workItemId,
  kind,
  version,
  call,
  onClose,
}: {
  workItemId: string
  kind: string
  version?: number | undefined
  call: Call
  onClose: () => void
}) {
  const doc = useDoc(call, workItemId, kind, version, true)
  return (
    <div className="rc-peek" data-testid="doc-peek">
      <header>
        <button type="button" className="button ghost" aria-label="Volver" onClick={onClose}>
          <ArrowLeft size={14} />
        </button>
        <span>
          {DOC_LABEL[kind] ?? kind} {doc ? `v${doc.version}` : ""}
        </span>
        <span />
      </header>
      {!doc && <p className="muted">Cargando…</p>}
      {doc && (
        <>
          <ul className="rc-checks">
            {doc.report.checks.map((c) => (
              <li key={c.msg} data-ok={c.ok}>
                {c.ok ? <Check size={11} /> : <X size={11} />} {c.msg}
                {c.detail ? <span className="muted"> ({c.detail})</span> : null}
              </li>
            ))}
          </ul>
          <Markdown className="rc-peek-spec" text={doc.content_markdown ?? ""} />
        </>
      )}
    </div>
  )
}
