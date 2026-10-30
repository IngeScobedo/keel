/**
 * ADR-0035, ADR-0040 y ADR-0042 contra un daemon real: el humano adjunta una lista de
 * tareas, el orquestador (un guion que actúa como el agente) la lee con sus tools y
 * propone el lote; el humano corrige la tarjeta y la aprueba; nace la feature con sus
 * subtareas y el perfil de agente de cada una, y lo no listo vuelve al backlog.
 */
import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import { conversationHeader } from "../src/daemon.ts"
import { Daemon, IpcClient, type QueryFn } from "../src/index.ts"
import { CONVERSATION_KEY } from "../src/store/repo.ts"
import { initRepo } from "./git-fixture.ts"
import { firstPrompt } from "./replay.ts"

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
let n = 0
const meta = () => ({ request_id: "r", idempotency_key: `orq-${++n}` })

const TASKS_MD = `# Pendientes de la tienda

## Proyectos
- Separar Proyectos de Mis pedidos en el menú, Proyectos arriba.
- Aviso de ronda nueva dentro del proyecto.

## Lab
- El diseñador no ve los pines del Lab.

Rastreo de envíos: lo vemos después.
`

type Seen = { prompt: string; options: Options; workItem: string; dedupe: string | null }

async function boot() {
  const dir = mkdtempSync(join(tmpdir(), "keel-orq-"))
  dirs.push(dir)
  const repoDir = initRepo(join(dir, "repo"))
  // Archivos para que repo_anchor tenga qué encontrar.
  for (const f of ["features/projects/menu.tsx", "features/lab/pins.tsx"]) {
    const p = join(repoDir, f)
    const { mkdirSync } = await import("node:fs")
    mkdirSync(join(p, ".."), { recursive: true })
    writeFileSync(p, "export {}\n")
  }
  const { execFileSync } = await import("node:child_process")
  execFileSync("git", ["add", "-A"], { cwd: repoDir })
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "base"], {
    cwd: repoDir,
  })
  const seen: Seen[] = []
  const answers: Record<string, unknown> = {}
  let daemon: Daemon
  const queryFn: QueryFn = ({ prompt, options }) => {
    const runId = String((options.env as Record<string, string>).KEEL_RUN_ID)
    const run = daemon.repo.getRun(runId)
    const item = run ? daemon.repo.getWorkItem(run.work_item_id) : null
    const text = firstPrompt(prompt)
    seen.push({
      prompt: text,
      options,
      workItem: item?.id ?? "",
      dedupe: item?.dedupe_key ?? null,
    })
    return (async function* () {
      if (item?.dedupe_key === CONVERSATION_KEY && run) {
        // El orquestador: lee la fuente, corta con intake_draft, ancla y propone.
        const { file } = daemon.agentTokens.issue({
          run_id: runId,
          project_id: run.project_id,
          work_item_id: run.work_item_id,
        })
        const agent = await IpcClient.connect(daemon.agentServer.path)
        clients.push(agent)
        await agent.call("session.bind_agent", { token: readFileSync(file, "utf8") })
        const src = (await agent.call("sources.get", { source: "S-1" })) as {
          passages: { anchor: string; text: string }[]
        }
        answers.passages = src.passages
        answers.draft = await agent.call("intake.draft", {
          text: src.passages.map((p) => p.text).join("\n"),
        })
        answers.anchor = await agent.call("repo.anchor", { query: "pines del lab" })
        answers.propose = await agent.call("batch.propose", {
          ...meta(),
          title: "Tienda: proyectos y Lab",
          summary: "Lo que pidió el humano en la lista adjunta.",
          intents: [
            {
              key: "T1",
              title: "Proyectos arriba de Mis pedidos",
              kind: "ui-change",
              goal: "Proyectos aparece antes que Mis pedidos en el menú.",
              scope: ["features/projects/**"],
              acceptance: ["El menú muestra Proyectos primero"],
              profile: { provider: "claude", model: "claude-haiku-5-5", effort: "low" },
              provenance: ["S-1 §1"],
            },
            {
              key: "T2",
              title: "Pines del Lab visibles",
              kind: "bugfix",
              goal: "El diseñador ve y abre cada pin del Lab.",
              scope: ["features/lab/**"],
              acceptance: ["Los pines se ven sobre el lienzo"],
              profile: { provider: "claude", model: "claude-opus-5-5", effort: "high" },
              provenance: ["S-1 §3"],
            },
            {
              key: "T3",
              title: "Aviso de ronda nueva",
              kind: "ui-change",
              provenance: ["S-1 §2"],
            },
            {
              key: "T4",
              title: "Rastreo de envíos",
              kind: "feature",
              ordering: "deferred",
              provenance: ["S-1 §4"],
            },
          ],
        })
      }
      yield {
        type: "result",
        subtype: "success",
        uuid: `r-${runId}`,
        session_id: `s-${runId}`,
        is_error: false,
        result: "ok",
        total_cost_usd: 0.001,
        usage: { input_tokens: 1, output_tokens: 1 },
      } as unknown as SDKMessage
    })()
  }
  daemon = new Daemon({
    dbPath: join(dir, "keel.sqlite"),
    socketPath: join(dir, "keel.sock"),
    rootPath: repoDir,
    worktreesDir: join(dir, "worktrees"),
    adapterDeps: { queryFn, binary: "/fake/claude" },
    mcpBridge: false,
  })
  daemon.start()
  daemons.push(daemon)
  const human = await IpcClient.connect(daemon.server.path)
  clients.push(human)
  const until = async (cond: () => boolean, ms = 10_000) => {
    const end = Date.now() + ms
    while (!cond()) {
      if (Date.now() > end) throw new Error("no llegó a tiempo")
      await Bun.sleep(15)
    }
  }
  const events = (kind: string) =>
    daemon.repo
      .eventsAfter(0, null, 100_000)
      .filter((e) => e.kind === kind)
      .map((e) => JSON.parse(e.payload_json) as Record<string, unknown>)
  return { daemon, human, seen, answers, until, events }
}

describe("ADR-0035/0040/0042: de una lista adjunta a un lote", () => {
  test("adjuntar, leer, proponer, corregir la tarjeta y aprobar", async () => {
    const s = await boot()
    const src = (await s.human.call("sources.add", {
      ...meta(),
      title: "pendientes.md",
      media_type: "text/markdown",
      content_base64: Buffer.from(TASKS_MD).toString("base64"),
    })) as { key: string; passages: number }
    expect(src).toMatchObject({ key: "S-1", passages: 4 })

    await s.human.call("conversation.ask", {
      ...meta(),
      text: "Te paso los pendientes de la tienda; arma el lote.",
      sources: ["S-1"],
    })
    await s.until(() => s.answers.propose !== undefined)
    // El orquestador recibió la fuente como referencia y su encabezado de orquestador.
    const conv = s.seen.find((x) => x.dedupe === CONVERSATION_KEY) as Seen
    expect(conv.prompt).toContain("Fuentes adjuntas: S-1 «pendientes.md» (4 pasajes)")
    // Con el puente MCP (apagado aquí), el prompt lleva el encabezado del orquestador.
    expect(conversationHeader()).toContain("plan_propose")
    expect((s.answers.anchor as { matches: string[] }).matches).toContain("features/lab/**")
    expect(
      (s.answers.draft as { intents: { kind: string }[] }).intents.map((i) => i.kind),
    ).toContain("bugfix")
    // Keel decide qué está listo, diga lo que diga el agente.
    expect(s.answers.propose).toMatchObject({
      ready: ["T1", "T2"],
      lanes: [["T1"], ["T2"]],
    })
    const notReady = (s.answers.propose as { not_ready: { key: string }[] }).not_ready
    expect(notReady.map((x) => x.key)).toEqual(["T3", "T4"])

    // La tarjeta: el humano renombra T1 y le cambia el modelo a T2.
    const ask = s.events("approval.requested").find((a) => a.tool === "batch.plan") as {
      approval_id: string
      operation_hash: string
      input: { plan: { intents: Record<string, unknown>[] } & Record<string, unknown> }
    }
    const plan = ask.input.plan
    const edited = {
      ...plan,
      intents: plan.intents.map((i) =>
        i.key === "T1"
          ? { ...i, title: "Proyectos primero en el menú" }
          : i.key === "T2"
            ? { ...i, profile: { provider: "claude", model: "claude-sonnet-5-5" } }
            : i,
      ),
    }
    // No se pueden inventar intents.
    await expect(
      s.human.call("approvals.resolve", {
        ...meta(),
        approval_id: ask.approval_id,
        operation_hash: ask.operation_hash,
        decision: "approve_once",
        batch: {
          ...edited,
          intents: [...edited.intents, { key: "T9", title: "Otro", kind: "chore" }],
        },
      }),
    ).rejects.toThrow("T9 no estaba")
    await s.human.call("approvals.resolve", {
      ...meta(),
      approval_id: ask.approval_id,
      operation_hash: ask.operation_hash,
      decision: "approve_once",
      batch: edited,
    })
    const started = s.events("batch.started")[0] as {
      batch: { id: string; display_id: string }
      started: { key: string }[]
      backlog: { key: string; deferred: boolean }[]
    }
    expect(started.started.map((x) => x.key)).toEqual(["T1", "T2"])
    expect(started.backlog.map((x) => [x.key, x.deferred])).toEqual([
      ["T3", false],
      ["T4", true],
    ])
    // La feature: padre con su rama y dos subtareas, cada una con su perfil.
    const kids = s.daemon.repo.childrenOf(started.batch.id)
    expect(kids.map((k) => k.title).sort()).toEqual([
      "Pines del Lab visibles",
      "Proyectos primero en el menú",
    ])
    // La primera subtarea arranca con el modelo que dijo el plan.
    await s.until(() => s.seen.some((x) => kids.some((k) => k.id === x.workItem)))
    const sub = s.seen.find((x) => kids.some((k) => k.id === x.workItem)) as Seen
    const first = s.daemon.repo.getWorkItem(sub.workItem)
    expect(sub.options.model).toBe(
      first?.title === "Proyectos primero en el menú" ? "claude-haiku-5-5" : "claude-sonnet-5-5",
    )
    // El backlog guarda lo que faltaba y su procedencia.
    const t3 = (await s.human.call("work_items.get", {
      work_item_id: (started.backlog.find((b) => b.key === "T3") as unknown as { id: string }).id,
    })) as { spec_markdown: string }
    expect(t3.spec_markdown).toContain("Falta para arrancar")
    expect(t3.spec_markdown).toContain("S-1 §2")
    // El reporte del lote sale de las subtareas.
    const report = (await s.human.call("batch.report", { work_item_id: started.batch.id })) as {
      markdown: string
    }
    expect(report.markdown).toContain(`Lote ${started.batch.display_id}`)
  }, 30_000)

  test("una fuente .docx se lee; un PDF se rechaza con por qué", async () => {
    const s = await boot()
    const pdf = s.human.call("sources.add", {
      ...meta(),
      title: "minuta.pdf",
      media_type: "application/pdf",
      content_base64: Buffer.from("%PDF-1.4").toString("base64"),
    })
    await expect(pdf).rejects.toThrow("PDF todavía no")
    const docx = await makeDocx([
      ["Heading1", "Minuta"],
      ["", "Quedamos en separar Proyectos de Pedidos."],
      ["list", "Pines del Lab"],
    ])
    const src = (await s.human.call("sources.add", {
      ...meta(),
      title: "minuta.docx",
      media_type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      content_base64: Buffer.from(docx).toString("base64"),
    })) as { key: string }
    const got = (await s.human.call("sources.get", { source: src.key })) as {
      passages: { anchor: string; heading: string | null; text: string }[]
    }
    expect(got.passages).toEqual([
      { anchor: "§1", heading: "Minuta", text: "Quedamos en separar Proyectos de Pedidos." },
      { anchor: "§2", heading: "Minuta", text: "Pines del Lab" },
    ])
  })
})

/** Un .docx mínimo: un ZIP sin comprimir con `word/document.xml`. */
async function makeDocx(paras: [string, string][]): Promise<Uint8Array> {
  const body = paras
    .map(([style, text]) => {
      const pPr =
        style === "list"
          ? '<w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr>'
          : style
            ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>`
            : ""
      return `<w:p>${pPr}<w:r><w:t>${text}</w:t></w:r></w:p>`
    })
    .join("")
  const xml = `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`
  return storedZip([
    ["[Content_Types].xml", "<Types/>"],
    ["word/document.xml", xml],
  ])
}

function storedZip(files: [string, string][]): Uint8Array {
  const enc = new TextEncoder()
  const locals: Uint8Array[] = []
  const centrals: Uint8Array[] = []
  let offset = 0
  for (const [name, text] of files) {
    const nameB = enc.encode(name)
    const data = enc.encode(text)
    const crc = Bun.hash.crc32(data)
    const local = new Uint8Array(30 + nameB.length + data.length)
    const lv = new DataView(local.buffer)
    lv.setUint32(0, 0x04034b50, true)
    lv.setUint16(4, 20, true)
    lv.setUint32(14, crc, true)
    lv.setUint32(18, data.length, true)
    lv.setUint32(22, data.length, true)
    lv.setUint16(26, nameB.length, true)
    local.set(nameB, 30)
    local.set(data, 30 + nameB.length)
    const central = new Uint8Array(46 + nameB.length)
    const cv = new DataView(central.buffer)
    cv.setUint32(0, 0x02014b50, true)
    cv.setUint16(4, 20, true)
    cv.setUint16(6, 20, true)
    cv.setUint32(16, crc, true)
    cv.setUint32(20, data.length, true)
    cv.setUint32(24, data.length, true)
    cv.setUint16(28, nameB.length, true)
    cv.setUint32(42, offset, true)
    central.set(nameB, 46)
    locals.push(local)
    centrals.push(central)
    offset += local.length
  }
  const cdSize = centrals.reduce((n, c) => n + c.length, 0)
  const end = new Uint8Array(22)
  const ev = new DataView(end.buffer)
  ev.setUint32(0, 0x06054b50, true)
  ev.setUint16(8, files.length, true)
  ev.setUint16(10, files.length, true)
  ev.setUint32(12, cdSize, true)
  ev.setUint32(16, offset, true)
  const out = new Uint8Array(offset + cdSize + 22)
  let at = 0
  for (const part of [...locals, ...centrals, end]) {
    out.set(part, at)
    at += part.length
  }
  return out
}
