import type { Effort, ModelOption, PermissionMode } from "@keel/core"
import {
  ArrowRight,
  ArrowUp,
  Check,
  ChevronDown,
  Eye,
  FilePen,
  Paperclip,
  Shield,
  ShieldOff,
} from "lucide-react"
import { createContext, type ReactNode, useContext, useEffect, useRef, useState } from "react"
import { EFFORT_LABEL, modelLabel } from "./chat-model.js"
import type { useWorkspace } from "./useWorkspace.js"

type Call = ReturnType<typeof useWorkspace>["call"]

export const MODES: { id: PermissionMode; label: string; hint: string; icon: ReactNode }[] = [
  {
    id: "ask",
    label: "Preguntar",
    hint: "Pide permiso para comandos y ediciones",
    icon: <Shield size={14} />,
  },
  {
    id: "accept_edits",
    label: "Aceptar ediciones",
    hint: "Edita sin preguntar; los comandos siguen pidiendo permiso",
    icon: <FilePen size={14} />,
  },
  {
    id: "plan",
    label: "Sólo planear",
    hint: "Lee y propone; no cambia nada",
    icon: <Eye size={14} />,
  },
  {
    id: "bypass",
    label: "Bypass",
    hint: "Nada pide permiso. Sigue en su worktree y su sandbox.",
    icon: <ShieldOff size={14} />,
  },
]
const CYCLE: PermissionMode[] = ["ask", "accept_edits", "plan"]

/** Los modelos se preguntan una vez por ventana: no cambian mientras el daemon vive. */
const modelsCache = new Map<string, Promise<ModelOption[]>>()
function useModels(call: Call | undefined, provider: "claude" | "codex", open: boolean) {
  const [models, setModels] = useState<ModelOption[] | null>(null)
  useEffect(() => {
    if (!call || !open) return
    let p = modelsCache.get(provider)
    if (!p) {
      p = call("providers.models", { provider }).then((r) => r.models)
      p.catch(() => modelsCache.delete(provider))
      modelsCache.set(provider, p)
    }
    let live = true
    p.then((m) => live && setModels(m)).catch(() => live && setModels([]))
    return () => {
      live = false
    }
  }, [call, provider, open])
  return models
}

function Popover({
  open,
  onClose,
  children,
  label,
}: {
  open: boolean
  onClose: () => void
  children: ReactNode
  label: string
}) {
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const click = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) onClose()
    }
    const key = (e: KeyboardEvent) => e.key === "Escape" && onClose()
    // En el siguiente tick: el clic que abrió no debe cerrarlo.
    const t = setTimeout(() => window.addEventListener("mousedown", click))
    window.addEventListener("keydown", key)
    return () => {
      clearTimeout(t)
      window.removeEventListener("mousedown", click)
      window.removeEventListener("keydown", key)
    }
  }, [open, onClose])
  if (!open) return null
  return (
    <div className="rc-popover" ref={box} role="dialog" aria-label={label}>
      {children}
    </div>
  )
}

/** `Opus 5.5 · alto`: abre la lista de modelos de la cuenta y el esfuerzo (ADR-0020 §5). */
export function ModelPill({
  call,
  provider,
  model,
  effort,
  onPick,
  foot,
}: {
  call?: Call
  provider: "claude" | "codex"
  model: string | null
  effort: string | null
  onPick: (model: string, effort: Effort | null) => void
  /** El pie del menú; por omisión, cuándo cambia en un run vivo. */
  foot?: string
}) {
  const [open, setOpen] = useState(false)
  const models = useModels(call, provider, open || !!model)
  const current = models?.find(
    (m) => m.value === model || modelLabel(model ?? "") === m.display_name,
  )
  const [chosen, setChosen] = useState<string | null>(null)
  const selected = models?.find((m) => m.value === (chosen ?? current?.value)) ?? current
  const label = model ? modelLabel(model, models ?? []) : "modelo"
  return (
    <span className="rc-pill-wrap">
      <button
        type="button"
        className={`rc-pill-btn provider-${provider}`}
        aria-label="Modelo y esfuerzo"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="rc-dot" />
        {label}
        {effort ? ` · ${EFFORT_LABEL[effort] ?? effort}` : ""}
        <ChevronDown size={12} />
      </button>
      <Popover open={open} onClose={() => setOpen(false)} label="Modelo">
        <h4>Modelo · los que tu cuenta ofrece</h4>
        {models === null && <p className="muted">Preguntando al proveedor…</p>}
        {models?.length === 0 && <p className="muted">El proveedor no dio la lista.</p>}
        <div className="rc-menu">
          {models?.map((m) => (
            <button
              key={m.value}
              type="button"
              className={`rc-menu-item ${selected?.value === m.value ? "on" : ""}`}
              onClick={() => {
                setChosen(m.value)
                if (m.efforts.length === 0) {
                  onPick(m.value, null)
                  setOpen(false)
                }
              }}
            >
              <span className="rc-dot" />
              <span>
                <strong>{m.display_name}</strong>
                <small>{m.description}</small>
              </span>
              {current?.value === m.value && <Check size={13} />}
            </button>
          ))}
        </div>
        {selected && selected.efforts.length > 0 && (
          <>
            <h4>Esfuerzo</h4>
            <div className="segmented rc-effort">
              {selected.efforts.map((e) => (
                <button
                  key={e}
                  type="button"
                  className="button"
                  aria-pressed={selected.value === current?.value && effort === e}
                  onClick={() => {
                    onPick(selected.value, e)
                    setOpen(false)
                  }}
                >
                  {EFFORT_LABEL[e] ?? e}
                </button>
              ))}
            </div>
          </>
        )}
        <p className="muted rc-pop-foot">
          {foot ??
            `${provider === "codex" ? "Cambia desde el turno siguiente" : "Cambia en el turno en curso"} · queda en el registro del run`}
        </p>
      </Popover>
    </span>
  )
}

/** El modo del run, cambiable en vivo; bypass pide confirmación (ADR-0020 §4). */
export function ModePill({
  mode,
  onPick,
  disabled,
}: {
  mode: PermissionMode
  onPick: (mode: PermissionMode) => void
  disabled?: boolean
}) {
  const [open, setOpen] = useState(false)
  const [confirm, setConfirm] = useState(false)
  const current = MODES.find((m) => m.id === mode) ?? MODES[0]
  return (
    <span className="rc-pill-wrap">
      <button
        type="button"
        className={`rc-pill-btn mode-${mode}`}
        aria-label="Modo del run"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => {
          setOpen((v) => !v)
          setConfirm(false)
        }}
      >
        {current?.icon}
        {current?.label}
        <ChevronDown size={12} />
      </button>
      <Popover open={open} onClose={() => setOpen(false)} label="Modo del run">
        <h4>Modo del run · cambia en vivo</h4>
        <div className="rc-menu">
          {MODES.map((m) => (
            <button
              key={m.id}
              type="button"
              className={`rc-menu-item ${m.id === "bypass" ? "danger" : ""} ${m.id === mode ? "on" : ""}`}
              onClick={() => {
                if (m.id === mode) return setOpen(false)
                if (m.id === "bypass") return setConfirm(true)
                onPick(m.id)
                setOpen(false)
              }}
            >
              {m.icon}
              <span>
                <strong>{m.label}</strong>
                <small>{m.hint}</small>
              </span>
              {m.id === mode && <Check size={13} />}
              {m.id === "ask" && <kbd>⇧⇥</kbd>}
            </button>
          ))}
        </div>
        {confirm && (
          <div className="rc-confirm">
            <span>¿Pasar a bypass a mitad del run?</span>
            <button
              type="button"
              className="button danger"
              onClick={() => {
                onPick("bypass")
                setOpen(false)
              }}
            >
              Sí, bypass
            </button>
          </div>
        )}
      </Popover>
    </span>
  )
}

/**
 * El compositor: la sugerencia de Claude como texto fantasma que → o Tab
 * aceptan (ADR-0020 §6), modelo y modo a la vista, ⇧⇥ cambia de modo.
 */
/**
 * Lo que la conversación del proyecto le suma al composer (ADR-0035, ADR-0040): adjuntar
 * archivos, los adjuntos pendientes que viajan con el mensaje y los chips en vivo.
 */
export type ComposerExtras = {
  /** Lo que se agrega al texto al enviar: la referencia a las fuentes adjuntas. */
  suffix: () => string
  onSent: () => void
  /** Debajo del texto, mientras escribes. */
  preview: (draft: string) => ReactNode
  attach: (files: File[]) => void
  pending: ReactNode
}
export const ComposerExtrasContext = createContext<ComposerExtras | null>(null)

export function Composer({
  running,
  disabled,
  sending,
  suggestion,
  onSend,
  pills,
  mode,
  onMode,
}: {
  running: boolean
  disabled: boolean
  sending: boolean
  suggestion: string | null
  onSend: (text: string) => Promise<boolean>
  pills: ReactNode
  mode: PermissionMode
  onMode: (mode: PermissionMode) => void
}) {
  const [draft, setDraft] = useState("")
  const extras = useContext(ComposerExtrasContext)
  const fileInput = useRef<HTMLInputElement>(null)
  const ghost = !draft && suggestion ? suggestion : null
  async function send() {
    const text = draft.trim()
    if (!text || sending) return
    if (await onSend(text)) setDraft("")
  }
  return (
    <form
      className="rc-composer"
      onSubmit={(e) => {
        e.preventDefault()
        void send()
      }}
    >
      <div className="rc-input">
        <textarea
          aria-label="Mensaje al agente"
          rows={2}
          disabled={disabled || sending}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (ghost && (e.key === "ArrowRight" || e.key === "Tab") && !e.shiftKey) {
              e.preventDefault()
              setDraft(ghost)
            } else if (e.key === "Tab" && e.shiftKey) {
              e.preventDefault()
              const i = CYCLE.indexOf(mode)
              onMode(CYCLE[(i + 1) % CYCLE.length] as PermissionMode)
            } else if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault()
              void send()
            }
          }}
          placeholder={
            ghost ??
            (disabled
              ? "Conecta el daemon para escribirle al agente."
              : running
                ? "Escríbele mientras trabaja"
                : "El run terminó: escribe para continuar la conversación")
          }
        />
        {extras && draft.trim() && <div className="rc-preview">{extras.preview(draft)}</div>}
        {ghost && (
          <span className="rc-ghost-hint" aria-hidden="true">
            <kbd>
              <ArrowRight size={11} />
            </kbd>{" "}
            para aceptar
          </span>
        )}
      </div>
      {extras?.pending}
      <div className="rc-composer-bar">
        {extras && (
          <>
            <button
              type="button"
              className="ui-icon-button"
              aria-label="Adjuntar archivo"
              title="Adjuntar archivo (.md, .txt, .docx, .pdf)"
              onClick={() => fileInput.current?.click()}
            >
              <Paperclip size={15} aria-hidden />
            </button>
            <input
              ref={fileInput}
              type="file"
              hidden
              multiple
              accept=".md,.markdown,.txt,.csv,.json,.docx,.pdf"
              aria-label="Archivo a adjuntar"
              onChange={(e) => {
                extras.attach([...(e.target.files ?? [])])
                e.target.value = ""
              }}
            />
          </>
        )}
        {pills}
        <span className="muted rc-keys">
          Enter envía{running ? " al turno en curso" : ""} · ⇧Enter salto · ⇧⇥ modo
        </span>
        <button
          type="submit"
          className="rc-send"
          aria-label={running ? "Enviar" : "Continuar"}
          title={running ? "Enviar" : "Continuar"}
          disabled={disabled || sending || !draft.trim()}
        >
          <ArrowUp size={16} />
        </button>
      </div>
    </form>
  )
}
