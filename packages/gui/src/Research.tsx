import {
  type ClaimViewSchema,
  type EvidenceViewSchema,
  type ReportViewSchema,
  reportToHtml,
} from "@keel/core"
import { Check, Download, FileText, X } from "lucide-react"
import { useCallback, useEffect, useState } from "react"
import { mutationMeta } from "./client.js"
import { actorLabel } from "./model.js"
import { Checkbox, Select } from "./ui/index.js"
import { Button, Empty, Hint } from "./ui.js"
import type { useWorkspace } from "./useWorkspace.js"

type Call = ReturnType<typeof useWorkspace>["call"]
type Claim = ReturnType<typeof ClaimViewSchema.parse>
type Report = ReturnType<typeof ReportViewSchema.parse>
type Evidence = ReturnType<typeof EvidenceViewSchema.parse>

const KIND_LABEL = {
  hypothesis: "Hipótesis",
  finding: "Hallazgos",
  conclusion: "Conclusiones",
} as const
const STATUS_LABEL = {
  hypothesis: "hipótesis",
  observed: "observado",
  verified: "verificado",
  refuted: "refutado",
} as const

function download(name: string, type: string, content: string) {
  const url = URL.createObjectURL(new Blob([content], { type }))
  const a = document.createElement("a")
  a.href = url
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/**
 * Investigación (ADR-0016): hechos verificados, observaciones e hipótesis por
 * separado; sólo el humano decide; el reporte es una versión inmutable.
 */
export function ResearchPanel({
  call,
  workItemId,
  tick,
}: {
  call: Call
  workItemId: string
  tick: number
}) {
  const [claims, setClaims] = useState<Claim[]>([])
  const [reports, setReports] = useState<Report[]>([])
  const [evidence, setEvidence] = useState<Evidence[]>([])
  const [reading, setReading] = useState<Report | null>(null)
  const [kind, setKind] = useState<"hypothesis" | "finding" | "conclusion">("finding")
  const [statement, setStatement] = useState("")
  const [cites, setCites] = useState<string[]>([])
  const [restricted, setRestricted] = useState(false)
  const [error, setError] = useState("")
  const refresh = useCallback(async () => {
    try {
      const [c, r, e] = await Promise.all([
        call("research.claims_list", { work_item_id: workItemId }),
        call("research.reports_list", { work_item_id: workItemId }),
        call("evidence.list", { work_item_id: workItemId }),
      ])
      setClaims(c.claims)
      setReports(r.reports)
      setEvidence(e.evidence)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [call, workItemId])
  // biome-ignore lint/correctness/useExhaustiveDependencies: `tick` sólo dispara la relectura.
  useEffect(() => {
    void refresh()
  }, [refresh, tick])
  async function act(work: () => Promise<unknown>) {
    setError("")
    try {
      await work()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
    await refresh()
  }
  const title = (id: string) => evidence.find((e) => e.id === id)?.title ?? id.slice(0, 10)
  return (
    <div className="research">
      {error && (
        <p className="error-banner" role="alert">
          {error}
        </p>
      )}
      {(["conclusion", "finding", "hypothesis"] as const).map((k) => {
        const list = claims.filter((c) => c.kind === k)
        if (!list.length) return null
        return (
          <section key={k}>
            <h3>{KIND_LABEL[k]}</h3>
            {list.map((c) => (
              <article key={c.id} className={`claim status-${c.status}`} data-testid="claim">
                <span className={`tag claim-${c.status}`}>{STATUS_LABEL[c.status]}</span>
                {c.unsupported && <span className="tag claim-unsupported">sin evidencia</span>}
                <p>{c.statement}</p>
                <p className="muted">
                  {actorLabel(c.created_by).label}
                  {c.evidence_ids.length
                    ? ` · evidencia: ${c.evidence_ids.map(title).join(", ")}`
                    : ""}
                  {c.decided_by
                    ? ` · decidido por ${actorLabel(c.decided_by).label}${c.decision_reason ? `: ${c.decision_reason}` : ""}`
                    : ""}
                </p>
                {c.status !== "verified" && c.status !== "refuted" && (
                  <span className="claim-actions">
                    <Button
                      icon={Check}
                      onClick={() =>
                        void act(() =>
                          call("research.claim_decide", {
                            ...mutationMeta(),
                            claim_id: c.id,
                            decision: "verified",
                          }),
                        )
                      }
                    >
                      Verificar
                    </Button>
                    <Button
                      variant="danger"
                      icon={X}
                      onClick={() =>
                        void act(() =>
                          call("research.claim_decide", {
                            ...mutationMeta(),
                            claim_id: c.id,
                            decision: "refuted",
                          }),
                        )
                      }
                    >
                      Refutar
                    </Button>
                  </span>
                )}
              </article>
            ))}
          </section>
        )
      })}
      {claims.length === 0 && (
        <Empty title="Sin afirmaciones">Los agentes proponen; tú verificas o refutas.</Empty>
      )}
      <form
        className="connection-form"
        onSubmit={(e) => {
          e.preventDefault()
          void act(() =>
            call("research.claim_add", {
              ...mutationMeta(),
              work_item_id: workItemId,
              kind,
              statement: statement.trim(),
              evidence_ids: cites,
            }).then(() => {
              setStatement("")
              setCites([])
            }),
          )
        }}
      >
        <Select
          aria-label="Tipo de afirmación"
          value={kind}
          onChange={(v) => setKind(v as typeof kind)}
          options={[
            { value: "finding", label: "hallazgo" },
            { value: "hypothesis", label: "hipótesis" },
            { value: "conclusion", label: "conclusión" },
          ]}
        />
        <input
          aria-label="Afirmación"
          placeholder="Qué se encontró o se sospecha"
          value={statement}
          onChange={(e) => setStatement(e.target.value)}
        />
        <fieldset className="research-cites" aria-label="Evidencia citada">
          {evidence.map((e) => (
            <Checkbox
              key={e.id}
              checked={cites.includes(e.id)}
              onChange={(on) =>
                setCites((old) => (on ? [...old, e.id] : old.filter((x) => x !== e.id)))
              }
            >
              {e.kind} · {e.title ?? e.id.slice(0, 10)}
            </Checkbox>
          ))}
        </fieldset>
        <button className="button" type="submit" disabled={!statement.trim()}>
          Añadir
        </button>
      </form>
      <section>
        <h3>Reportes</h3>
        <Button
          icon={FileText}
          onClick={() =>
            void act(() =>
              call("research.report_generate", { ...mutationMeta(), work_item_id: workItemId }),
            )
          }
        >
          Generar reporte
        </Button>
        <label className="raw-toggle">
          <input
            type="checkbox"
            checked={restricted}
            onChange={(e) => setRestricted(e.target.checked)}
          />
          Incluir evidencia restringida al exportar
        </label>
        {reports.map((r) => (
          <article key={r.id} className="report-row" data-testid="report">
            <strong>Versión {r.version}</strong>{" "}
            <span className="mono muted">sha256 {r.sha256.slice(0, 16)}</span>{" "}
            <span className="muted">{new Date(r.created_at).toLocaleString()}</span>
            <Button onClick={() => setReading((x) => (x?.id === r.id ? null : r))}>
              {reading?.id === r.id ? "Cerrar" : "Leer"}
            </Button>
            {(["markdown", "html"] as const).map((format) => (
              <Button
                key={format}
                icon={Download}
                onClick={() =>
                  void act(async () => {
                    const out = await call("research.report_export", {
                      report_id: r.id,
                      format,
                      include_restricted: restricted,
                    })
                    download(out.filename, out.media_type, out.content)
                  })
                }
              >
                {format === "markdown" ? "Markdown" : "HTML"}
              </Button>
            ))}
          </article>
        ))}
        {reading && (
          <div
            className="report-body"
            data-testid="report-body"
            // El HTML sale de reportToHtml, que escapa todo el texto de los registros.
            // biome-ignore lint/security/noDangerouslySetInnerHtml: contenido escapado por reportToHtml.
            dangerouslySetInnerHTML={{
              __html: reportToHtml(reading.markdown, (ref) =>
                ref.startsWith("keel:evidence/") ? { href: "#" } : null,
              ),
            }}
          />
        )}
        <Hint>
          Cada versión es inmutable y tiene su hash; generarla otra vez sin cambios da la misma.
        </Hint>
      </section>
    </div>
  )
}
