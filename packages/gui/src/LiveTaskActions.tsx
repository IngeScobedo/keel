import {
  allowedTransitions,
  type Lifecycle,
  type PermissionMode,
  RUN_START_RULES,
  type RunPurpose,
} from "@keel/core"
import { ArrowRight, Play, Square } from "lucide-react"
import { useState } from "react"
import { mutationMeta } from "./client.js"
import type { Run, WorkItem } from "./model.js"
import { Button, Hint } from "./ui.js"
import type { useWorkspace } from "./useWorkspace.js"

type Call = ReturnType<typeof useWorkspace>["call"]
const TERMINAL = new Set(["completed", "failed", "cancelled", "interrupted"])
const MODE_LABEL: Record<PermissionMode, string> = {
  ask: "Preguntar",
  accept_edits: "Aceptar ediciones",
  plan: "Sólo lectura",
  bypass: "Bypass (sin permisos)",
}
/** Alias del SDK de Claude; el humano puede escribir un ID completo. */
const MODELS: Record<string, string[]> = {
  claude: ["haiku", "sonnet", "opus"],
  codex: [],
}
const PURPOSE_LABEL: Record<RunPurpose, string> = {
  plan: "Planear",
  triage_eval: "Evaluar triage",
  execute: "Ejecutar",
}

/**
 * Acciones humanas sobre la tarea, con las mismas reglas que aplica el daemon
 * (`@keel/core`): qué transiciones puede pedir un humano y desde qué estado
 * arranca cada run. El daemon vuelve a comprobarlo todo.
 */
export function LiveTaskActions({
  task,
  runs,
  call,
  onRun,
}: {
  task: WorkItem
  runs: Run[]
  call: Call
  onRun: (run: Run) => void
}) {
  const lifecycle = task.lifecycle as Lifecycle
  const purposes = (Object.keys(RUN_START_RULES) as RunPurpose[]).filter(
    (p) => RUN_START_RULES[p].from === lifecycle,
  )
  const [purpose, setPurpose] = useState<RunPurpose | "">(purposes[0] ?? "")
  const [profile, setProfile] = useState("claude")
  const [prompt, setPrompt] = useState("")
  const [mode, setMode] = useState<PermissionMode>("ask")
  const [model, setModel] = useState("")
  const [turns, setTurns] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const active = runs.filter((r) => !TERMINAL.has(r.status))
  const chosen = purposes.includes(purpose as RunPurpose) ? purpose : (purposes[0] ?? "")
  // Lo mismo que valida el daemon: sólo `execute` trabaja en un worktree.
  const modes: PermissionMode[] =
    chosen === "execute" ? ["ask", "accept_edits", "plan", "bypass"] : ["ask", "plan"]
  const chosenMode = modes.includes(mode) ? mode : "ask"

  async function act(work: () => Promise<unknown>) {
    if (busy) return
    setBusy(true)
    setError("")
    try {
      await work()
    } catch (e) {
      setError(e instanceof Error ? e.message : "El daemon rechazó la acción")
    } finally {
      setBusy(false)
    }
  }
  return (
    <section className="live-actions">
      <h3>Acciones</h3>
      {allowedTransitions(lifecycle, "human").map((to) => (
        <Button
          key={to}
          icon={ArrowRight}
          disabled={busy}
          onClick={() =>
            void act(() =>
              call("work_items.transition", {
                ...mutationMeta(task.revision),
                work_item_id: task.id,
                to,
              }),
            )
          }
        >
          Mover a {to}
        </Button>
      ))}
      {chosen ? (
        <form
          onSubmit={(e) => {
            e.preventDefault()
            void act(async () => {
              const run = await call("runs.start", {
                ...mutationMeta(),
                work_item_id: task.id,
                purpose: chosen,
                profile,
                ...(prompt.trim() ? { prompt: prompt.trim() } : {}),
                options: {
                  permission_mode: chosenMode,
                  ...(model.trim() ? { model: model.trim() } : {}),
                  ...(turns && profile === "claude" ? { max_turns: Number(turns) } : {}),
                },
              })
              setPrompt("")
              onRun(run)
            })
          }}
        >
          <label>
            Run
            <select
              aria-label="Propósito del run"
              value={chosen}
              onChange={(e) => setPurpose(e.target.value as RunPurpose)}
            >
              {purposes.map((p) => (
                <option key={p} value={p}>
                  {PURPOSE_LABEL[p]}
                </option>
              ))}
            </select>
          </label>
          <label>
            Agente
            <select
              aria-label="Proveedor"
              value={profile}
              onChange={(e) => setProfile(e.target.value)}
            >
              <option value="claude">Claude</option>
              <option value="codex">Codex</option>
            </select>
          </label>
          <label>
            Permisos
            <select
              aria-label="Modo de permisos"
              value={chosenMode}
              onChange={(e) => setMode(e.target.value as PermissionMode)}
            >
              {modes.map((m) => (
                <option key={m} value={m}>
                  {MODE_LABEL[m]}
                </option>
              ))}
            </select>
          </label>
          {chosenMode === "bypass" && (
            <p className="deleted" role="alert">
              El agente actuará sin pedirte permiso dentro de su worktree. Keel lo registra, pero no
              lo detiene.
            </p>
          )}
          <label>
            Modelo
            <input
              aria-label="Modelo"
              list={`models-${profile}`}
              placeholder="del perfil"
              value={model}
              onChange={(e) => setModel(e.target.value)}
            />
            <datalist id={`models-${profile}`}>
              {(MODELS[profile] ?? []).map((m) => (
                <option key={m} value={m} />
              ))}
            </datalist>
          </label>
          {profile === "claude" && (
            <label>
              Turnos máx.
              <input
                aria-label="Turnos máximos"
                type="number"
                min={1}
                max={500}
                placeholder="12"
                value={turns}
                onChange={(e) => setTurns(e.target.value)}
              />
            </label>
          )}
          <textarea
            aria-label="Instrucción para el agente"
            rows={3}
            placeholder="Instrucción opcional; si no, usa la especificación"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
          />
          <button className="button primary" type="submit" disabled={busy || active.length > 0}>
            <Play size={13} />
            {PURPOSE_LABEL[chosen]}
          </button>
        </form>
      ) : (
        <Hint>Desde {lifecycle} no arranca ningún run.</Hint>
      )}
      {active.map((r) => (
        <Button
          key={r.id}
          variant="danger"
          icon={Square}
          disabled={busy}
          onClick={() => void act(() => call("runs.cancel", { ...mutationMeta(), run_id: r.id }))}
        >
          Cancelar run {r.purpose}
        </Button>
      ))}
      {error && (
        <p className="deleted" role="alert">
          {error}
        </p>
      )}
    </section>
  )
}
