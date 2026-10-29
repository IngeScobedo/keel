import type { Effort, SettingsView } from "@keel/core"
import { Bot } from "lucide-react"
import { useCallback, useEffect, useState } from "react"
import { ModelPill } from "./Composer.js"
import { mutationMeta } from "./client.js"
import { Select } from "./ui/index.js"
import { Hint } from "./ui.js"
import type { useWorkspace } from "./useWorkspace.js"

type Call = ReturnType<typeof useWorkspace>["call"]

/**
 * Codex con la sesión de ChatGPT del usuario (ADR-0008 §2): una opción explícita
 * suya, guardada en el daemon con su autor. Keel no hace el login.
 */
export function LiveProviders({ call }: { call: Call }) {
  const [view, setView] = useState<SettingsView | null>(null)
  const [error, setError] = useState("")
  const refresh = useCallback(async () => {
    try {
      setView(await call("settings.get", {}))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [call])
  useEffect(() => {
    void refresh()
  }, [refresh])
  async function toggle(enabled: boolean) {
    setError("")
    try {
      setView(await call("settings.codex_subscription_set", { ...mutationMeta(), enabled }))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }
  async function update(patch: {
    approvals_timeout_ms?: number | null
    prompt_suggestions?: boolean
    default_model?: { provider: "claude" | "codex"; model: string | null; effort?: Effort | null }
    limits?: {
      run_budget_usd?: number | null
      daily_budget_usd?: number | null
      max_concurrent_runs?: number
    }
  }) {
    setError("")
    try {
      setView(await call("settings.update", { ...mutationMeta(), ...patch }))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }
  const sub = view?.codex_subscription
  return (
    <section className="plugins">
      <h2>
        <Bot size={15} /> Proveedores
      </h2>
      {error && <p className="deleted">{error}</p>}
      <label className="connection">
        <input
          type="checkbox"
          aria-label="Usar Codex con mi suscripción de ChatGPT"
          checked={sub?.enabled ?? false}
          disabled={!sub || sub.source === "flag"}
          onChange={(e) => void toggle(e.target.checked)}
        />{" "}
        <strong>Usar Codex con mi suscripción de ChatGPT</strong>
        <p className="muted">
          {sub?.source === "flag"
            ? "Encendido al arrancar el daemon con --codex-subscription."
            : sub?.updated_by
              ? `${sub.enabled ? "Encendido" : "Apagado"} por ${sub.updated_by} · ${sub.updated_at}`
              : "Apagado: los runs de Codex fallan antes de lanzarse."}
        </p>
      </label>
      <Hint>
        Sólo para uso local con tu propia cuenta. El login lo haces tú en una terminal con{" "}
        <code>codex login</code>; Keel no lee ni guarda tus credenciales.
      </Hint>
      <label className="connection">
        <input
          type="checkbox"
          aria-label="Sugerencias de mensaje de Claude"
          checked={view?.prompt_suggestions.enabled ?? false}
          disabled={!view}
          onChange={(e) => void update({ prompt_suggestions: e.target.checked })}
        />{" "}
        <strong>Sugerencias de mensaje de Claude</strong>
        <p className="muted">
          Tras cada turno Claude propone tu siguiente mensaje; → lo acepta. Cuesta tokens de tu
          suscripción. Aplica a los runs que arranquen después.
        </p>
      </label>
      <label className="connection">
        <strong>Límite para contestar una aprobación</strong>{" "}
        <Select
          aria-label="Límite para contestar una aprobación"
          value={String(view?.approvals.timeout_ms ?? "")}
          disabled={!view}
          onChange={(v) => void update({ approvals_timeout_ms: v ? Number(v) : null })}
          options={[
            { value: "", label: "Sin límite" },
            ...[5, 30, 120].map((min) => ({
              value: String(min * 60_000),
              label: min < 60 ? `${min} min` : `${min / 60} h`,
            })),
          ]}
        />
        <p className="muted">
          Sin límite, el run espera con su lugar de concurrencia tomado. Con límite, al vencer se
          niega: el tiempo nunca aprueba. Las preguntas del agente nunca vencen.
        </p>
      </label>
      {view?.default_models && (
        <div className="connection" data-testid="default-models">
          <strong>Modelo al empezar una tarea</strong>
          <div className="limits-row">
            {(["claude", "codex"] as const).map((p) => {
              const d = view.default_models?.[p]
              return (
                <span key={p} className="default-model">
                  {p === "claude" ? "Claude" : "Codex"}
                  <ModelPill
                    call={call}
                    provider={p}
                    model={d?.model ?? null}
                    effort={d?.effort ?? null}
                    onPick={(model, effort) =>
                      void update({ default_model: { provider: p, model, effort } })
                    }
                    foot="Para las tareas nuevas · en una tarea se cambia desde su chat"
                  />
                  {d?.source === "setting" && (
                    <button
                      type="button"
                      className="button ghost"
                      onClick={() => void update({ default_model: { provider: p, model: null } })}
                    >
                      Restablecer
                    </button>
                  )}
                </span>
              )
            })}
          </div>
          <p className="muted">
            {view.default_models.claude.source === "setting" ||
            view.default_models.codex.source === "setting"
              ? `Los eligió ${view.default_models.updated_by} · ${view.default_models.updated_at}. `
              : `Sin elegir, Claude empieza con el del perfil (${view.default_models.claude.model ?? "—"}), bajo a propósito (ADR-0002). `}
            Al pulsar «Trabajar» puedes elegir otro para esa tarea; sus runs siguientes heredan el
            modelo.
          </p>
        </div>
      )}
      {view?.limits && <Limits limits={view.limits} onSave={(limits) => void update({ limits })} />}
    </section>
  )
}

/**
 * ADR-0002 regla 3: presupuesto estimado y concurrencia, con defaults bajos. Subirlos, o
 * quitar un tope de presupuesto, es esta acción del humano y queda a la vista; con la
 * suscripción, el costo es una estimación a precio de lista.
 */
function Limits({
  limits,
  onSave,
}: {
  limits: {
    run_budget_usd: number | null
    daily_budget_usd: number | null
    max_concurrent_runs: number
    source: "default" | "setting" | "flag"
    updated_by: string | null
    updated_at: string | null
  }
  onSave: (l: {
    run_budget_usd: number | null
    daily_budget_usd: number | null
    max_concurrent_runs: number
  }) => void
}) {
  const [run, setRun] = useState(String(limits.run_budget_usd ?? 2))
  const [runOff, setRunOff] = useState(limits.run_budget_usd === null)
  const [day, setDay] = useState(String(limits.daily_budget_usd ?? 10))
  const [dayOff, setDayOff] = useState(limits.daily_budget_usd === null)
  const [conc, setConc] = useState(String(limits.max_concurrent_runs))
  const flag = limits.source === "flag"
  return (
    <form
      className="connection limits-form"
      data-testid="limits"
      onSubmit={(e) => {
        e.preventDefault()
        onSave({
          run_budget_usd: runOff ? null : Number(run),
          daily_budget_usd: dayOff ? null : Number(day),
          max_concurrent_runs: Number(conc),
        })
      }}
    >
      <strong>Presupuesto y concurrencia</strong>
      <div className="limits-row">
        <Budget
          label="Por run (USD estimado)"
          aria="Presupuesto por run"
          min={0.1}
          max={1000}
          value={run}
          off={runOff}
          disabled={flag}
          onValue={setRun}
          onOff={setRunOff}
        />
        <Budget
          label="Por día (USD estimado)"
          aria="Presupuesto por día"
          min={1}
          max={10000}
          value={day}
          off={dayOff}
          disabled={flag}
          onValue={setDay}
          onOff={setDayOff}
        />
        <label>
          Runs a la vez
          <input
            aria-label="Runs a la vez"
            type="number"
            min={1}
            max={8}
            step={1}
            value={conc}
            disabled={flag}
            onChange={(e) => setConc(e.target.value)}
          />
        </label>
        <button type="submit" className="button" disabled={flag}>
          Guardar
        </button>
      </div>
      {(limits.run_budget_usd === null || limits.daily_budget_usd === null) && (
        <p className="limits-off" data-testid="limits-off">
          Sin tope{" "}
          {limits.run_budget_usd === null && limits.daily_budget_usd === null
            ? "por run ni por día"
            : limits.run_budget_usd === null
              ? "por run"
              : "por día"}
          : un run sigue hasta terminar o hasta que lo detengas.
        </p>
      )}
      <p className="muted">
        {flag
          ? "Fijados con flags al arrancar el daemon: mandan sobre este ajuste."
          : limits.source === "setting"
            ? `Los cambió ${limits.updated_by} · ${limits.updated_at}.`
            : "Valores bajos por defecto (ADR-0002): subirlos o quitarlos es decisión tuya."}{" "}
        Con la suscripción el costo es una estimación del SDK a precio de lista, no una factura; al
        agotarse el del día, no arranca otro run hasta mañana o hasta que lo subas.
      </p>
    </form>
  )
}

function Budget(p: {
  label: string
  aria: string
  min: number
  max: number
  value: string
  off: boolean
  disabled: boolean
  onValue: (v: string) => void
  onOff: (off: boolean) => void
}) {
  return (
    <label>
      {p.label}
      <input
        aria-label={p.aria}
        type="number"
        min={p.min}
        max={p.max}
        step="any"
        value={p.value}
        disabled={p.disabled || p.off}
        required={!p.off}
        onChange={(e) => p.onValue(e.target.value)}
      />
      <span className="limits-check">
        <input
          type="checkbox"
          aria-label={`${p.aria}: sin tope`}
          checked={p.off}
          disabled={p.disabled}
          onChange={(e) => p.onOff(e.target.checked)}
        />
        Sin tope
      </span>
    </label>
  )
}
