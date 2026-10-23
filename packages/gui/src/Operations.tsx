import type { SemanticEventViewSchema } from "@keel/core"
import { Database, GitCommitHorizontal, Upload } from "lucide-react"
import { Fragment, useEffect, useState } from "react"
import { TableView, tableFromOutput } from "./Chart.js"
import { ArtifactView } from "./Evidence.js"
import { Empty, Hint } from "./ui.js"
import type { useWorkspace } from "./useWorkspace.js"

type Call = ReturnType<typeof useWorkspace>["call"]
type Semantic = ReturnType<typeof SemanticEventViewSchema.parse>

const COVERAGE_HINT = {
  instrumented: "Lo ejecutó Keel: vio la petición y la respuesta.",
  observed: "El proveedor reportó la llamada y su resultado.",
  inferred: "Deducido del texto de un comando: no se vio el resultado.",
} as const

/**
 * Lo que hizo el agente reconocido por los intérpretes (ADR-0011): consultas,
 * commits, pushes. Cada fila dice cómo se supo; lo inferido nunca parece
 * observado.
 */
type Visualizer = {
  kind: string
  primitive: "kv" | "table" | "code"
  fields?: string[]
  rows_field?: string
  code_field?: string
}

/** Primitivas declarativas de un plugin (ADR-0014 §4): no ejecutan código. */
function Declared({ v, payload }: { v: Visualizer; payload: Record<string, unknown> }) {
  if (v.primitive === "code")
    return <pre className="evidence-text">{String(payload[v.code_field ?? ""] ?? "")}</pre>
  if (v.primitive === "table") {
    const table = tableFromOutput(payload[v.rows_field ?? "rows"] ?? [])
    return table ? <TableView table={table} /> : <Hint>Sin filas.</Hint>
  }
  const fields = v.fields ?? Object.keys(payload)
  return (
    <dl className="confirmation-scope" data-testid="kv">
      {fields.map((f) => (
        <Fragment key={f}>
          <dt>{f}</dt>
          <dd className="mono">
            {typeof payload[f] === "object"
              ? JSON.stringify(payload[f])
              : String(payload[f] ?? "—")}
          </dd>
        </Fragment>
      ))}
    </dl>
  )
}

export function Operations({
  call,
  runId,
  version,
}: {
  call: Call
  runId: string
  version: number
}) {
  const [items, setItems] = useState<Semantic[]>([])
  const [visualizers, setVisualizers] = useState<Visualizer[]>([])
  useEffect(() => {
    call("plugins.list", {})
      .then((r) => setVisualizers(r.plugins.flatMap((p) => p.manifest.visualizers as Visualizer[])))
      .catch(() => setVisualizers([]))
  }, [call])
  const [open, setOpen] = useState<string | null>(null)
  const [error, setError] = useState("")
  // biome-ignore lint/correctness/useExhaustiveDependencies: `version` sólo dispara la relectura.
  useEffect(() => {
    call("semantic.list", { run_id: runId })
      .then((r) => setItems(r.events))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
  }, [call, runId, version])
  return (
    <div className="operations">
      {error && <p className="deleted">{error}</p>}
      {items.map((e) => {
        const p = (e.payload ?? {}) as Record<string, unknown>
        const isQuery = e.kind === "database.query.completed"
        const Icon = isQuery
          ? Database
          : e.kind === "git.push.completed"
            ? Upload
            : GitCommitHorizontal
        return (
          <article key={e.id} className="operation" data-testid="operation">
            <button
              type="button"
              className="evidence-head"
              onClick={() => setOpen((o) => (o === e.id ? null : e.id))}
            >
              <Icon size={15} />
              <strong>{e.kind}</strong>
              <span className={`tag coverage-${e.coverage}`} title={COVERAGE_HINT[e.coverage]}>
                {e.coverage}
              </span>
              <span className="mono muted operation-summary">
                {isQuery
                  ? `${String(p.query ?? "consulta no visible")} · ${p.row_count === null ? "filas no vistas" : `${p.row_count} filas`}`
                  : e.kind === "git.commit.created"
                    ? `${String(p.sha ?? "sha desconocido").slice(0, 10)} ${String(p.message ?? "")}`
                    : e.kind === "git.push.completed"
                      ? `${String(p.remote ?? "?")} ${String(p.ref ?? "")}`
                      : JSON.stringify(p).slice(0, 120)}
              </span>
            </button>
            {open === e.id && (
              <div className="evidence-body">
                <p className="mono muted">
                  {e.interpreter} · origen {e.source_event_ids.length} evento(s)
                  {e.tool_use_id ? ` · ${e.tool_use_id}` : ""}
                </p>
                {typeof p.result_ref === "string" ? (
                  <ArtifactView call={call} artifactRef={p.result_ref} title="resultado" />
                ) : visualizers.some((v) => v.kind === e.kind) ? (
                  <Declared
                    v={visualizers.find((v) => v.kind === e.kind) as Visualizer}
                    payload={p}
                  />
                ) : (
                  <pre className="evidence-text">{JSON.stringify(p, null, 2)}</pre>
                )}
              </div>
            )}
          </article>
        )
      })}
      {items.length === 0 && (
        <Empty title="Sin operaciones reconocidas">
          Consultas a bases de datos, commits y pushes aparecen aquí con cómo se supo de ellos.
        </Empty>
      )}
      <Hint>
        Cobertura: instrumented (lo ejecutó Keel), observed (lo reportó el proveedor), inferred
        (deducido de un comando). Lo que pasa por un shell no tiene resultado visible.
      </Hint>
    </div>
  )
}
