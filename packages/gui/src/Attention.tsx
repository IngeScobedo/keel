/**
 * Avisos que se atienden donde estás (ADR-0034 §6): cuando algo pide al humano en
 * cualquier proyecto abierto en el daemon, aparece un aviso. Lo simple se responde ahí
 * mismo; lo que necesita contexto tiene «Ver», que lleva a la tarea (cambiando de
 * proyecto si hace falta) y «atrás» regresa a donde estabas.
 */
import { type Methods, shellCommand } from "@keel/core"
import { useEffect, useRef, useState } from "react"
import { inputLine, optionLabel, questionsOf } from "./chat-model.js"
import { mutationMeta } from "./client.js"
import type { Place } from "./nav.js"
import { useToasts } from "./ui/index.js"
import type { useWorkspace } from "./useWorkspace.js"

type Workspace = ReturnType<typeof useWorkspace>
export type Pending = ReturnType<
  (typeof Methods)["approvals.list"]["result"]["parse"]
>["approvals"][number]

const NEEDS_CONTEXT = new Set(["git.plan", "stage.gate", "setup.request"])

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
      <p className="attention-what mono">{summary(a)}</p>
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

/** Escucha lo pendiente de todos los proyectos y avisa de lo nuevo. */
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
  /** Aviso abierto por aprobación: su toast y su tarea. */
  const shown = useRef(new Map<string, { toast: string; task: string }>())
  const live = workspace.mode === "live"
  const { call, attentionTick, inboxTick } = workspace
  const here = useRef(place)
  here.current = place
  const open = useRef(onOpen)
  open.current = onOpen
  // biome-ignore lint/correctness/useExhaustiveDependencies: los ticks sólo disparan la relectura.
  useEffect(() => {
    if (!live) return
    let alive = true
    call("approvals.list", { all_projects: true })
      .then(({ approvals }) => {
        if (!alive) return
        const ids = new Set(approvals.map((a) => a.id))
        // Lo que ya no espera (se contestó aquí o en otra ventana) deja de avisar.
        for (const [id, s] of shown.current)
          if (!ids.has(id)) {
            toasts.close(s.toast)
            shown.current.delete(id)
          }
        // Al conectar no se avisa de lo viejo: para eso está la bandeja.
        if (seen.current === null) {
          seen.current = ids
          return
        }
        for (const a of approvals) {
          if (seen.current.has(a.id)) continue
          seen.current.add(a.id)
          const p = here.current
          // Si ya estás mirando esa tarea, el aviso sobra.
          if (p.page === "task" && p.task === a.work_item_id) continue
          const toastId = toasts.add({
            title: `${a.project_name} · ${a.work_item_display_id}`,
            description: a.work_item_title,
            // Prioridad normal: Base UI oculta al lector de pantalla los de prioridad alta
            // hasta que tienen foco, y este aviso tiene botones.
            timeout: 0,
            data: {
              tone: "attention",
              render: () => (
                <Reply
                  a={a}
                  call={call}
                  onOpen={(x) => {
                    toasts.close(toastId)
                    open.current(x)
                  }}
                  onDone={() => toasts.close(toastId)}
                />
              ),
            },
          })
          shown.current.set(a.id, { toast: toastId, task: a.work_item_id })
        }
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [live, call, attentionTick, inboxTick])
  // Al llegar a la tarea del aviso, el aviso sobra: lo pendiente ya se ve ahí.
  // biome-ignore lint/correctness/useExhaustiveDependencies: sólo al cambiar de lugar.
  useEffect(() => {
    if (place.page !== "task") return
    for (const [id, s] of shown.current)
      if (s.task === place.task) {
        toasts.close(s.toast)
        shown.current.delete(id)
      }
  }, [place.page, place.task])
  return null
}
