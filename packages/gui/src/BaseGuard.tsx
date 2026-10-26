/**
 * ADR-0028: antes de abrir un worktree nuevo, Keel consulta el remoto de la rama del
 * proyecto. Si va atrás, lo dice y ofrece actualizar (sólo avanzando) o trabajar igual.
 */
import type { BaseStateSchema } from "@keel/core"
import { type ReactNode, useState } from "react"
import { mutationMeta } from "./client.js"
import { Button, Hint, Modal } from "./ui.js"
import type { useWorkspace } from "./useWorkspace.js"

type Call = ReturnType<typeof useWorkspace>["call"]
type Base = ReturnType<typeof BaseStateSchema.parse>

export function useBaseGuard(call: Call, onPulled?: () => void) {
  const [checking, setChecking] = useState(false)
  const [pending, setPending] = useState<{ base: Base; go: () => Promise<void> } | null>(null)
  const [pulling, setPulling] = useState(false)
  const [error, setError] = useState("")
  async function guard(go: () => Promise<void>) {
    setChecking(true)
    setError("")
    let base: Base | null = null
    try {
      base = await call("projects.base_check", {})
    } catch {
      base = null
    } finally {
      setChecking(false)
    }
    // Sin remoto no hay contra qué comparar: se trabaja sin preguntar.
    if (base?.upstream && (base.behind > 0 || base.error)) setPending({ base, go })
    else await go()
  }
  async function pullAndGo() {
    if (!pending) return
    setPulling(true)
    setError("")
    try {
      await call("projects.pull", { ...mutationMeta() })
      onPulled?.()
      const go = pending.go
      setPending(null)
      await go()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setPulling(false)
    }
  }
  const b = pending?.base
  const modal: ReactNode = pending && b && (
    <Modal
      title={
        b.error
          ? "No pude consultar el remoto"
          : `${b.branch} está ${b.behind} commit${b.behind === 1 ? "" : "s"} atrás de ${b.upstream}`
      }
      onClose={() => setPending(null)}
    >
      <div className="base-guard" data-testid="base-guard">
        {b.error ? (
          <p className="muted">{b.error}. Puedes trabajar desde la base que hay.</p>
        ) : (
          <p className="muted">
            El worktree de la tarea saldría de una base vieja y podría chocar al integrar.
            {b.ahead > 0
              ? ` Además tienes ${b.ahead} commit(s) locales que no están en el remoto.`
              : ""}
          </p>
        )}
        <Hint>Actualizar hace git pull --ff-only: sólo avanza; si no puede, no toca nada.</Hint>
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        <div className="modal-actions">
          <Button onClick={() => setPending(null)}>Cancelar</Button>
          <Button
            onClick={() => {
              const go = pending.go
              setPending(null)
              void go()
            }}
          >
            Trabajar igual
          </Button>
          {!b.error && (
            <button
              type="button"
              className="button primary"
              disabled={pulling}
              onClick={() => void pullAndGo()}
            >
              {pulling ? "Actualizando…" : "Actualizar y trabajar"}
            </button>
          )}
        </div>
      </div>
    </Modal>
  )
  return { guard, checking, modal }
}
