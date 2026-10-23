/**
 * Investigaciones y reportes con evidencia (ADR-0016). El reporte se genera
 * desde los registros, no desde el chat, y separa hechos verificados,
 * observaciones e hipótesis. Es determinista: los mismos registros dan el
 * mismo Markdown y, por tanto, el mismo hash (no lleva la hora de generarlo).
 * Puro: sin E/S.
 */
import { z } from "zod"

export const ClaimKindSchema = z.enum(["hypothesis", "finding", "conclusion"])
export const ClaimStatusSchema = z.enum(["hypothesis", "observed", "verified", "refuted"])

export const ClaimViewSchema = z.object({
  id: z.string(),
  work_item_id: z.string(),
  kind: ClaimKindSchema,
  statement: z.string(),
  status: ClaimStatusSchema,
  evidence_ids: z.array(z.string()),
  /** Un hallazgo sin evidencia (ADR-0016 §2): la UI y el reporte lo marcan. */
  unsupported: z.boolean(),
  created_by: z.string(),
  run_id: z.string().nullable(),
  decided_by: z.string().nullable(),
  decided_at: z.string().nullable(),
  decision_reason: z.string().nullable(),
  created_at: z.string(),
})
export type ClaimView = z.infer<typeof ClaimViewSchema>

export type ReportEvidence = {
  id: string
  kind: string
  title: string | null
  sha256: string
  sensitivity: "internal" | "restricted" | null
  created_by: string
  provenance: unknown
}

const STATUS_LABEL: Record<ClaimView["status"], string> = {
  hypothesis: "hipótesis",
  observed: "observado",
  verified: "verificado",
  refuted: "refutado",
}

/** Referencia a evidencia: las gráficas se citan como imagen para resolverlas al mostrar. */
function cite(e: ReportEvidence): string {
  return e.kind === "chart"
    ? `![${e.title ?? "gráfica"}](keel:chart/${e.id})`
    : `[${e.title ?? e.kind}](keel:evidence/${e.id})`
}

export function renderReport(input: {
  task: { display_id: string; title: string; spec_markdown: string }
  claims: ClaimView[]
  evidence: ReportEvidence[]
}): string {
  const byId = new Map(input.evidence.map((e) => [e.id, e]))
  const ordered = [...input.claims].sort((a, b) =>
    a.created_at === b.created_at ? (a.id < b.id ? -1 : 1) : a.created_at < b.created_at ? -1 : 1,
  )
  const line = (c: ClaimView) => {
    const tag = c.unsupported ? "sin evidencia" : STATUS_LABEL[c.status]
    const refs = c.evidence_ids
      .map((id) => byId.get(id))
      .filter((e): e is ReportEvidence => e !== undefined)
      .map(cite)
    return [
      `- **[${tag}]** ${c.statement}`,
      ...(refs.length ? [`  Evidencia: ${refs.join(" · ")}`] : []),
      ...(c.decided_by
        ? [`  Decidido por ${c.decided_by}${c.decision_reason ? `: ${c.decision_reason}` : ""}`]
        : []),
    ].join("\n")
  }
  const section = (title: string, list: ClaimView[]) =>
    list.length ? [`## ${title}`, "", ...list.map(line), ""] : []
  const active = ordered.filter((c) => c.status !== "refuted")
  const cited = [...new Set(ordered.flatMap((c) => c.evidence_ids))]
    .map((id) => byId.get(id))
    .filter((e): e is ReportEvidence => e !== undefined)
  return [
    `# Investigación · ${input.task.display_id} · ${input.task.title}`,
    "",
    "## Pregunta",
    "",
    input.task.spec_markdown.trim() || "(sin descripción)",
    "",
    "> Un análisis no prueba por sí mismo un hecho: sólo lo marcado como verificado lo decidió una persona.",
    "",
    ...section(
      "Conclusiones",
      active.filter((c) => c.kind === "conclusion"),
    ),
    ...section(
      "Hallazgos",
      active.filter((c) => c.kind === "finding"),
    ),
    ...section(
      "Hipótesis",
      active.filter((c) => c.kind === "hypothesis"),
    ),
    ...section(
      "Refutado",
      ordered.filter((c) => c.status === "refuted"),
    ),
    ...(cited.length
      ? [
          "## Evidencia citada",
          "",
          "| Evidencia | Tipo | sha256 | Procedencia |",
          "| --- | --- | --- | --- |",
          ...cited.map((e) => {
            const p = (e.provenance ?? {}) as {
              captured_at?: string
              actor?: { id?: string }
              input_sha256?: string
              connection?: { name?: string }
              operation?: string
            }
            const prov = [
              p.connection?.name
                ? `${p.connection.name}${p.operation ? ` · ${p.operation}` : ""}`
                : null,
              p.captured_at ?? null,
              p.actor?.id ?? e.created_by,
              p.input_sha256 ? `entrada ${p.input_sha256.slice(0, 12)}` : null,
            ]
              .filter(Boolean)
              .join(" · ")
            const flag = e.sensitivity === "restricted" ? " (restringida)" : ""
            return `| ${cite(e)}${flag} | ${e.kind} | ${e.sha256.slice(0, 16)} | ${prov} |`
          }),
          "",
        ]
      : []),
  ].join("\n")
}

const esc = (s: string) =>
  s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")

/**
 * Markdown del reporte a HTML. Sólo lo que el reporte usa: títulos, citas,
 * listas, tablas, párrafos, negrita, enlaces e imágenes; todo se escapa. Las
 * referencias `keel:` se resuelven con `resolve` (gráficas ya renderizadas).
 */
export function reportToHtml(
  markdown: string,
  resolve: (ref: string) => { html?: string; href?: string } | null,
): string {
  const inline = (raw: string) =>
    esc(raw)
      .replace(/!\[([^\]]*)\]\((keel:[^)]+)\)/g, (_m, alt: string, ref: string) => {
        const r = resolve(ref)
        return r?.html ?? `<em>[${alt}: ${ref}]</em>`
      })
      .replace(/\[([^\]]*)\]\(([^)]+)\)/g, (_m, text: string, ref: string) => {
        const r = ref.startsWith("keel:") ? resolve(ref) : { href: ref }
        return r?.href ? `<a href="${r.href}">${text}</a>` : text
      })
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
  const out: string[] = []
  const lines = markdown.split("\n")
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i] as string
    if (l.startsWith("# ")) out.push(`<h1>${inline(l.slice(2))}</h1>`)
    else if (l.startsWith("## ")) out.push(`<h2>${inline(l.slice(3))}</h2>`)
    else if (l.startsWith("> ")) out.push(`<blockquote>${inline(l.slice(2))}</blockquote>`)
    else if (l.startsWith("- ")) {
      const items: string[] = []
      while (
        i < lines.length &&
        ((lines[i] as string).startsWith("- ") || (lines[i] as string).startsWith("  "))
      ) {
        const cur = lines[i] as string
        if (cur.startsWith("- ")) items.push(inline(cur.slice(2)))
        else items[items.length - 1] += `<br>${inline(cur.trim())}`
        i++
      }
      i--
      out.push(`<ul>${items.map((x) => `<li>${x}</li>`).join("")}</ul>`)
    } else if (l.startsWith("| ")) {
      const rows: string[][] = []
      while (i < lines.length && (lines[i] as string).startsWith("| ")) {
        const cells = (lines[i] as string)
          .split("|")
          .slice(1, -1)
          .map((c) => c.trim())
        if (!cells.every((c) => /^-+$/.test(c))) rows.push(cells)
        i++
      }
      i--
      const [head, ...body] = rows
      out.push(
        `<table><thead><tr>${(head ?? []).map((c) => `<th>${inline(c)}</th>`).join("")}</tr></thead><tbody>${body
          .map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`)
          .join("")}</tbody></table>`,
      )
    } else if (l.trim()) out.push(`<p>${inline(l)}</p>`)
  }
  return out.join("\n")
}
