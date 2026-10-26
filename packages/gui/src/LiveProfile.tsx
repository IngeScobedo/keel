import type { Methods, ProjectProfile } from "@keel/core"
import { Check, ClipboardCheck, Plus, X } from "lucide-react"
import { useCallback, useEffect, useState } from "react"
import { mutationMeta } from "./client.js"
import { Button, Hint } from "./ui.js"
import type { useWorkspace } from "./useWorkspace.js"

type Call = ReturnType<typeof useWorkspace>["call"]
type View = ReturnType<(typeof Methods)["projects.profile_get"]["result"]["parse"]>

const list = (s: string) =>
  s
    .split(/[\n,]/)
    .map((x) => x.trim())
    .filter(Boolean)

/**
 * El perfil del proyecto (ADR-0021 §5): Keel lo detecta leyendo el repo, sin
 * agente; aquí se confirma o se corrige. De él salen la verificación, las
 * ramas protegidas, las rutas generadas, el canon y los invariantes.
 */
export function LiveProfile({ call }: { call: Call }) {
  const [view, setView] = useState<View | null>(null)
  const [draft, setDraft] = useState<ProjectProfile | null>(null)
  const [error, setError] = useState("")
  const [saved, setSaved] = useState(false)
  const load = useCallback(async () => {
    try {
      const v = await call("projects.profile_get", {})
      setView(v)
      setDraft(v.profile)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [call])
  useEffect(() => {
    void load()
  }, [load])
  if (!draft || !view)
    return (
      <section className="plugins">
        <h2>
          <ClipboardCheck size={15} /> Perfil del proyecto
        </h2>
        {error ? <p className="deleted">{error}</p> : <p className="muted">Leyendo el repo…</p>}
      </section>
    )
  const set = (patch: Partial<ProjectProfile>) => {
    setSaved(false)
    setDraft({ ...draft, ...patch })
  }
  async function confirm() {
    if (!draft) return
    setError("")
    try {
      const v = await call("projects.profile_set", { ...mutationMeta(), profile: draft })
      setView(v)
      setDraft(v.profile)
      setSaved(true)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }
  const harness = [
    draft.harness.claude_md && "CLAUDE.md",
    draft.harness.agents_md && "AGENTS.md",
    draft.harness.claude_dir && ".claude/",
  ].filter(Boolean)
  return (
    <section className="plugins profile" data-testid="project-profile">
      <h2>
        <ClipboardCheck size={15} /> Perfil del proyecto
      </h2>
      <p className="muted">
        {view.confirmed_by
          ? `Confirmado por ${view.confirmed_by} · ${view.confirmed_at}`
          : "Detectado por Keel leyendo el repo; confírmalo o corrígelo."}{" "}
        Stack: {draft.stack.join(", ") || "—"}. Harness propio:{" "}
        {harness.length
          ? `${harness.join(", ")} (Keel lo carga en cada run)`
          : "ninguno (Keel usa su método)"}
        .
      </p>
      <h3>Verificación</h3>
      <Hint>
        Keel la corre en el worktree de la tarea: un baseline al empezar a implementar y el delta al
        revisar. Sólo el rojo nuevo bloquea el cierre.
      </Hint>
      {draft.verify.map((v, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: filas editables sin id; el orden es el de ejecución
        <div className="profile-row" key={i}>
          <input
            aria-label={`Nombre de la verificación ${i + 1}`}
            value={v.name}
            onChange={(e) =>
              set({
                verify: draft.verify.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)),
              })
            }
          />
          <input
            aria-label={`Comando de la verificación ${i + 1}`}
            className="mono"
            value={v.command}
            onChange={(e) =>
              set({
                verify: draft.verify.map((x, j) =>
                  j === i ? { ...x, command: e.target.value } : x,
                ),
              })
            }
          />
          <Button
            variant="ghost"
            icon={X}
            aria-label={`Quitar ${v.name}`}
            onClick={() => set({ verify: draft.verify.filter((_, j) => j !== i) })}
          />
        </div>
      ))}
      <Button
        icon={Plus}
        onClick={() => set({ verify: [...draft.verify, { name: "check", command: "" }] })}
      >
        Añadir comando
      </Button>
      <h3>Reglas</h3>
      <label className="profile-field">
        Ramas protegidas
        <input
          aria-label="Ramas protegidas"
          value={draft.protected_branches.join(", ")}
          onChange={(e) => set({ protected_branches: list(e.target.value) })}
        />
      </label>
      <label className="profile-field">
        Rutas generadas (no se editan a mano)
        <input
          aria-label="Rutas generadas"
          className="mono"
          value={draft.generated_paths.join(", ")}
          onChange={(e) => set({ generated_paths: list(e.target.value) })}
        />
      </label>
      <label className="profile-field">
        Invariantes (tocarlos exige ADR en el diseño)
        <input
          aria-label="Invariantes"
          placeholder="centavos, RBAC, envelope"
          value={draft.invariants.join(", ")}
          onChange={(e) => set({ invariants: list(e.target.value) })}
        />
      </label>
      <h3>Canon</h3>
      <label className="profile-field">
        Carpetas de ADR
        <input
          aria-label="Carpetas de ADR"
          className="mono"
          value={draft.canon.adr_dirs.join(", ")}
          onChange={(e) => set({ canon: { ...draft.canon, adr_dirs: list(e.target.value) } })}
        />
      </label>
      <label className="profile-field">
        Carpetas de SDD
        <input
          aria-label="Carpetas de SDD"
          className="mono"
          value={draft.canon.sdd_dirs.join(", ")}
          onChange={(e) => set({ canon: { ...draft.canon, sdd_dirs: list(e.target.value) } })}
        />
      </label>
      <label className="profile-field">
        Patrón de ADR
        <input
          aria-label="Patrón de ADR"
          className="mono"
          value={draft.adr_pattern ?? ""}
          onChange={(e) => set({ adr_pattern: e.target.value.trim() || null })}
        />
      </label>
      <div className="rc-actions">
        <Button variant="primary" icon={Check} onClick={() => void confirm()}>
          {view.confirmed_by ? "Guardar cambios" : "Confirmar perfil"}
        </Button>
        <Button
          onClick={() => {
            setDraft(view.detected)
            setSaved(false)
          }}
        >
          Volver a lo detectado
        </Button>
        {saved && <span className="muted">Guardado.</span>}
      </div>
      {error && <p className="deleted">{error}</p>}
    </section>
  )
}
