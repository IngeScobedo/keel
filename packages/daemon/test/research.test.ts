/**
 * ADR-0016: investigaciones con afirmaciones tipadas y reportes inmutables.
 * Daemon y SQLite reales.
 */
import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Daemon, IpcClient } from "../src/index.ts"
import { initRepo } from "./git-fixture.ts"
import { replayQuery } from "./replay.ts"

const dirs: string[] = []
const daemons: Daemon[] = []
const clients: IpcClient[] = []
afterEach(async () => {
  for (const c of clients.splice(0)) c.close()
  for (const d of daemons.splice(0)) {
    await d.idle()
    d.stop()
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
const meta = () => ({ request_id: "r", idempotency_key: crypto.randomUUID() })
const b64 = (s: string) => Buffer.from(s).toString("base64")

async function boot() {
  const dir = mkdtempSync(join(tmpdir(), "keel-rsch-"))
  dirs.push(dir)
  initRepo(join(dir, "repo"))
  const daemon = new Daemon({
    dbPath: join(dir, "keel.sqlite"),
    socketPath: join(dir, "keel.sock"),
    rootPath: join(dir, "repo"),
    adapterDeps: { queryFn: replayQuery(), binary: "/fake/claude" },
    mcpBridge: false,
  })
  daemon.start()
  daemons.push(daemon)
  const human = await IpcClient.connect(daemon.server.path)
  clients.push(human)
  const w = (await human.call("work_items.create", {
    ...meta(),
    title: "Faltan 30 mil pesos",
    kind: "research",
    spec_markdown: "¿Dónde están los 30 mil de octubre?",
  })) as { id: string }
  const pid = daemon.project.project_id
  const run = daemon.repo.createRun({ project_id: pid, work_item_id: w.id, purpose: "plan" })
  daemon.repo.updateRun(run.id, { status: "running" })
  const { file } = daemon.agentTokens.issue({ run_id: run.id, project_id: pid, work_item_id: w.id })
  const agent = await IpcClient.connect(daemon.agentServer.path)
  clients.push(agent)
  await agent.call("session.bind_agent", { token: readFileSync(file, "utf8") })
  return { daemon, human, agent, w }
}

type Claim = { id: string; status: string; unsupported: boolean }

describe("ADR-0016: investigaciones y reportes", () => {
  test("el agente propone; sólo el humano verifica; el hallazgo sin evidencia queda marcado", async () => {
    const { human, agent, w } = await boot()
    const ev = (await human.call("evidence.attach", {
      ...meta(),
      work_item_id: w.id,
      kind: "sql_result",
      title: "movimientos de octubre",
      content_base64: b64("[]"),
    })) as { id: string }
    const h = (await agent.call("research.claim_add", {
      ...meta(),
      kind: "hypothesis",
      statement: "Un depósito se registró dos veces",
    })) as Claim
    expect(h.status).toBe("hypothesis")
    const f = (await agent.call("research.claim_add", {
      ...meta(),
      kind: "finding",
      statement: "El depósito 1182 aparece en caja y en banco",
      evidence_ids: [ev.id],
    })) as Claim
    expect(f).toMatchObject({ status: "observed", unsupported: false })
    const loose = (await agent.call("research.claim_add", {
      ...meta(),
      kind: "finding",
      statement: "La cajera lo hizo",
    })) as Claim
    expect(loose.unsupported).toBe(true)
    await expect(
      agent.call("research.claim_decide", { ...meta(), claim_id: f.id, decision: "verified" }),
    ).rejects.toThrow("un agente no puede usar")
    const v = (await human.call("research.claim_decide", {
      ...meta(),
      claim_id: f.id,
      decision: "verified",
      reason: "lo revisé en el estado de cuenta",
    })) as Claim
    expect(v.status).toBe("verified")
    const r = (await human.call("research.report_generate", { ...meta(), work_item_id: w.id })) as {
      markdown: string
    }
    expect(r.markdown).toContain("**[verificado]** El depósito 1182")
    expect(r.markdown).toContain("**[sin evidencia]** La cajera lo hizo")
    expect(r.markdown).toContain(`keel:evidence/${ev.id}`)
  })

  test("generar dos veces desde los mismos registros da el mismo hash; un cambio da otra versión", async () => {
    const { human, w } = await boot()
    await human.call("research.claim_add", {
      ...meta(),
      work_item_id: w.id,
      kind: "hypothesis",
      statement: "x",
    })
    const a = (await human.call("research.report_generate", { ...meta(), work_item_id: w.id })) as {
      sha256: string
      version: number
      reused: boolean
    }
    const b = (await human.call("research.report_generate", {
      ...meta(),
      work_item_id: w.id,
    })) as typeof a
    expect(b).toMatchObject({ sha256: a.sha256, version: 1, reused: true })
    await human.call("research.claim_add", {
      ...meta(),
      work_item_id: w.id,
      kind: "hypothesis",
      statement: "y",
    })
    const c = (await human.call("research.report_generate", {
      ...meta(),
      work_item_id: w.id,
    })) as typeof a
    expect(c.version).toBe(2)
    expect(c.sha256).not.toBe(a.sha256)
    const list = (await human.call("research.reports_list", { work_item_id: w.id })) as {
      reports: { version: number }[]
    }
    expect(list.reports.map((x) => x.version)).toEqual([2, 1])
  })

  test("la gráfica del reporte es el mismo artefacto que se vio en vivo; el HTML la lleva renderizada", async () => {
    const { human, w } = await boot()
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10"/></svg>'
    const render = (await human.call("artifacts.put", {
      ...meta(),
      content_base64: b64(svg),
      media_type: "image/svg+xml",
    })) as { ref: string }
    const chart = (await human.call("evidence.attach", {
      ...meta(),
      work_item_id: w.id,
      kind: "chart",
      title: "saldo por día",
      content_base64: b64('{"mark":"bar"}'),
      media_type: "application/vnd.vegalite.v5+json",
      metadata: { render_ref: render.ref },
    })) as { id: string; artifact_ref: string }
    await human.call("research.claim_add", {
      ...meta(),
      work_item_id: w.id,
      kind: "finding",
      statement: "El saldo cae el día 14",
      evidence_ids: [chart.id],
    })
    const r = (await human.call("research.report_generate", { ...meta(), work_item_id: w.id })) as {
      id: string
      markdown: string
    }
    expect(r.markdown).toContain(`![saldo por día](keel:chart/${chart.id})`)
    const live = (await human.call("evidence.list", { work_item_id: w.id })) as {
      evidence: { id: string; artifact_ref: string }[]
    }
    expect(live.evidence.find((e) => e.id === chart.id)?.artifact_ref).toBe(chart.artifact_ref)
    const html = (await human.call("research.report_export", {
      report_id: r.id,
      format: "html",
    })) as {
      content: string
    }
    expect(html.content).toContain("<figure><svg")
    expect(html.content).toContain("El saldo cae el día 14")
  })

  test("la evidencia restringida sólo sale al exportar si el humano la elige", async () => {
    const { human, w } = await boot()
    const ev = (await human.call("evidence.attach", {
      ...meta(),
      work_item_id: w.id,
      kind: "sql_result",
      title: "nómina de producción",
      sensitivity: "restricted",
      content_base64: b64("[]"),
    })) as { id: string }
    await human.call("research.claim_add", {
      ...meta(),
      work_item_id: w.id,
      kind: "finding",
      statement: "Hay un pago duplicado",
      evidence_ids: [ev.id],
    })
    const r = (await human.call("research.report_generate", { ...meta(), work_item_id: w.id })) as {
      id: string
    }
    const hidden = (await human.call("research.report_export", {
      report_id: r.id,
      format: "markdown",
    })) as {
      content: string
    }
    expect(hidden.content).not.toContain(`keel:evidence/${ev.id}`)
    expect(hidden.content).toContain("[evidencia restringida omitida]")
    const shown = (await human.call("research.report_export", {
      report_id: r.id,
      format: "markdown",
      include_restricted: true,
    })) as { content: string }
    expect(shown.content).toContain(`keel:evidence/${ev.id}`)
  })
})
