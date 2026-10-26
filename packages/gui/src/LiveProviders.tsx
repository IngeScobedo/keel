import type { SettingsView } from "@keel/core"
import { Bot } from "lucide-react"
import { useCallback, useEffect, useState } from "react"
import { mutationMeta } from "./client.js"
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
        <select
          aria-label="Límite para contestar una aprobación"
          value={String(view?.approvals.timeout_ms ?? "")}
          disabled={!view}
          onChange={(e) =>
            void update({ approvals_timeout_ms: e.target.value ? Number(e.target.value) : null })
          }
        >
          <option value="">Sin límite</option>
          {[5, 30, 120].map((min) => (
            <option key={min} value={min * 60_000}>
              {min < 60 ? `${min} min` : `${min / 60} h`}
            </option>
          ))}
        </select>
        <p className="muted">
          Sin límite, el run espera con su lugar de concurrencia tomado. Con límite, al vencer se
          niega: el tiempo nunca aprueba. Las preguntas del agente nunca vencen.
        </p>
      </label>
    </section>
  )
}
