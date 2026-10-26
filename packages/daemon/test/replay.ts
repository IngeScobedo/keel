/**
 * `queryFn` falso para tests: reproduce los mensajes y hooks grabados por el
 * spike (fixtures redactados) en el orden en que llegaron, invocando los hooks
 * registrados en `options.hooks` igual que lo haría el SDK.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { HookCallback, Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import { type Daemon, IpcClient, type QueryFn } from "../src/index.ts"

type Entry =
  | { at: string; kind: "message"; message: Record<string, unknown> }
  | {
      at: string
      kind: "hook"
      name: string
      input: Record<string, unknown>
      toolUseId: string | undefined
    }

export function loadRecordedRun(): Entry[] {
  const dir = join(import.meta.dir, "fixtures")
  const entries: Entry[] = []
  for (const line of readFileSync(join(dir, "claude-run-messages.ndjson"), "utf8").split("\n")) {
    if (!line.trim()) continue
    const m = JSON.parse(line) as Record<string, unknown>
    entries.push({ at: String(m.received_at), kind: "message", message: m })
  }
  for (const line of readFileSync(join(dir, "claude-run-hooks.ndjson"), "utf8").split("\n")) {
    if (!line.trim()) continue
    const h = JSON.parse(line) as {
      received_at: string
      hook_event_name: string
      tool_use_id: string | null
      input: Record<string, unknown>
    }
    entries.push({
      at: h.received_at,
      kind: "hook",
      name: h.hook_event_name,
      input: h.input,
      toolUseId: h.tool_use_id ?? undefined,
    })
  }
  return entries.sort((a, b) => a.at.localeCompare(b.at))
}

export function replayQuery(entries: Entry[] = loadRecordedRun()): QueryFn {
  return ({ options }) => replay(entries, options)
}

async function* replay(entries: Entry[], options: Options): AsyncGenerator<SDKMessage> {
  for (const e of entries) {
    if (options.abortController?.signal.aborted)
      throw new Error("Claude Code process aborted by user")
    if (e.kind === "hook") {
      const matchers = options.hooks?.[e.name as keyof NonNullable<Options["hooks"]>] ?? []
      for (const m of matchers)
        for (const cb of m.hooks as HookCallback[])
          await cb(e.input as never, e.toolUseId, { signal: new AbortController().signal })
    } else {
      yield e.message as unknown as SDKMessage
    }
  }
}

/** Un run que arranca y se queda esperando hasta que lo cancelan. */
export function hangingQuery(): QueryFn {
  return ({ options }) =>
    (async function* () {
      yield {
        type: "system",
        subtype: "init",
        session_id: "s-hang",
        model: "haiku",
        uuid: "u-init",
      } as unknown as SDKMessage
      const pre = options.hooks?.PreToolUse ?? []
      for (const m of pre)
        for (const cb of m.hooks as HookCallback[])
          await cb(
            {
              hook_event_name: "PreToolUse",
              session_id: "s-hang",
              transcript_path: "",
              cwd: "",
              tool_name: "Bash",
              tool_input: { command: "sleep 60" },
              tool_use_id: "toolu_hang",
            } as never,
            "toolu_hang",
            { signal: new AbortController().signal },
          )
      await new Promise<void>((resolve) =>
        options.abortController?.signal.addEventListener("abort", () => resolve(), { once: true }),
      )
      throw new Error("Claude Code process aborted by user")
    })()
}

/** El prompt inicial, venga como texto o como la entrada en streaming del adaptador. */
export function firstPrompt(prompt: unknown): string {
  const raw =
    typeof prompt === "string" ? prompt : String((prompt as { first?: string }).first ?? "")
  // Sin el encabezado de Keel (ADR-0017 §1): lo que pidió el humano.
  return raw.startsWith("[Keel]") ? raw.slice(raw.indexOf("\n\n") + 2) : raw
}

/** Un run que pide permiso por `canUseTool` y termina según la decisión. */
export function askingQuery(input: Record<string, unknown> = { command: "rm -rf build" }): QueryFn {
  return ({ options }) =>
    (async function* () {
      yield {
        type: "system",
        subtype: "init",
        session_id: "s-ask",
        model: "haiku",
        uuid: "u-init2",
      } as unknown as SDKMessage
      const decision = await options.canUseTool?.("Bash", input, {
        signal: new AbortController().signal,
        suggestions: [],
      } as never)
      yield {
        type: "result",
        subtype: "success",
        uuid: "u-res2",
        session_id: "s-ask",
        is_error: false,
        result: decision?.behavior ?? "none",
        total_cost_usd: 0.001,
        usage: { input_tokens: 10, output_tokens: 5 },
      } as unknown as SDKMessage
    })()
}

/**
 * Un run de Claude guionado para las pruebas de la GUI (ADR-0020): explora,
 * edita con diff, actualiza su checklist, crea una tarea de Keel, pregunta con
 * `AskUserQuestion`, pide permiso para dos comandos y deja una sugerencia. La
 * respuesta a la pregunta vuelve en el texto del agente.
 */
export function chatQuery(): QueryFn {
  return ({ options }) => {
    const signal = new AbortController().signal
    const session = "s-chat"
    let n = 0
    const hook = async (name: string, input: Record<string, unknown>, id: string) => {
      for (const m of options.hooks?.[name as keyof NonNullable<Options["hooks"]>] ?? [])
        for (const cb of m.hooks as HookCallback[])
          await cb(
            {
              hook_event_name: name,
              session_id: session,
              transcript_path: "",
              cwd: options.cwd ?? "",
              permission_mode: "default",
              effort: { level: "high" },
              tool_use_id: id,
              ...input,
            } as never,
            id,
            { signal },
          )
    }
    /** Una herramienta que no pide permiso: PreToolUse y PostToolUse. */
    const tool = async (tool_name: string, tool_input: unknown, tool_response: unknown) => {
      const id = `toolu_chat_${++n}`
      await hook("PreToolUse", { tool_name, tool_input }, id)
      await hook("PostToolUse", { tool_name, tool_input, tool_response, duration_ms: 40 * n }, id)
    }
    /** Una herramienta que pasa por `canUseTool`; devuelve la decisión. */
    const asked = async (tool_name: string, tool_input: Record<string, unknown>, out: unknown) => {
      const id = `toolu_chat_${++n}`
      await hook("PreToolUse", { tool_name, tool_input }, id)
      const d = await options.canUseTool?.(tool_name, tool_input, {
        signal,
        suggestions: [],
        toolUseID: id,
      } as never)
      const input = d?.behavior === "allow" ? (d.updatedInput ?? tool_input) : tool_input
      if (d?.behavior === "allow")
        await hook(
          "PostToolUse",
          { tool_name, tool_input: input, tool_response: out, duration_ms: 4100 },
          id,
        )
      else
        await hook(
          "PostToolUseFailure",
          { tool_name, tool_input, error: d?.message ?? "negado" },
          id,
        )
      return { decision: d, input }
    }
    const say = (text: string) =>
      ({
        type: "assistant",
        uuid: `u-chat-${++n}`,
        session_id: session,
        parent_tool_use_id: null,
        message: { role: "assistant", content: [{ type: "text", text }] },
      }) as unknown as SDKMessage
    const control = {
      setPermissionMode: async () => {},
      setModel: async () => {},
      applyFlagSettings: async () => {},
    }
    const run = (async function* () {
      yield {
        type: "system",
        subtype: "init",
        session_id: session,
        model: "claude-opus-5-5",
        uuid: "u-chat-init",
      } as unknown as SDKMessage
      yield say("Voy a ver cómo llega **photos** desde el API y replicarlo para `chapters`.")
      await tool(
        "Read",
        { file_path: "apps/api/src/projects/project.dto.ts" },
        {
          type: "text",
          file: {
            filePath: "apps/api/src/projects/project.dto.ts",
            content: "export type ProjectDto = {\n  photos: Photo[]\n}",
            numLines: 3,
            startLine: 1,
            totalLines: 3,
          },
        },
      )
      await tool(
        "Grep",
        { pattern: "chapters", path: "apps" },
        { mode: "files_with_matches", numFiles: 2, filenames: ["a.ts", "b.ts"] },
      )
      await tool(
        "Read",
        { file_path: "apps/backoffice/src/pages/DesignProjectDetailPage.tsx" },
        {
          type: "text",
          file: {
            filePath: "apps/backoffice/src/pages/DesignProjectDetailPage.tsx",
            content: "export function Page() {}",
            numLines: 1,
            startLine: 1,
            totalLines: 1,
          },
        },
      )
      await tool(
        "Edit",
        {
          file_path: "apps/backoffice/src/pages/DesignProjectDetailPage.spec.tsx",
          old_string: "  photos: [],",
          new_string: "  photos: [],\n  chapters: [],\n  chapterCount: 0,",
        },
        {
          filePath: "apps/backoffice/src/pages/DesignProjectDetailPage.spec.tsx",
          structuredPatch: [
            {
              oldStart: 31,
              oldLines: 4,
              newStart: 31,
              newLines: 6,
              lines: [
                "   name: 'Boda Ana y Luis',",
                "   status: 'design',",
                "   photos: [],",
                "+  chapters: [],",
                "+  chapterCount: 0,",
                "   createdAt: APPROVED,",
              ],
            },
          ],
        },
      )
      await tool(
        "TodoWrite",
        {
          todos: [
            { content: "Leer el DTO", status: "completed", activeForm: "Leyendo el DTO" },
            {
              content: "Agregar chapters al spec",
              status: "completed",
              activeForm: "Agregando chapters",
            },
            {
              content: "Regenerar el SDK y correr las pruebas",
              status: "in_progress",
              activeForm: "Regenerando el SDK y corriendo las pruebas",
            },
            {
              content: "Proponer el commit",
              status: "pending",
              activeForm: "Proponiendo el commit",
            },
          ],
        },
        { oldTodos: [], newTodos: [] },
      )
      await tool(
        "mcp__keel__task_create",
        { title: "Paginar capítulos en el detalle", kind: "feature" },
        JSON.stringify({
          id: "w-chat",
          display_id: "KEEL-9",
          title: "Paginar capítulos en el detalle",
          kind: "feature",
          lifecycle: "triage",
        }),
      )
      yield say("El API ya devuelve chapters. Antes de tocar la vista necesito una decisión:")
      const q = "¿Cómo cargo los capítulos cuando un proyecto tiene muchos?"
      const answer = await asked(
        "AskUserQuestion",
        {
          questions: [
            {
              question: q,
              header: "Paginación",
              multiSelect: false,
              options: [
                {
                  label: "Todos de una vez",
                  description: "Simple; lento con más de 200 capítulos.",
                },
                {
                  label: "Paginado de 50 en 50 (Recommended)",
                  description: "Un endpoint con cursor; la vista pide más al hacer scroll.",
                },
                {
                  label: "Sólo los primeros 10",
                  description: "Con un enlace «ver todos» a otra pantalla.",
                },
              ],
            },
          ],
        },
        { questions: [] },
      )
      const chosen = (answer.input as { answers?: Record<string, string> }).answers?.[q]
      yield say(
        chosen
          ? `Elegiste «${chosen}». Compilo el API para regenerar el SDK.`
          : "No contestaste; sigo con lo más simple.",
      )
      await asked(
        "Bash",
        { command: "bun run build", description: "Compila el API" },
        { stdout: "built in 4.1s", stderr: "" },
      )
      await asked(
        "Bash",
        { command: "bun run test", description: "Corre las pruebas del backoffice" },
        { stdout: "38 pass\n0 fail", stderr: "" },
      )
      yield say("Listo: el SDK está regenerado y las 38 pruebas del backoffice pasan.")
      yield {
        type: "result",
        subtype: "success",
        uuid: "u-chat-res",
        session_id: session,
        is_error: false,
        result: "Listo: el SDK está regenerado y las 38 pruebas del backoffice pasan.",
        total_cost_usd: 0.42,
        usage: { input_tokens: 1200, output_tokens: 300 },
      } as unknown as SDKMessage
      yield {
        type: "prompt_suggestion",
        suggestion: "corre también las pruebas del API",
        uuid: "u-chat-sug",
        session_id: session,
      } as unknown as SDKMessage
    })()
    return Object.assign(run, control) as never
  }
}

/**
 * Un agente que sigue el método de Keel (ADR-0021) para las pruebas de la GUI:
 * en cada run mira la etapa de su tarea y hace lo que toca, hablando con el
 * daemon por la puerta de agentes con el token de su run, como el puente MCP.
 * Ciclo formal: brief → gate (a) → diseño → gate (b) → implementar, revisar y
 * cerrar.
 */
export function methodQuery(daemon: Daemon): QueryFn {
  return ({ options }) => {
    const runId = String((options.env as Record<string, string>).KEEL_RUN_ID)
    const session = `s-method-${runId}`
    let n = 0
    const say = (text: string) =>
      ({
        type: "assistant",
        uuid: `u-m-${runId}-${++n}`,
        session_id: session,
        parent_tool_use_id: null,
        message: { role: "assistant", content: [{ type: "text", text }] },
      }) as unknown as SDKMessage
    const run = (async function* () {
      const row = daemon.repo.getRun(runId)
      if (!row) return
      const { file } = daemon.agentTokens.issue({
        run_id: runId,
        project_id: row.project_id,
        work_item_id: row.work_item_id,
      })
      const agent = await IpcClient.connect(daemon.agentServer.path)
      await agent.call("session.bind_agent", { token: readFileSync(file, "utf8") })
      let k = 0
      const m = () => ({ request_id: "r", idempotency_key: `${runId}-${++k}` })
      const w = row.work_item_id
      const put = (kind: string, content_markdown: string) =>
        agent.call("task_docs.put", { ...m(), work_item_id: w, kind, content_markdown })
      const advance = (to: string, extra: Record<string, unknown> = {}) =>
        agent.call("stages.advance", { ...m(), work_item_id: w, to, ...extra })
      yield {
        type: "system",
        subtype: "init",
        session_id: session,
        model: "claude-opus-5-5",
        uuid: `u-m-init-${runId}`,
      } as unknown as SDKMessage
      const stage = daemon.repo.getFlow(w)?.stage
      if (stage === "brief") {
        yield say("Leí el repo: el detalle no pide capítulos. Escribo el brief.")
        await put(
          "brief",
          "# Brief\n## Problema\nEl detalle no muestra capítulos.\n## Alcance\nMostrarlos en el detalle.\n## Fuera de alcance\nLa tienda.\n## Criterios de aceptación\n- se ven los capítulos\n",
        )
        await advance("design", { ceremony: "formal", reason: "cambia el contrato del detalle" })
        yield say("Toca el contrato del detalle: es ciclo formal. Te pido aprobar el brief.")
      } else if (stage === "design") {
        await put(
          "spec",
          "## Requisitos\n### R1 — Capítulos visibles\n#### Escenario: con capítulos\n- **Dado** un proyecto con capítulos\n- **Cuando** abro el detalle\n- **Entonces** los veo\n",
        )
        await put(
          "design",
          "## Contrato congelado\n`GET /projects/:id` devuelve `chapters: Chapter[]`.\n## Fronteras de archivos\n| responsable | archivos |\n| --- | --- |\n| backend | `api/**` |\n",
        )
        await advance("implement")
        yield say("Spec y diseño listos. Te pido congelar el contrato.")
      } else if (stage === "implement") {
        writeFileSync(join(String(options.cwd), "chapters.txt"), "capítulos\n")
        yield say("Implementado contra el contrato.")
        await advance("review")
        await put("qa", "## Veredicto: PASS\n## Evidencia\n- el escenario R1 se cumple\n")
        await advance("close")
        yield say("Revisión PASS. Queda el cierre.")
      }
      agent.close()
      yield {
        type: "result",
        subtype: "success",
        uuid: `u-m-res-${runId}`,
        session_id: session,
        is_error: false,
        result: "ok",
        total_cost_usd: 0.01,
        usage: { input_tokens: 10, output_tokens: 10 },
      } as unknown as SDKMessage
    })()
    return Object.assign(run, {
      setPermissionMode: async () => {},
      setModel: async () => {},
      applyFlagSettings: async () => {},
    }) as never
  }
}

/**
 * ADR-0024: el agente de la conversación del proyecto. Explora, responde y, como
 * encontró un issue de seguridad, crea una tarea urgente por la puerta de agentes;
 * los hooks dejan la tarjeta en el chat igual que el SDK real.
 */
export function conversationQuery(daemon: Daemon): QueryFn {
  return ({ options }) => {
    const runId = String((options.env as Record<string, string>).KEEL_RUN_ID)
    const session = `s-conv-${runId}`
    const signal = new AbortController().signal
    let n = 0
    const hook = async (name: string, input: Record<string, unknown>, id: string) => {
      for (const m of options.hooks?.[name as keyof NonNullable<Options["hooks"]>] ?? [])
        for (const cb of m.hooks as HookCallback[])
          await cb(
            {
              hook_event_name: name,
              session_id: session,
              transcript_path: "",
              cwd: options.cwd ?? "",
              permission_mode: "plan",
              tool_use_id: id,
              ...input,
            } as never,
            id,
            { signal },
          )
    }
    const tool = async (tool_name: string, tool_input: unknown, tool_response: unknown) => {
      const id = `toolu_conv_${runId}_${++n}`
      await hook("PreToolUse", { tool_name, tool_input }, id)
      await hook("PostToolUse", { tool_name, tool_input, tool_response, duration_ms: 30 }, id)
    }
    const say = (text: string) =>
      ({
        type: "assistant",
        uuid: `u-conv-${runId}-${++n}`,
        session_id: session,
        parent_tool_use_id: null,
        message: { role: "assistant", content: [{ type: "text", text }] },
      }) as unknown as SDKMessage
    const run = (async function* () {
      const row = daemon.repo.getRun(runId)
      if (!row) return
      yield {
        type: "system",
        subtype: "init",
        session_id: session,
        model: "claude-sonnet-5-5",
        uuid: `u-conv-init-${runId}`,
      } as unknown as SDKMessage
      await tool(
        "Grep",
        { pattern: "requireRoles", path: "orders" },
        { mode: "files_with_matches", numFiles: 1, filenames: ["orders/list.ts"] },
      )
      yield say(
        "Exportar pedidos lo hace `orders/export.ts`, y **no pide rol**: cualquier sesión puede exportar. Lo dejo como tarea urgente.",
      )
      const { file } = daemon.agentTokens.issue({
        run_id: runId,
        project_id: row.project_id,
        work_item_id: row.work_item_id,
      })
      const agent = await IpcClient.connect(daemon.agentServer.path)
      await agent.call("session.bind_agent", { token: readFileSync(file, "utf8") })
      const input = {
        title: "Export de pedidos sin requireRoles",
        kind: "bug",
        priority: "urgent",
        context_markdown: "`orders/export.ts:41` no llama a `requireRoles`.",
      }
      const view = await agent.call("work_items.create", {
        request_id: "r",
        idempotency_key: `conv-${runId}`,
        title: input.title,
        kind: input.kind,
        priority: input.priority,
        spec_markdown: input.context_markdown,
      })
      agent.close()
      await tool("mcp__keel__task_create", input, JSON.stringify(view))
      yield {
        type: "result",
        subtype: "success",
        uuid: `u-conv-res-${runId}`,
        session_id: session,
        is_error: false,
        result: "ok",
        total_cost_usd: 0.004,
        usage: { input_tokens: 10, output_tokens: 10 },
      } as unknown as SDKMessage
    })()
    return Object.assign(run, {
      setPermissionMode: async () => {},
      setModel: async () => {},
      applyFlagSettings: async () => {},
    }) as never
  }
}

/**
 * ADR-0022: el agente de una feature. En el padre escribe brief, spec, diseño y el plan
 * (dos fases); en cada subtarea implementa en su frontera, revisa, verifica y propone
 * sólo el commit, que Keel integra a la rama de la feature.
 */
export function featureQuery(daemon: Daemon): QueryFn {
  return ({ options }) => {
    const runId = String((options.env as Record<string, string>).KEEL_RUN_ID)
    const session = `s-feature-${runId}`
    let n = 0
    const say = (text: string) =>
      ({
        type: "assistant",
        uuid: `u-f-${runId}-${++n}`,
        session_id: session,
        parent_tool_use_id: null,
        message: { role: "assistant", content: [{ type: "text", text }] },
      }) as unknown as SDKMessage
    const run = (async function* () {
      const row = daemon.repo.getRun(runId)
      if (!row) return
      const { file } = daemon.agentTokens.issue({
        run_id: runId,
        project_id: row.project_id,
        work_item_id: row.work_item_id,
      })
      const agent = await IpcClient.connect(daemon.agentServer.path)
      await agent.call("session.bind_agent", { token: readFileSync(file, "utf8") })
      let k = 0
      const m = () => ({ request_id: "r", idempotency_key: `${runId}-${++k}` })
      const w = row.work_item_id
      const put = (kind: string, content_markdown: string) =>
        agent.call("task_docs.put", { ...m(), work_item_id: w, kind, content_markdown })
      const advance = (to: string, extra: Record<string, unknown> = {}) =>
        agent.call("stages.advance", { ...m(), work_item_id: w, to, ...extra })
      yield {
        type: "system",
        subtype: "init",
        session_id: session,
        model: "claude-opus-5-5",
        uuid: `u-f-init-${runId}`,
      } as unknown as SDKMessage
      const flow = daemon.repo.getFlow(w)
      const sub = flow?.subtask_json
        ? (JSON.parse(flow.subtask_json) as { key: string; frontier: string[] })
        : null
      if (flow?.stage === "brief") {
        await put(
          "brief",
          "# Brief\n## Problema\nEl diseñador no ve los capítulos.\n## Alcance\nAPI y backoffice.\n## Fuera de alcance\nLa tienda.\n## Criterios de aceptación\n- se ven los capítulos\n",
        )
        await advance("design", { ceremony: "formal", reason: "toca API y backoffice" })
        yield say("Es una feature de dos capas: ciclo formal. Te pido aprobar el brief.")
      } else if (flow?.stage === "design") {
        await put(
          "spec",
          "## Requisitos\n### R1 — Capítulos en el API\n#### Escenario: lista\n- **Dado** un proyecto con capítulos\n- **Cuando** pido el detalle\n- **Entonces** vienen\n### R2 — Capítulos en el backoffice\n#### Escenario: agrupado\n- **Dado** fotos con capítulo\n- **Cuando** abro el detalle\n- **Entonces** se agrupan\n",
        )
        await put(
          "design",
          "## Contrato congelado\n`GET /projects/:id` devuelve `chapters: Chapter[]`.\n## Fronteras de archivos\n| responsable | archivos |\n| --- | --- |\n| backend | `api/**` |\n| frontend | `web/**` |\n",
        )
        await put(
          "tasks",
          "## Fase 1 — API\n- [ ] T1 Contrato de capítulos → `api/contract/**` → R1\n- [ ] T2 Repositorio de capítulos → `api/repo/**` → R1\n## Fase 2 — Backoffice\n- [ ] T3 Tarjeta por capítulos → `web/photos/**` → R2\n",
        )
        await advance("implement")
        yield say("Spec, diseño y plan listos: tres subtareas en dos fases.")
      } else if (sub && flow?.stage === "implement") {
        const dir = join(String(options.cwd), (sub.frontier[0] as string).replace("/**", ""))
        mkdirSync(dir, { recursive: true })
        writeFileSync(join(dir, `${sub.key}.ts`), `export const ${sub.key} = true\n`)
        yield say(`${sub.key} implementada en su frontera.`)
        await advance("review")
        await put("qa", "## Veredicto: PASS\n## Evidencia\n- el escenario se cumple\n")
        await agent.call("verify.run", { ...m(), work_item_id: w })
        await advance("close")
        await agent.call("git.propose", { ...m(), message: `${sub.key}: implementada` })
      }
      agent.close()
      yield {
        type: "result",
        subtype: "success",
        uuid: `u-f-res-${runId}`,
        session_id: session,
        is_error: false,
        result: "ok",
        total_cost_usd: 0.01,
        usage: { input_tokens: 10, output_tokens: 10 },
      } as unknown as SDKMessage
    })()
    return Object.assign(run, {
      setPermissionMode: async () => {},
      setModel: async () => {},
      applyFlagSettings: async () => {},
    }) as never
  }
}
