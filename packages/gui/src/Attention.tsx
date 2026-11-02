/**
 * Avisos que se atienden donde estás (ADR-0034 §6): cuando algo pide al humano en
 * cualquier proyecto abierto en el daemon, aparece un aviso. Lo simple se responde ahí
 * mismo; lo que necesita contexto tiene «Ver», que lleva a la tarea (cambiando de
 * proyecto si hace falta) y «atrás» regresa a donde estabas.
 */
import { type Methods, shellCommand } from "@keel/core"
import { useEffect, useRef, useState } from "react"
import { isVisibleTask, onVisibleTasks } from "./attention-scope.js"
import { inputLine, optionLabel, questionsOf } from "./chat-model.js"
import { mutationMeta } from "./client.js"
import type { Place } from "./nav.js"
import { useToasts } from "./ui/index.js"
import type { useWorkspace } from "./useWorkspace.js"

type Workspace = ReturnType<typeof useWorkspace>
export type Pending = ReturnType<
  (typeof Methods)["approvals.list"]["result"]["parse"]
>["approvals"][number]

const NEEDS_CONTEXT = new Set([
  "git.plan",
  "stage.gate",
  "setup.request",
  "batch.plan",
  "github.pr_merge",
  "delivery.promote",
])

/** Qué se le puede contestar desde el aviso: aprobar/negar, una opción o sólo «Ver». */
export function quickReply(
  a: Pending,
):
  | { kind: "approve" }
  | { kind: "options"; question: string; options: string[] }
  | { kind: "view" } {
  const op = (a.operation ?? {}) as { tool?: string; input?: unknown }
  const tool = op.tool ?? ""
  if (NEEDS_CONTEXT.has(tool)) return { kind: "view" }
  if (tool === "ExitPlanMode") return { kind: "view" }
  if (tool === "AskUserQuestion") {
    const qs = questionsOf(op.input)
    const q = qs[0]
    if (qs.length !== 1 || !q || q.multiSelect || q.options.length === 0) return { kind: "view" }
    return { kind: "options", question: q.question, options: q.options.map((o) => o.label) }
  }
  // Lo destructivo en producción se aprueba escribiendo el nombre: eso pide la tarjeta.
  const input = (op.input ?? {}) as { confirm_name?: unknown; risk?: { class?: string } }
  if (input.confirm_name || input.risk?.class === "destructive") return { kind: "view" }
  return { kind: "approve" }
}

function summary(a: Pending): string {
  const op = (a.operation ?? {}) as { tool?: string; input?: unknown }
  const tool = op.tool ?? "?"
  if (tool === "git.plan") return "Propone un plan de git"
  if (tool === "stage.gate") return "Espera tu gate del método"
  if (tool === "batch.plan") return "El orquestador propone un lote: revísalo antes de arrancar"
  if (tool === "delivery.promote") {
    const i = (op.input ?? {}) as { from?: string; to?: string }
    return `Pide promover ${i.from ?? ""} → ${i.to ?? ""}`
  }
  if (tool === "github.pr_merge")
    return `Pide mergear la PR #${(op.input as { number?: number } | null)?.number ?? ""}`
  if (tool === "AskUserQuestion")
    return questionsOf(op.input)[0]?.question ?? "Te hace una pregunta"
  const cmd = shellCommand(op.input)
  return cmd ? `${tool}: ${cmd}` : `${tool} ${inputLine(op.input)}`
}

function Reply({
  a,
  call,
  onOpen,
  onDone,
}: {
  a: Pending
  call: Workspace["call"]
  onOpen: (a: Pending) => void
  onDone: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const reply = quickReply(a)
  const resolve = async (extra: Record<string, unknown>) => {
    setBusy(true)
    setError("")
    try {
      await call("approvals.resolve", {
        ...mutationMeta(),
        approval_id: a.id,
        operation_hash: a.operation_hash,
        ...extra,
      } as never)
      onDone()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setBusy(false)
    }
  }
  return (
    <div className="attention" data-testid="attention">
      <p className="attention-what">{summary(a)}</p>
      <div className="attention-actions">
        {reply.kind === "approve" && (
          <>
            <button
              type="button"
              className="button primary"
              disabled={busy}
              onClick={() => void resolve({ decision: "approve_once" })}
            >
              Aprobar
            </button>
            <button
              type="button"
              className="button danger"
              disabled={busy}
              onClick={() => void resolve({ decision: "deny" })}
            >
              Negar
            </button>
          </>
        )}
        {reply.kind === "options" &&
          reply.options.map((o) => (
            <button
              type="button"
              key={o}
              className="button"
              disabled={busy}
              onClick={() =>
                void resolve({ decision: "approve_once", answers: { [reply.question]: o } })
              }
            >
              {optionLabel(o).text}
            </button>
          ))}
        <button type="button" className="button ghost" onClick={() => onOpen(a)}>
          Ver
        </button>
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </div>
  )
}

/** Varias cosas te esperan: una fila por cada una, con «Ver»; nada se apila. */
function Group({ items, onOpen }: { items: Pending[]; onOpen: (a: Pending) => void }) {
  const shown = items.slice(0, 4)
  return (
    <ul className="attention-group" data-testid="attention-group">
      {shown.map((a) => (
        <li key={a.id}>
          <span className="mono muted">{a.work_item_display_id}</span>
          <span className="attention-group-text">
            <strong>{a.work_item_title}</strong>
            <span className="muted">{summary(a)}</span>
          </span>
          <button type="button" className="button ghost" onClick={() => onOpen(a)}>
            Ver
          </button>
        </li>
      ))}
      {items.length > shown.length && (
        <li className="muted">y {items.length - shown.length} más en la bandeja</li>
      )}
    </ul>
  )
}

/**
 * Escucha lo pendiente de todos los proyectos y avisa de lo nuevo en un solo aviso que
 * se actualiza (canvas GUI · 04: las aprobaciones se señalan con estado y contador, sin
 * robar el foco). Lo que ya está a la vista (la tarea abierta, el lote en vivo) no avisa.
 */
export function Attention({
  workspace,
  place,
  onOpen,
}: {
  workspace: Workspace
  place: Place
  onOpen: (a: Pending) => void
}) {
  const toasts = useToasts()
  const seen = useRef<Set<string> | null>(null)
  /** Lo que el aviso muestra ahora, por aprobación. */
  const items = useRef(new Map<string, Pending>())
  const toastId = useRef<string | null>(null)
  const live = workspace.mode === "live"
  const { call, attentionTick, inboxTick } = workspace
  const here = useRef(place)
  here.current = place
  const open = useRef(onOpen)
  open.current = onOpen
  const visible = (a: Pending) =>
    (here.current.page === "task" && here.current.task === a.work_item_id) ||
    isVisibleTask(a.work_item_id) ||
    (here.current.page === "conversation" &&
      (a.operation as { tool?: string } | null)?.tool === "batch.plan")
  /** El aviso refleja `items`: uno solo, que se crea, se actualiza o se cierra. */
  const sync = useRef(() => {})
  sync.current = () => {
    const list = [...items.current.values()]
    if (list.length === 0) {
      if (toastId.current) toasts.close(toastId.current)
      toastId.current = null
      return
    }
    const one = list.length === 1 ? (list[0] as Pending) : null
    const drop = (id: string) => {
      items.current.delete(id)
      sync.current()
    }
    const content = {
      title: one
        ? `${one.project_name} · ${one.work_item_display_id}`
        : `Te esperan ${list.length}`,
      description: one ? one.work_item_title : "",
      data: {
        tone: "attention" as const,
        render: () =>
          one ? (
            <Reply
              a={one}
              call={call}
              onOpen={(x) => {
                drop(x.id)
                open.current(x)
              }}
              onDone={() => drop(one.id)}
            />
          ) : (
            <Group
              items={list}
              onOpen={(x) => {
                drop(x.id)
                open.current(x)
              }}
            />
          ),
      },
    }
    if (toastId.current) toasts.update(toastId.current, content)
    else
      toastId.current = toasts.add({
        ...content,
        // Prioridad normal: Base UI oculta al lector de pantalla los de prioridad alta
        // hasta que tienen foco, y este aviso tiene botones.
        timeout: 0,
        onClose: () => {
          // Cerrarlo es «ya lo vi»: lo que mostraba no vuelve a avisar.
          toastId.current = null
          items.current.clear()
        },
      })
  }
  // biome-ignore lint/correctness/useExhaustiveDependencies: los ticks sólo disparan la relectura.
  useEffect(() => {
    if (!live) return
    let alive = true
    call("approvals.list", { all_projects: true })
      .then(({ approvals }) => {
        if (!alive) return
        const ids = new Set(approvals.map((a) => a.id))
        // Lo que ya no espera (se contestó aquí o en otra ventana) deja de avisar.
        for (const id of [...items.current.keys()]) if (!ids.has(id)) items.current.delete(id)
        // Al conectar no se avisa de lo viejo: para eso está la bandeja.
        if (seen.current === null) {
          seen.current = ids
          return
        }
        for (const a of approvals) {
          if (seen.current.has(a.id)) continue
          seen.current.add(a.id)
          if (!visible(a)) items.current.set(a.id, a)
        }
        sync.current()
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [live, call, attentionTick, inboxTick])
  // Al llegar a la tarea (o al lote donde está), su aviso sobra: lo pendiente ya se ve ahí.
  // biome-ignore lint/correctness/useExhaustiveDependencies: sólo al cambiar lo que está a la vista.
  useEffect(() => {
    const prune = () => {
      let changed = false
      for (const a of [...items.current.values()])
        if (visible(a)) {
          items.current.delete(a.id)
          changed = true
        }
      if (changed) sync.current()
    }
    prune()
    return onVisibleTasks(prune)
  }, [place.page, place.task])
  return null
}
