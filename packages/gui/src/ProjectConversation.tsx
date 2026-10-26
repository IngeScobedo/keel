/**
 * ADR-0024: la conversación del proyecto. Consultas de sólo lectura sin tarea;
 * lo que el agente encuentra nace como tarea con «Trabajar» y «Abrir». El chat es
 * el de ADR-0020: la cadena de runs de una tarea oculta.
 */
import type { EventNotification } from "@keel/core"
import { MessageSquarePlus, Play, Send } from "lucide-react"
import { type FormEvent, useCallback, useEffect, useRef, useState } from "react"
import { mutationMeta } from "./client.js"
import type { Run, WorkItem } from "./model.js"
import { RunView } from "./RunView.js"
import { Button, Hint } from "./ui.js"
import type { useWorkspace } from "./useWorkspace.js"

type Call = ReturnType<typeof useWorkspace>["call"]
type Opened = {
  work_item: WorkItem
  run: Run | null
  born: WorkItem[]
  notes: { id: string; content_markdown: string; created_at: string }[]
}

export function ProjectConversation({
  call,
  runs,
  events,
  projectName,
  question,
  onQuestionSent,
  onOpenTask,
  onBack,
}: {
  call: Call
  runs: Run[]
  events: EventNotification[]
  projectName: string
  /** Lo que se preguntó desde ⌘K: se manda al abrir. */
  question?: string
  onQuestionSent?: () => void
  onOpenTask: (id: string) => void
  onBack: () => void
}) {
  const [opened, setOpened] = useState<Opened | null>(null)
  const [runId, setRunId] = useState<string | null>(null)
  const [asked, setAsked] = useState<Run | null>(null)
  const [fresh, setFresh] = useState(false)
  const [text, setText] = useState("")
  const [error, setError] = useState("")
  const [sending, setSending] = useState(false)
  // Lo que nace en la conversación llega como evento: se recarga la lista.
  const created = events.filter((e) => e.kind === "work_item.created" || e.kind === "note.added")
  const createdCount = created.length
  const load = useCallback(async () => {
    try {
      const r = (await call("conversation.open", {})) as Opened
      setOpened(r)
      setRunId((cur) => cur ?? r.run?.id ?? null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [call])
  useEffect(() => {
    void createdCount
    void load()
  }, [load, createdCount])

  const ask = useCallback(
    async (q: string, isFresh: boolean) => {
      if (!q.trim()) return
      setSending(true)
      setError("")
      try {
        const r = (await call("conversation.ask", {
          ...mutationMeta(),
          text: q.trim(),
          ...(isFresh ? { fresh: true } : {}),
        })) as { run: Run }
        setAsked(r.run)
        setRunId(r.run.id)
        setFresh(false)
        setText("")
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
      } finally {
        setSending(false)
      }
    },
    [call],
  )
  // ⌘K «preguntar al proyecto…»: se manda una sola vez.
  const sent = useRef<string | null>(null)
  useEffect(() => {
    if (!question || sent.current === question) return
    sent.current = question
    void ask(question, false).then(() => onQuestionSent?.())
  }, [question, ask, onQuestionSent])

  const run = runs.find((r) => r.id === runId) ?? (asked?.id === runId ? asked : null)
  const onRun = useCallback((r: Run) => setRunId(r.id), [])
  const empty = fresh || !run

  async function work(id: string) {
    try {
      await call("tasks.work", { ...mutationMeta(), work_item_id: id })
      onOpenTask(id)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <div className="page conv-page" data-testid="project-conversation">
      <header className="conv-head">
        <h1>Conversación del proyecto</h1>
        <span className="mono muted">{projectName}</span>
        <span className="mode-badge plan" title="El agente no edita nada aquí">
          sólo lectura
        </span>
        <div className="toolbar-spacer" />
        <Button
          icon={MessageSquarePlus}
          onClick={() => {
            setFresh(true)
            setText("")
          }}
          disabled={fresh}
        >
          Nueva conversación
        </Button>
      </header>
      {error && (
        <p className="error-banner" role="alert">
          {error}
        </p>
      )}
      <div className="conv-body">
        <div className="conv-chat">
          {empty ? (
            <div className="conv-empty">
              <Hint>
                {fresh
                  ? "Una conversación nueva no arrastra la sesión anterior."
                  : "Pregunta sobre el código. Si el agente encuentra algo que hacer, lo crea como tarea."}
              </Hint>
              <form
                onSubmit={(e: FormEvent) => {
                  e.preventDefault()
                  void ask(text, fresh)
                }}
              >
                <textarea
                  aria-label="Pregunta al proyecto"
                  placeholder="Pregunta al proyecto…"
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault()
                      void ask(text, fresh)
                    }
                  }}
                />
                <div className="modal-actions">
                  {fresh && run && <Button onClick={() => setFresh(false)}>Volver</Button>}
                  <button
                    className="button primary"
                    type="submit"
                    disabled={!text.trim() || sending}
                  >
                    <Send size={13} /> Preguntar
                  </button>
                </div>
              </form>
            </div>
          ) : (
            <RunView
              key={run.id}
              run={run}
              {...(opened ? { task: opened.work_item } : {})}
              demo={false}
              events={events}
              onBack={onBack}
              onTask={() => {}}
              call={call}
              runs={runs}
              onRun={onRun}
              onOpenTask={onOpenTask}
            />
          )}
        </div>
        <aside className="conv-side" aria-label="Lo que nació aquí">
          <h3>Nacieron aquí</h3>
          {(opened?.born ?? []).length === 0 && <Hint>Aún ninguna tarea.</Hint>}
          {(opened?.born ?? []).map((w) => (
            <div key={w.id} className="conv-born" data-testid="conv-born">
              <span>
                <span className="mono muted">{w.display_id}</span> {w.title}
              </span>
              <span className="conv-born-actions">
                {w.priority && w.priority !== "medium" && (
                  <span className={`rc-pill priority-${w.priority}`}>{w.priority}</span>
                )}
                <span className="rc-pill">{w.stage ?? w.lifecycle}</span>
              </span>
              <span className="conv-born-actions">
                {!w.stage && (
                  <Button icon={Play} onClick={() => void work(w.id)}>
                    Trabajar
                  </Button>
                )}
                <Button onClick={() => onOpenTask(w.id)}>Abrir</Button>
              </span>
            </div>
          ))}
          <h3>Notas</h3>
          {(opened?.notes ?? []).length === 0 && <Hint>Lo que valga guardar queda aquí.</Hint>}
          {(opened?.notes ?? []).map((n) => (
            <p key={n.id} className="muted conv-note">
              {n.content_markdown.split("\n")[0]}
            </p>
          ))}
        </aside>
      </div>
    </div>
  )
}
