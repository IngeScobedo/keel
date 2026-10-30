import { describe, expect, test } from "bun:test"
import {
  type Approval,
  buildChat,
  buildLedger,
  dbCall,
  fromUnified,
  keelResult,
  modelLabel,
  optionLabel,
  type ToolCall,
} from "../src/chat-model.js"

let seq = 0
const at = (kind: string, payload: unknown, run_id = "r") => ({
  event_seq: ++seq,
  kind,
  payload,
  project_id: "p",
  run_id,
  received_at: "2026-10-26T00:00:00Z",
})

/** Las formas son las de un run real de Claude Code 2.1.310 (2026-10-26). */
describe("ADR-0020 §1: tarjetas por intención", () => {
  test("un Edit trae su diff del structuredPatch con +n −m", () => {
    const [edit] = buildChat([
      at("hook.PreToolUse", {
        tool_name: "Edit",
        tool_use_id: "t1",
        tool_input: { file_path: "/r/a.ts", old_string: "a", new_string: "a\nb" },
      }),
      at("hook.PostToolUse", {
        tool_name: "Edit",
        tool_use_id: "t1",
        duration_ms: 22,
        tool_response: {
          filePath: "/r/a.ts",
          structuredPatch: [
            { oldStart: 18, oldLines: 2, newStart: 18, newLines: 3, lines: [" x", "+y", " z"] },
          ],
        },
      }),
    ]) as ToolCall[]
    expect(edit).toMatchObject({ state: "done", duration_ms: 22 })
    expect(edit?.diff).toMatchObject([
      {
        path: "/r/a.ts",
        added: 1,
        removed: 0,
        hunks: [{ oldStart: 18, newStart: 18, lines: [" x", "+y", " z"] }],
      },
    ])
  })

  test("la aprobación de Claude se une a su herramienta; la respuesta a la pregunta queda", () => {
    const chat = buildChat([
      at("hook.PreToolUse", {
        tool_name: "Bash",
        tool_use_id: "t1",
        tool_input: { command: "cd apps/api", description: "Entra al API" },
      }),
      at("approval.requested", {
        approval_id: "a1",
        operation_hash: "h",
        tool: "Bash",
        input: { command: "cd apps/api" },
        expires_at: null,
      }),
      at("approval.requested", {
        approval_id: "a2",
        operation_hash: "h2",
        tool: "AskUserQuestion",
        input: { questions: [] },
        expires_at: null,
      }),
      at("approval.resolved", {
        approval_id: "a2",
        decision: "approved",
        answers: { "¿X?": "Sí" },
      }),
    ])
    expect(chat.map((c) => c.kind)).toEqual(["tool", "approval"])
    expect((chat[0] as ToolCall).approval).toMatchObject({ approval_id: "a1", decision: null })
    expect(chat[1] as Approval).toMatchObject({ decision: "approved", answers: { "¿X?": "Sí" } })
  })

  test("Codex: comando corriendo y luego hecho; cambio de archivos con su diff unificado", () => {
    const chat = buildChat([
      at("codex.app.item/started", { item: { id: "c1", type: "commandExecution", command: "ls" } }),
      at("codex.app.item/completed", {
        item: {
          id: "c1",
          type: "commandExecution",
          command: "ls",
          status: "completed",
          exitCode: 0,
          aggregatedOutput: "a\n",
          durationMs: 12,
        },
      }),
      at("codex.app.item/completed", {
        item: {
          id: "f1",
          type: "fileChange",
          status: "completed",
          changes: [{ path: "src/a.ts", diff: "@@ -1,1 +1,2 @@\n x\n+y" }],
        },
      }),
    ]) as ToolCall[]
    expect(chat).toHaveLength(2)
    expect(chat[0]).toMatchObject({ name: "Bash", state: "done", duration_ms: 12 })
    expect(chat[1]?.diff?.[0]).toMatchObject({ path: "src/a.ts", added: 1, removed: 0 })
  })
})

describe("panel del run", () => {
  test("archivos, tareas de Keel, notas, checklist, modelo, esfuerzo y sugerencia", () => {
    const events = [
      at("sdk.system", { subtype: "init", model: "claude-opus-5-5" }),
      at("hook.PreToolUse", {
        tool_name: "mcp__keel__task_create",
        tool_use_id: "k1",
        tool_input: { title: "Paginar capítulos" },
        effort: { level: "high" },
      }),
      at("hook.PostToolUse", {
        tool_name: "mcp__keel__task_create",
        tool_use_id: "k1",
        tool_response: JSON.stringify({
          id: "w2",
          display_id: "KEEL-15",
          title: "Paginar capítulos",
          lifecycle: "triage",
        }),
      }),
      at("hook.PreToolUse", {
        tool_name: "mcp__keel__note_add",
        tool_use_id: "k2",
        tool_input: { content_markdown: "## SDK regenerado\n\ndetalle" },
      }),
      at("hook.PostToolUse", {
        tool_name: "mcp__keel__note_add",
        tool_use_id: "k2",
        tool_response: "{}",
      }),
      at("hook.PreToolUse", {
        tool_name: "TodoWrite",
        tool_use_id: "t",
        tool_input: {
          todos: [
            { content: "a", status: "completed" },
            { content: "b", status: "pending" },
          ],
        },
      }),
      at("hook.PreToolUse", {
        tool_name: "Write",
        tool_use_id: "w",
        tool_input: { file_path: "/r/b.ts", content: "1\n2" },
      }),
      at("hook.PostToolUse", {
        tool_name: "Write",
        tool_use_id: "w",
        tool_response: { type: "create" },
      }),
      at("sdk.prompt_suggestion", { suggestion: "corre también las pruebas del API" }),
    ]
    const items = buildChat(events)
    const ledger = buildLedger(items, events)
    expect(ledger.model).toBe("claude-opus-5-5")
    expect(ledger.effort).toBe("high")
    expect(ledger.tasks).toMatchObject([{ display_id: "KEEL-15", created: true }])
    expect(ledger.notes.map((n) => n.text)).toEqual(["SDK regenerado"])
    expect(ledger.todos?.length).toBe(2)
    expect(ledger.files).toMatchObject([{ path: "/r/b.ts", added: 2, removed: 0 }])
    expect(ledger.suggestion).toBe("corre también las pruebas del API")
    // Escribir algo invalida la sugerencia.
    const after = [...events, at("run.user_message", { text: "otra cosa" })]
    expect(buildLedger(buildChat(after), after).suggestion).toBeNull()
  })

  test("resultado de una tool de Keel en bloques de texto MCP", () => {
    const t = {
      name: "mcp__keel__task_current",
      state: "done",
      response: [
        {
          type: "text",
          text: JSON.stringify({ item: { id: "w1", display_id: "KEEL-1", title: "x" } }),
        },
      ],
    } as unknown as ToolCall
    expect(keelResult(t)?.item).toMatchObject({ display_id: "KEEL-1" })
  })
})

describe("consultas a bases en el chat", () => {
  const tool = (over: Partial<ToolCall>): ToolCall =>
    ({
      kind: "tool",
      key: "k",
      id: "t",
      name: "mcp__keel__db_query",
      input: {},
      response: undefined,
      error: null,
      state: "done",
      duration_ms: 40,
      started_at: "",
      approval: null,
      diff: null,
      infra: null,
      ...over,
    }) as ToolCall

  test("db_query trae su SQL, su conexión y la tabla de la respuesta MCP", () => {
    const db = dbCall(
      tool({
        input: { connection: "Casa Matte Prod DB", sql: "SELECT id, name FROM layout_templates" },
        response: [
          {
            type: "text",
            text: JSON.stringify(
              {
                operation: "query.read",
                summary: "2 fila(s)",
                columns: ["id", "name"],
                rows: [
                  [1, "grid"],
                  [2, "hero"],
                ],
                row_count: 2,
                truncated: false,
              },
              null,
              2,
            ),
          },
        ],
      }),
    )
    expect(db).toMatchObject({
      connection: "Casa Matte Prod DB",
      sql: "SELECT id, name FROM layout_templates",
      write: false,
      error: null,
      table: { columns: [{ name: "id" }, { name: "name" }], row_count_total: 2 },
    })
    expect(db?.table?.rows).toHaveLength(2)
  })

  test("si la base falla se ve su razón, sin el prefijo del transporte", () => {
    const db = dbCall(
      tool({
        state: "failed",
        input: { connection: "Prod", sql: "SELECT * FROM users WHERE role = 'user'" },
        error:
          'MCP error -32603: query.read en Prod falló: invalid input value for enum user_role: "user"',
      }),
    )
    expect(db?.error).toBe(
      'query.read en Prod falló: invalid input value for enum user_role: "user"',
    )
    expect(db?.table).toBeNull()
  })

  test("db_schema no tiene SQL propio; otras tools no son consultas", () => {
    expect(
      dbCall(tool({ name: "mcp__keel__db_schema", input: { connection: "Prod" } }))?.sql,
    ).toBeNull()
    expect(dbCall(tool({ name: "mcp__keel__note_add" }))).toBeNull()
  })
})

test("etiquetas: modelo, opción recomendada y diff unificado", () => {
  expect(modelLabel("claude-opus-5-5")).toBe("Opus 5.5")
  expect(modelLabel("claude-haiku-4-5-20251001")).toBe("Haiku 4.5")
  expect(modelLabel("opus", [{ value: "opus", display_name: "Opus 5.5" }])).toBe("Opus 5.5")
  expect(optionLabel("Rama + commit (Recommended)")).toEqual({
    text: "Rama + commit",
    recommended: true,
  })
  expect(fromUnified("a", "--- a\n+++ b\n@@ -3 +3,2 @@\n-x\n+y\n+z")).toMatchObject({
    added: 2,
    removed: 1,
  })
})

describe("ADR-0021: el método en el chat", () => {
  test("etapas, documentos, verificación y lo que Keel le dice al agente; el panel resume la etapa", () => {
    const events = [
      at("run.prompt", { text: "Trabaja la tarea", source: "human" }),
      at("task.flow_started", { stage: "brief" }),
      at("task.doc_put", {
        kind: "brief",
        version: 1,
        report: { ok: false, checks: [{ ok: false, msg: "sección «Alcance» con contenido" }] },
      }),
      at("task.doc_put", { kind: "brief", version: 2, report: { ok: true, checks: [] } }),
      at("task.stage_changed", {
        from: "brief",
        to: "implement",
        ceremony: "direct",
        delegated: true,
      }),
      at("run.prompt", { text: "La tarea pasó a implement.", source: "keel" }),
      at("verify.completed", {
        baseline: false,
        results: [{ name: "test", ok: true, duration_ms: 1200, tail: "" }],
        delta: { green: true, newRed: [], stillRed: [], fixed: ["test"] },
      }),
      at("hook.PreToolUse", {
        tool_name: "mcp__keel__stage_advance",
        tool_use_id: "m1",
        tool_input: {},
      }),
    ]
    const chat = buildChat(events)
    expect(chat.map((c) => (c.kind === "method" ? `method:${c.event}` : c.kind))).toEqual([
      "human",
      "method:started",
      "method:doc",
      "method:doc",
      "method:stage",
      "method:keel",
      "method:verify",
      "tool",
    ])
    expect(chat[2]).toMatchObject({ ok: false, missing: ["sección «Alcance» con contenido"] })
    const ledger = buildLedger(chat, events)
    expect(ledger.stage).toEqual({ stage: "implement", ceremony: "direct" })
    expect(ledger.docs).toMatchObject([{ doc: "brief", version: 2, ok: true }])
  })
})

describe("una conversación por turnos", () => {
  test("cada run nuevo es un turno, no un corte; sólo perder el contexto se avisa", () => {
    const items = buildChat([
      at("run.prompt", { text: "Trabaja la tarea", source: "human" }, "r1"),
      at("run.updated", { status: "completed" }, "r1"),
      at("run.prompt", { text: "Elijo B", source: "human" }, "r2"),
      at("run.updated", { status: "completed" }, "r2"),
      at(
        "run.resume_skipped",
        { reason: "el worktree del run anterior ya no existe; el agente empieza una sesión nueva" },
        "r3",
      ),
    ])
    const dividers = items
      .filter((i) => i.kind === "divider")
      .map((i) => (i as { text: string }).text)
    expect(dividers).toHaveLength(2)
    expect(dividers[0]).toMatch(/^Turno 2 · \d\d:\d\d$/)
    expect(items.some((i) => i.kind === "status" && i.text === "Run terminado.")).toBe(false)
    expect(items.at(-1)).toMatchObject({
      kind: "status",
      tone: "warn",
      text: "El agente empezó sin el contexto anterior: el worktree del run anterior ya no existe.",
    })
  })
})

describe("ADR-0044: la sesión de Claude Design en el chat", () => {
  test("encargo, diálogo y diseño publicado; una actualización del mismo diseño no repite", () => {
    const items = buildChat([
      at("design.requested", {
        work_item_id: "w",
        from: "agent",
        brief: "Tarjeta con descuento\nmás",
      }),
      at("design.session.waiting_human", { work_item_id: "w", prompt: "trust" }),
      at("design.published", {
        work_item_id: "w",
        url: "https://claude.ai/artifact/X",
        title: "Tarjeta",
        updated: false,
      }),
      at("design.published", {
        work_item_id: "w",
        url: "https://claude.ai/artifact/X",
        title: "Tarjeta",
        updated: true,
      }),
    ])
    expect(items.map((i) => ("text" in i ? i.text : ""))).toEqual([
      "El agente encargó a Claude Design: Tarjeta con descuento",
      "Claude Design espera que confíes en la carpeta: contéstalo en su terminal",
      "Claude Design publicó «Tarjeta»: https://claude.ai/artifact/X",
    ])
  })
})
