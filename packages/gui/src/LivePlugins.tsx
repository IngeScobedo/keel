import type { PluginViewSchema } from "@keel/core"
import { Plug, Trash2 } from "lucide-react"
import { type FormEvent, useCallback, useEffect, useState } from "react"
import { mutationMeta } from "./client.js"
import { Button, Empty, Hint } from "./ui.js"
import type { useWorkspace } from "./useWorkspace.js"

type Call = ReturnType<typeof useWorkspace>["call"]
type Plugin = ReturnType<typeof PluginViewSchema.parse>

/** Plugins instalados (ADR-0014 §6): versión y hash fijos; desinstalar no borra lo interpretado. */
export function LivePlugins({ call }: { call: Call }) {
  const [items, setItems] = useState<Plugin[]>([])
  const [path, setPath] = useState("")
  const [error, setError] = useState("")
  const refresh = useCallback(async () => {
    try {
      setItems((await call("plugins.list", {})).plugins)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [call])
  useEffect(() => {
    void refresh()
  }, [refresh])
  async function act(work: () => Promise<unknown>) {
    setError("")
    try {
      await work()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
    await refresh()
  }
  function install(e: FormEvent) {
    e.preventDefault()
    void act(() =>
      call("plugins.install", { ...mutationMeta(), path: path.trim() }).then(() => setPath("")),
    )
  }
  return (
    <section className="plugins">
      <h2>
        <Plug size={15} /> Plugins
      </h2>
      {error && <p className="deleted">{error}</p>}
      {items.map((p) => (
        <article key={p.id} className="connection" data-testid="plugin">
          <strong>
            {p.id} <span className="mono muted">{p.version}</span>
          </strong>{" "}
          <span className="mono muted">sha256 {p.sha256.slice(0, 12)}</span>{" "}
          <span className={p.status === "ok" ? "added" : "deleted"}>{p.status}</span>
          <p className="muted">
            Reconoce{" "}
            {[...p.manifest.recognizes.tools, ...p.manifest.recognizes.event_kinds].join(", ") ||
              "—"}{" "}
            · emite {p.manifest.emits.map((x) => x.kind).join(", ")} · permisos{" "}
            {p.manifest.permissions.join(", ") || "ninguno"}
          </p>
          <Button
            variant="danger"
            icon={Trash2}
            onClick={() =>
              void act(() => call("plugins.uninstall", { ...mutationMeta(), id: p.id }))
            }
          >
            Desinstalar
          </Button>
        </article>
      ))}
      {items.length === 0 && (
        <Empty title="Sin plugins">
          Un plugin reconoce herramientas de terceros y produce eventos con su esquema.
        </Empty>
      )}
      <form className="connection-form" onSubmit={install}>
        <input
          aria-label="Carpeta del plugin"
          placeholder="/ruta/al/plugin (con keel-plugin.json)"
          value={path}
          onChange={(e) => setPath(e.target.value)}
        />
        <button type="submit" className="button" disabled={!path.trim()}>
          Instalar
        </button>
      </form>
      <Hint>
        Corre en su propio proceso, sin secretos ni acceso a la base. Si cambia en disco, no corre
        hasta reinstalarlo.
      </Hint>
    </section>
  )
}
