/**
 * ADR-0044 §3: la sesión interactiva de Claude Code que trabaja en Claude Design para
 * esta tarea. Su estado, los diseños que publicó con «Abrir», y su pantalla en vivo con
 * teclas para que el humano conteste la confianza en la carpeta o un permiso.
 */
import type { EventNotification, Methods } from "@keel/core"
import { ExternalLink, Palette, SquareTerminal, X } from "lucide-react"
import { type FormEvent, useEffect, useMemo, useState } from "react"
import { parseAnsi } from "./ansi.js"
import "./DesignSession.css"
import type { WorkItem } from "./model.js"
import { Button, Hint } from "./ui.js"
import type { useWorkspace } from "./useWorkspace.js"

type Call = ReturnType<typeof useWorkspace>["call"]
type Status = ReturnType<(typeof Methods)["design.status"]["result"]["parse"]>
type Screen = ReturnType<(typeof Methods)["design.screen"]["result"]["parse"]>
type Key = NonNullable<
  ReturnType<(typeof Methods)["design.keys"]["params"]["parse"]>["keys"]
>[number]

const KEYS: { key: Key; label: string }[] = [
  { key: "Up", label: "↑" },
  { key: "Down", label: "↓" },
  { key: "Enter", label: "Enter" },
  { key: "Escape", label: "Esc" },
  { key: "1", label: "1" },
  { key: "2", label: "2" },
  { key: "3", label: "3" },
]

const about = (task: WorkItem) => (e: EventNotification) =>
  e.kind.startsWith("design.") &&
  (e.payload as { work_item_id?: string } | null)?.work_item_id === task.id

/** Los diseños publicados, del más reciente; un link actualizado conserva su lugar. */
function designsOf(events: EventNotification[]) {
  const byUrl = new Map<string, { url: string; title: string | null }>()
  for (const e of events)
    if (e.kind === "design.published") {
      const p = e.payload as { url: string; title: string | null }
      byUrl.set(p.url, { url: p.url, title: p.title ?? byUrl.get(p.url)?.title ?? null })
    }
  return [...byUrl.values()].reverse()
}

export function DesignSessionCard({
  task,
  events,
  call,
}: {
  task: WorkItem
  events: EventNotification[]
  call: Call
}) {
  const mine = useMemo(() => events.filter(about(task)), [events, task])
  const [status, setStatus] = useState<Status | null>(null)
  const [terminal, setTerminal] = useState(false)
  const [error, setError] = useState("")
  // biome-ignore lint/correctness/useExhaustiveDependencies: cada evento de la sesión relee el estado.
  useEffect(() => {
    call("design.status", { work_item_id: task.id })
      .then(setStatus)
      .catch(() => setStatus(null))
  }, [call, task.id, mine.length])

  const session = status?.session ?? null
  const designs = designsOf(mine)
  const waiting = session?.waiting ?? null
  // Un diálogo abierto es del humano: la terminal se abre sola para contestarlo.
  useEffect(() => {
    if (waiting) setTerminal(true)
  }, [waiting])

  if (!session && designs.length === 0) return null
  const last = [...mine].reverse().find((e) => e.kind === "design.session.event")
  const now = last
    ? (() => {
        const p = last.payload as { role: string; tool?: string; summary?: string; text?: string }
        return p.role === "tool" ? `${p.tool}${p.summary ? ` · ${p.summary}` : ""}` : (p.text ?? "")
      })()
    : null
  const state = !session ? "closed" : waiting ? "waiting" : session.busy ? "working" : "idle"

  return (
    <section className="ds-card" data-testid="design-session" data-state={state}>
      <header>
        <Palette size={15} aria-hidden="true" />
        <strong>Claude Design</strong>
        <span className="ds-state">
          {state === "closed"
            ? "sesión cerrada"
            : state === "waiting"
              ? "espera tu respuesta"
              : state === "working"
                ? "trabajando"
                : "lista"}
        </span>
        <span className="ds-spacer" />
        {session && (
          <>
            <Button
              size="sm"
              variant="ghost"
              icon={SquareTerminal}
              onClick={() => setTerminal((v) => !v)}
            >
              {terminal ? "Ocultar terminal" : "Ver terminal"}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              icon={X}
              onClick={() =>
                void call("design.close", { work_item_id: task.id }).catch((e: Error) =>
                  setError(e.message),
                )
              }
            >
              Cerrar sesión
            </Button>
          </>
        )}
      </header>
      {waiting && (
        <p className="ds-alert" data-testid="design-waiting">
          {waiting === "trust"
            ? "Claude Code pregunta si confías en la carpeta de la tarea. Elige «Yes, I trust this folder» (↓ y Enter)."
            : "Claude Code pide un permiso. Contéstalo abajo; Keel no lo contesta por ti."}
        </p>
      )}
      {designs.length > 0 && (
        <ul className="ds-designs">
          {designs.map((d) => (
            <li key={d.url}>
              <span className="ds-title">{d.title ?? "Diseño"}</span>
              <code>{d.url.replace("https://", "")}</code>
              <Button
                size="sm"
                icon={ExternalLink}
                onClick={() => void call("design.open", { url: d.url }).catch(() => {})}
              >
                Abrir
              </Button>
            </li>
          ))}
        </ul>
      )}
      {now && state === "working" && <p className="ds-now">{now}</p>}
      {session && terminal && <DesignTerminal call={call} taskId={task.id} />}
      {session && (
        <Hint>
          También en tu terminal: <code>{session.attach}</code>
          {waiting === "trust" && status && (
            <>
              {" "}
              · Para no confirmar en cada tarea, abre <code>claude</code> una vez en{" "}
              <code>{status.worktrees_dir}</code> y confía en esa carpeta.
            </>
          )}
        </Hint>
      )}
      {error && <p className="error">{error}</p>}
    </section>
  )
}

/** La pantalla de la sesión, refrescada mientras está a la vista, y las teclas del humano. */
function DesignTerminal({ call, taskId }: { call: Call; taskId: string }) {
  const [screen, setScreen] = useState<Screen | null>(null)
  const [text, setText] = useState("")
  useEffect(() => {
    let alive = true
    const read = () =>
      call("design.screen", { work_item_id: taskId })
        .then((s) => alive && setScreen(s))
        .catch(() => {})
    void read()
    const t = setInterval(read, 800)
    return () => {
      alive = false
      clearInterval(t)
    }
  }, [call, taskId])
  const send = (input: { keys?: Key[]; text?: string }) =>
    void call("design.keys", { work_item_id: taskId, ...input })
      .then(() => call("design.screen", { work_item_id: taskId }))
      .then(setScreen)
      .catch(() => {})
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (!text) return
    send({ text, keys: ["Enter"] })
    setText("")
  }
  return (
    <div className="ds-terminal">
      <pre data-testid="design-screen" style={{ width: `${screen?.cols ?? 120}ch` }}>
        {parseAnsi(screen?.text ?? "").map((s, i) => (
          <span
            // biome-ignore lint/suspicious/noArrayIndexKey: los tramos no tienen identidad propia.
            key={i}
            style={{
              color: s.style.inverse ? s.style.bg : s.style.fg,
              backgroundColor: s.style.inverse
                ? (s.style.fg ?? "var(--color-text-primary)")
                : s.style.bg,
              fontWeight: s.style.bold ? 600 : undefined,
              opacity: s.style.dim ? 0.65 : undefined,
              fontStyle: s.style.italic ? "italic" : undefined,
              textDecoration: s.style.underline ? "underline" : undefined,
            }}
          >
            {s.text}
          </span>
        ))}
      </pre>
      <form className="ds-keys" onSubmit={submit}>
        {KEYS.map((k) => (
          <Button key={k.key} size="sm" onClick={() => send({ keys: [k.key] })}>
            {k.label}
          </Button>
        ))}
        <input
          className="ui-field ui-input"
          value={text}
          placeholder="Escribir en la sesión y Enter"
          onChange={(e) => setText(e.target.value)}
        />
      </form>
    </div>
  )
}

/** En el panel de la tarea: abrir la sesión a mano, sin encargo del agente. */
export function DesignStart({
  task,
  events,
  call,
}: {
  task: WorkItem
  events: EventNotification[]
  call: Call
}) {
  const [status, setStatus] = useState<Status | null>(null)
  const [error, setError] = useState("")
  const touches = events.filter(about(task)).length
  // biome-ignore lint/correctness/useExhaustiveDependencies: un evento de la sesión relee el estado.
  useEffect(() => {
    call("design.status", { work_item_id: task.id })
      .then(setStatus)
      .catch(() => setStatus(null))
  }, [call, task.id, touches])
  if (!status || status.session) return null
  return (
    <section className="tf-section">
      <h3>Claude Design</h3>
      <Button
        icon={Palette}
        size="sm"
        disabled={!status.available}
        onClick={() =>
          void call("design.start", { work_item_id: task.id })
            .then(() => call("design.status", { work_item_id: task.id }))
            .then(setStatus)
            .catch((e: Error) => setError(e.message))
        }
      >
        Abrir sesión de diseño
      </Button>
      <Hint>
        {status.reason ??
          "Una sesión interactiva de Claude Code en el worktree de la tarea; el agente la usa con design_request (ADR-0044)."}
      </Hint>
      {error && <p className="error">{error}</p>}
    </section>
  )
}
