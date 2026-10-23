/**
 * Investigaciones y reportes (ADR-0016). Las afirmaciones las proponen agentes
 * y humanos; sólo un humano verifica o refuta. El reporte es una versión
 * inmutable generada desde los registros, con hash; sus gráficas apuntan a los
 * mismos artefactos que se vieron en vivo, y al exportar se incluyen ya
 * renderizadas. Lo restringido sólo sale si el humano lo elige.
 */
import type { Database } from "bun:sqlite"
import { type ClaimView, type ReportEvidence, renderReport, reportToHtml } from "@keel/core"
import { type ArtifactStore, parseArtifactRef } from "./artifacts.js"
import { sha256Hex, ulid } from "./ids.js"
import type { EvidenceRow, Repo } from "./store/repo.js"

type ClaimRow = {
  id: string
  project_id: string
  work_item_id: string
  kind: ClaimView["kind"]
  statement: string
  status: ClaimView["status"]
  evidence_ids_json: string
  created_by: string
  run_id: string | null
  decided_by: string | null
  decided_at: string | null
  decision_reason: string | null
  created_at: string
}
type ReportRow = {
  id: string
  project_id: string
  work_item_id: string
  version: number
  markdown: string
  sha256: string
  created_by: string
  created_at: string
}

export class ResearchError extends Error {
  readonly code: "not_found" | "invalid" | "denied"
  constructor(code: ResearchError["code"], message: string) {
    super(message)
    this.code = code
  }
}

export class Research {
  private readonly db: Database
  private readonly repo: Repo
  private readonly artifacts: ArtifactStore
  constructor(deps: { db: Database; repo: Repo; artifacts: ArtifactStore }) {
    this.db = deps.db
    this.repo = deps.repo
    this.artifacts = deps.artifacts
  }

  view(r: ClaimRow): ClaimView {
    const evidence_ids = JSON.parse(r.evidence_ids_json) as string[]
    return {
      id: r.id,
      work_item_id: r.work_item_id,
      kind: r.kind,
      statement: r.statement,
      status: r.status,
      evidence_ids,
      unsupported: r.kind === "finding" && evidence_ids.length === 0,
      created_by: r.created_by,
      run_id: r.run_id,
      decided_by: r.decided_by,
      decided_at: r.decided_at,
      decision_reason: r.decision_reason,
      created_at: r.created_at,
    }
  }

  private task(workItemId: string) {
    const w = this.repo.getWorkItem(workItemId)
    if (!w) throw new ResearchError("not_found", "la tarea no existe")
    const kind = this.db
      .query<{ kind: string }, [string]>("SELECT kind FROM work_items WHERE id = ?")
      .get(workItemId)?.kind
    // Una investigación es una tarea de tipo research (ADR-0016 §1).
    if (kind !== "research")
      throw new ResearchError("invalid", "las afirmaciones viven en tareas de tipo research")
    return w
  }

  add(p: {
    work_item_id: string
    kind: ClaimView["kind"]
    statement: string
    evidence_ids: string[]
    created_by: string
    run_id: string | null
  }): ClaimView {
    const w = this.task(p.work_item_id)
    for (const id of p.evidence_ids) {
      const e = this.repo.getEvidence(id)
      if (!e || e.project_id !== w.project_id)
        throw new ResearchError("invalid", `la evidencia ${id} no existe en este proyecto`)
    }
    // Un hallazgo se observó; una hipótesis o una conclusión propuesta aún no se decide.
    const status = p.kind === "finding" ? "observed" : "hypothesis"
    const id = ulid()
    this.db
      .query(
        `INSERT INTO research_claims_items(id, project_id, work_item_id, kind, statement, status,
           evidence_ids_json, created_by, run_id) VALUES (?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        id,
        w.project_id,
        w.id,
        p.kind,
        p.statement,
        status,
        JSON.stringify(p.evidence_ids),
        p.created_by,
        p.run_id,
      )
    return this.view(this.get(id) as ClaimRow)
  }

  get(id: string): ClaimRow | null {
    return this.db
      .query<ClaimRow, [string]>("SELECT * FROM research_claims_items WHERE id = ?")
      .get(id)
  }

  decide(
    id: string,
    decision: "verified" | "refuted",
    actor: string,
    reason: string | null,
  ): ClaimView {
    const c = this.get(id)
    if (!c) throw new ResearchError("not_found", "la afirmación no existe")
    this.db
      .query(
        `UPDATE research_claims_items SET status = ?, decided_by = ?, decision_reason = ?,
           decided_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`,
      )
      .run(decision, actor, reason, id)
    return this.view(this.get(id) as ClaimRow)
  }

  list(workItemId: string): ClaimView[] {
    return this.db
      .query<ClaimRow, [string]>(
        "SELECT * FROM research_claims_items WHERE work_item_id = ? ORDER BY created_at, id",
      )
      .all(workItemId)
      .map((r) => this.view(r))
  }

  private evidenceOf(ids: string[]): ReportEvidence[] {
    return ids.flatMap((id) => {
      const e = this.repo.getEvidence(id)
      if (!e) return []
      const sha = parseArtifactRef(e.artifact_ref)
      const a = sha ? this.artifacts.get(sha) : null
      return [
        {
          id: e.id,
          kind: e.kind,
          title: e.title,
          sha256: e.sha256,
          sensitivity: a?.sensitivity ?? null,
          created_by: e.created_by,
          provenance: JSON.parse(e.provenance_json) as unknown,
        },
      ]
    })
  }

  /** Genera la versión; si los registros no cambiaron, el hash es el mismo y se reusa. */
  async generate(
    workItemId: string,
    actor: string,
  ): Promise<{ report: ReportRow; reused: boolean }> {
    const w = this.task(workItemId)
    const claims = this.list(workItemId)
    const markdown = renderReport({
      task: {
        display_id: w.display_id,
        title: w.title,
        spec_markdown: this.repo.workItemSpec(w.id),
      },
      claims,
      evidence: this.evidenceOf([...new Set(claims.flatMap((c) => c.evidence_ids))]),
    })
    const sha = await sha256Hex(markdown)
    const last = this.reports(workItemId)[0]
    if (last && last.sha256 === sha) return { report: last, reused: true }
    const id = ulid()
    this.db
      .query(
        "INSERT INTO research_reports(id, project_id, work_item_id, version, markdown, sha256, created_by) VALUES (?,?,?,?,?,?,?)",
      )
      .run(id, w.project_id, w.id, (last?.version ?? 0) + 1, markdown, sha, actor)
    return { report: this.report(id) as ReportRow, reused: false }
  }

  report(id: string): ReportRow | null {
    return this.db.query<ReportRow, [string]>("SELECT * FROM research_reports WHERE id = ?").get(id)
  }

  reports(workItemId: string): ReportRow[] {
    return this.db
      .query<ReportRow, [string]>(
        "SELECT * FROM research_reports WHERE work_item_id = ? ORDER BY version DESC",
      )
      .all(workItemId)
  }

  /**
   * Exporta a Markdown o HTML (ADR-0016 §5). Las gráficas van ya renderizadas
   * (el SVG guardado con la gráfica); la evidencia restringida sólo si se pide.
   */
  export(
    r: ReportRow,
    format: "markdown" | "html",
    includeRestricted: boolean,
  ): { filename: string; media_type: string; content: string } {
    const restricted = (e: EvidenceRow | null) => {
      if (!e) return false
      const sha = parseArtifactRef(e.artifact_ref)
      return (sha ? this.artifacts.get(sha) : null)?.sensitivity === "restricted"
    }
    const refId = (ref: string) => ref.replace(/^keel:(chart|evidence)\//, "")
    let md = r.markdown
    if (!includeRestricted)
      md = md.replace(
        /!?\[[^\]]*\]\((keel:(?:chart|evidence)\/[0-9A-Z]{26})\)/g,
        (m, ref: string) =>
          restricted(this.repo.getEvidence(refId(ref))) ? "[evidencia restringida omitida]" : m,
      )
    const base = `investigacion-${r.work_item_id}-v${r.version}`
    if (format === "markdown")
      return { filename: `${base}.md`, media_type: "text/markdown", content: md }
    const body = reportToHtml(md, (ref) => {
      const e = this.repo.getEvidence(refId(ref))
      if (!e) return null
      if (ref.startsWith("keel:chart/")) {
        const render = (JSON.parse(e.metadata_json) as { render_ref?: string }).render_ref
        const sha = render ? parseArtifactRef(render) : null
        if (sha)
          try {
            const svg = this.artifacts.readAll(sha).toString("utf8")
            if (svg.trimStart().startsWith("<svg")) return { html: `<figure>${svg}</figure>` }
          } catch {
            // Sin el render, queda la referencia.
          }
        return null
      }
      return { href: `#evidencia-${e.id}` }
    })
    return {
      filename: `${base}.html`,
      media_type: "text/html",
      content: `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>${base}</title><style>body{font-family:system-ui,sans-serif;max-width:880px;margin:2rem auto;padding:0 1rem;line-height:1.5}table{border-collapse:collapse}td,th{border:1px solid #ccc;padding:4px 8px}blockquote{color:#555;border-left:3px solid #ccc;margin:0;padding-left:1rem}</style></head><body>\n${body}\n<p><small>sha256 del reporte ${r.sha256} · versión ${r.version}</small></p></body></html>`,
    }
  }
}
