import type { EvidenceKindSchema, EvidenceViewSchema } from "@keel/core"
import { FileText, Paperclip, ShieldAlert } from "lucide-react"
import { useCallback, useEffect, useState } from "react"
import { type KeelTable, TableWithChart } from "./Chart.js"
import { mutationMeta } from "./client.js"
import { actorLabel } from "./model.js"
import { Select } from "./ui/index.js"
import { Empty, Hint } from "./ui.js"
import type { useWorkspace } from "./useWorkspace.js"

type Call = ReturnType<typeof useWorkspace>["call"]
type Evidence = ReturnType<typeof EvidenceViewSchema.parse>
type Kind = ReturnType<typeof EvidenceKindSchema.parse>
const KINDS: Kind[] = [
  "document",
  "test_report",
  "screenshot",
  "log",
  "diff",
  "sql_result",
  "chart",
]

/** Lee un artefacto entero por partes (ADR-0012 §9). */
async function readAll(
  call: Call,
  ref: string,
): Promise<{ bytes: Uint8Array; media: string; ok: boolean }> {
  const parts: Uint8Array[] = []
  let offset = 0
  for (;;) {
    const r = await call("artifacts.read", { ref, offset })
    const chunk = Uint8Array.from(atob(r.data_base64), (c) => c.charCodeAt(0))
    parts.push(chunk)
    offset += chunk.length
    if (r.eof) {
      const bytes = new Uint8Array(offset)
      let at = 0
      for (const p of parts) {
        bytes.set(p, at)
        at += p.length
      }
      return { bytes, media: r.media_type, ok: r.integrity === "ok" }
    }
  }
}

function Viewer({ call, item }: { call: Call; item: Evidence }) {
  return (
    <ArtifactView call={call} artifactRef={item.artifact_ref} title={item.title ?? item.kind} />
  )
}

/** Un artefacto mostrado según su tipo (texto, imagen, tabla de Keel). */
export function ArtifactView({
  call,
  artifactRef,
  title,
}: {
  call: Call
  artifactRef: string
  title: string
}) {
  const [state, setState] = useState<
    | { kind: "loading" }
    | { kind: "error"; message: string }
    | { kind: "ready"; bytes: Uint8Array; media: string; ok: boolean }
  >({ kind: "loading" })
  useEffect(() => {
    readAll(call, artifactRef)
      .then((r) => setState({ kind: "ready", ...r }))
      .catch((e: unknown) =>
        setState({ kind: "error", message: e instanceof Error ? e.message : String(e) }),
      )
  }, [call, artifactRef])
  if (state.kind === "loading") return <Hint>Cargando…</Hint>
  if (state.kind === "error") return <p className="deleted">{state.message}</p>
  const text = () => new TextDecoder().decode(state.bytes)
  const warn = !state.ok && (
    <p className="deleted" role="alert">
      El contenido no coincide con su hash: no se da por válido.
    </p>
  )
  if (state.media.startsWith("image/")) {
    const url = URL.createObjectURL(new Blob([state.bytes as BlobPart], { type: state.media }))
    return (
      <>
        {warn}
        <img className="evidence-image" src={url} alt={title} />
      </>
    )
  }
  if (state.media === "application/vnd.keel.table+json")
    return (
      <>
        {warn}
        <TableWithChart table={JSON.parse(text()) as KeelTable} call={call} />
      </>
    )
  if (
    state.media.startsWith("text/") ||
    state.media.includes("json") ||
    state.media.includes("xml")
  )
    return (
      <>
        {warn}
        <pre className="evidence-text">{text()}</pre>
      </>
    )
  return (
    <>
      {warn}
      <Hint>
        {state.media} · {state.bytes.length} bytes. Sin vista previa para este tipo.
      </Hint>
    </>
  )
}

/** Evidencia de una tarea (ADR-0012): con su procedencia, inmutable, y la propia del humano. */
export function EvidencePanel({
  call,
  workItemId,
  tick,
}: {
  call: Call
  workItemId: string
  tick: number
}) {
  const [items, setItems] = useState<Evidence[]>([])
  const [open, setOpen] = useState<string | null>(null)
  const [kind, setKind] = useState<Kind>("document")
  const [title, setTitle] = useState("")
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)
  const refresh = useCallback(async () => {
    try {
      setItems((await call("evidence.list", { work_item_id: workItemId })).evidence)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [call, workItemId])
  // biome-ignore lint/correctness/useExhaustiveDependencies: `tick` sólo dispara la relectura.
  useEffect(() => {
    void refresh()
  }, [refresh, tick])

  async function attach(file: File) {
    setBusy(true)
    setError("")
    try {
      const buf = new Uint8Array(await file.arrayBuffer())
      let bin = ""
      for (let i = 0; i < buf.length; i += 0x8000)
        bin += String.fromCharCode(...buf.subarray(i, i + 0x8000))
      await call("evidence.attach", {
        ...mutationMeta(),
        work_item_id: workItemId,
        kind,
        title: title.trim() || file.name,
        content_base64: btoa(bin),
        media_type: file.type || "application/octet-stream",
      })
      setTitle("")
      await refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="evidence">
      <form className="evidence-attach" onSubmit={(e) => e.preventDefault()}>
        <Select
          aria-label="Tipo de evidencia"
          value={kind}
          onChange={(v) => setKind(v as Kind)}
          options={KINDS.map((k) => ({ value: String(k), label: k }))}
        />
        <input
          aria-label="Título de la evidencia"
          placeholder="Título (opcional)"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
        <label className="button">
          <Paperclip size={13} /> {busy ? "Adjuntando…" : "Adjuntar archivo"}
          <input
            type="file"
            aria-label="Archivo de evidencia"
            hidden
            disabled={busy}
            onChange={(e) => {
              const f = e.target.files?.[0]
              if (f) void attach(f)
              e.target.value = ""
            }}
          />
        </label>
      </form>
      {error && (
        <p className="error-banner" role="alert">
          {error}
        </p>
      )}
      {items.map((item) => {
        const prov = (item.provenance ?? {}) as {
          captured_at?: string
          source?: { worktree_path?: string }
        }
        return (
          <article key={item.id} className="evidence-row" data-testid="evidence">
            <button
              type="button"
              className="evidence-head"
              onClick={() => setOpen((o) => (o === item.id ? null : item.id))}
            >
              {item.integrity && item.integrity !== "ok" ? (
                <ShieldAlert size={16} className="deleted" />
              ) : (
                <FileText size={16} />
              )}
              <strong>{item.title ?? item.kind}</strong>
              <span className="tag">{item.kind}</span>
              {item.sensitivity === "restricted" && <span className="tag deleted">restricted</span>}
              <span className="muted">{actorLabel(item.created_by).label}</span>
              <span className="mono muted">
                {item.sha256.slice(0, 10)} · {item.size ?? "?"} B
              </span>
            </button>
            {open === item.id && (
              <div className="evidence-body">
                <p className="mono muted">
                  {prov.captured_at ? new Date(prov.captured_at).toLocaleString() : item.created_at}
                  {prov.source?.worktree_path ? ` · ${prov.source.worktree_path}` : ""}
                  {item.supersedes_id ? ` · corrige ${item.supersedes_id.slice(0, 10)}` : ""}
                  {item.run_id ? ` · run ${item.run_id.slice(0, 10)}` : ""}
                </p>
                <Viewer call={call} item={item} />
              </div>
            )}
          </article>
        )
      })}
      {items.length === 0 && (
        <Empty title="Sin evidencia">
          Adjunta un archivo o deja que el agente adjunte la suya.
        </Empty>
      )}
    </div>
  )
}
