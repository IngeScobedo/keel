/**
 * Probe del Claude Agent SDK. Responde con datos, no con suposiciones, a:
 *
 *  1. ¿Con qué se autentica el SDK si Keel NO toca credenciales y apunta al
 *     `claude` instalado del usuario? (init.apiKeySource)
 *  2. ¿Qué reporta total_cost_usd / modelUsage bajo esa autenticación?
 *  3. ¿Qué identidad de agente llega en mensajes y hooks con un subagente?
 *     (agent_id, parent_tool_use_id, SubagentStart/Stop)
 *
 * Reglas del spike (ADR-0002 de Keel): no lee ~/.claude.json, no implementa
 * login, no pasa API key; si no hay sesión, falla y lo dice.
 *
 * Uso: bun src/claude-probe.ts [--model haiku] [--bundled]
 *   --bundled  usa el binario que trae el SDK en vez del `claude` del PATH.
 */
import { existsSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { type HookCallback, type HookInput, query } from "@anthropic-ai/claude-agent-sdk"
import { now, openCapture, writeReport } from "./capture.js"

const here = dirname(fileURLToPath(import.meta.url))
const args = new Set(process.argv.slice(2))
const modelArg = process.argv.find((a) => a.startsWith("--model="))?.split("=")[1]
const model = modelArg ?? "haiku"

function resolveClaude(): string | undefined {
  if (args.has("--bundled")) return undefined
  const fromEnv = process.env.KEEL_CLAUDE_PATH
  if (fromEnv && existsSync(fromEnv)) return fromEnv
  const candidates = [
    join(process.env.HOME ?? "", ".local/bin/claude"),
    "/usr/local/bin/claude",
    "/usr/bin/claude",
  ]
  return candidates.find((p) => existsSync(p))
}

const claudePath = resolveClaude()
if (!args.has("--bundled") && !claudePath) {
  console.error(
    "No encuentro el binario `claude` del usuario. Instálalo con el instalador oficial o usa --bundled.",
  )
  process.exit(2)
}

const messages = openCapture("claude-messages")
const hooks = openCapture("claude-hooks")

const HOOK_EVENTS = [
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "PostToolBatch",
  "UserPromptSubmit",
  "Stop",
  "StopFailure",
  "SubagentStart",
  "SubagentStop",
  "PreCompact",
  "PostCompact",
  "PermissionRequest",
  "PermissionDenied",
  "SessionStart",
  "SessionEnd",
  "Notification",
  "TaskCreated",
  "TaskCompleted",
] as const

const hookStats: Record<string, { count: number; withAgentId: number; withToolUseId: number }> = {}

const recordHook: HookCallback = async (input: HookInput, toolUseID) => {
  const name = input.hook_event_name
  const base = input as { agent_id?: string; agent_type?: string; prompt_id?: string }
  hookStats[name] ??= { count: 0, withAgentId: 0, withToolUseId: 0 }
  const s = hookStats[name]
  s.count += 1
  if (base.agent_id) s.withAgentId += 1
  if (toolUseID) s.withToolUseId += 1
  hooks.write({ received_at: now(), hook_event_name: name, tool_use_id: toolUseID ?? null, input })
  return {}
}

const hookOptions = Object.fromEntries(HOOK_EVENTS.map((e) => [e, [{ hooks: [recordHook] }]]))

const prompt = [
  "Usa el subagente `lister` para listar los archivos de la carpeta src/ de este directorio.",
  "Cuando vuelva, responde con una sola línea con los nombres separados por coma. No hagas nada más.",
].join(" ")

const env: Record<string, string | undefined> = { ...process.env }
// Keel no inyecta credenciales: si el usuario tiene API key en el entorno, la respetamos y lo reportamos.
const apiKeyInEnv = Boolean(env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN)

const seen = {
  init: null as null | Record<string, unknown>,
  result: null as null | Record<string, unknown>,
  assistantMain: 0,
  assistantWithAgentId: 0,
  agentIds: new Set<string>(),
  parentToolUseIds: new Set<string>(),
  agentToolUseIds: new Map<string, string | null>(), // tool_use.id del Agent -> agent_id del mensaje que lo emitió
  messageTypes: {} as Record<string, number>,
  taskEvents: [] as Record<string, unknown>[],
}

const startedAt = Date.now()
try {
  for await (const message of query({
    prompt,
    options: {
      ...(claudePath ? { pathToClaudeCodeExecutable: claudePath } : {}),
      model,
      cwd: join(here, ".."),
      settingSources: [], // no cargar hooks/settings del usuario: el spike mide el SDK, no la máquina
      maxTurns: 8,
      allowedTools: ["Read", "Glob", "Agent"],
      permissionMode: "default",
      env,
      hooks: hookOptions,
      agents: {
        lister: {
          description: "Lista archivos de un directorio y devuelve sus nombres.",
          prompt:
            "Lista los archivos que te pidan con Glob y devuelve solo los nombres, uno por línea.",
          tools: ["Glob", "Read"],
          model: "haiku",
        },
      },
    },
  })) {
    const m = message as Record<string, unknown> & { type: string }
    seen.messageTypes[m.type] = (seen.messageTypes[m.type] ?? 0) + 1
    messages.write({ received_at: now(), ...m })

    if (m.type === "system" && m.subtype === "init") seen.init = m
    if (m.type === "result") seen.result = m
    if (m.type === "assistant") {
      const agentId = m.agent_id as string | undefined
      const parent = m.parent_tool_use_id as string | null
      if (agentId) {
        seen.assistantWithAgentId += 1
        seen.agentIds.add(agentId)
      } else seen.assistantMain += 1
      if (parent) seen.parentToolUseIds.add(parent)
      const content =
        (m.message as { content?: { type: string; id?: string; name?: string }[] })?.content ?? []
      for (const block of content) {
        if (
          block.type === "tool_use" &&
          (block.name === "Agent" || block.name === "Task") &&
          block.id
        ) {
          seen.agentToolUseIds.set(block.id, agentId ?? null)
        }
      }
    }
    if (typeof m.type === "string" && m.type.startsWith("task_")) seen.taskEvents.push(m)
  }
} catch (err) {
  console.error("La query falló:", err instanceof Error ? err.message : err)
}

const init = seen.init ?? {}
const result = seen.result ?? {}
const report = {
  spike: "claude-agent-sdk",
  ran_at: now(),
  wall_ms: Date.now() - startedAt,
  binary: claudePath ?? "(bundled by SDK)",
  api_key_in_env: apiKeyInEnv,
  init: {
    apiKeySource: init.apiKeySource ?? null,
    claude_code_version: init.claude_code_version ?? null,
    model: init.model ?? null,
    permissionMode: init.permissionMode ?? null,
    agents: init.agents ?? null,
    effort: init.effort ?? null,
  },
  cost: {
    subtype: result.subtype ?? null,
    is_error: result.is_error ?? null,
    num_turns: result.num_turns ?? null,
    duration_ms: result.duration_ms ?? null,
    duration_api_ms: result.duration_api_ms ?? null,
    total_cost_usd: result.total_cost_usd ?? null,
    usage: result.usage ?? null,
    modelUsage: result.modelUsage ?? null,
  },
  identity: {
    message_types: seen.messageTypes,
    assistant_main: seen.assistantMain,
    assistant_with_agent_id: seen.assistantWithAgentId,
    agent_ids: [...seen.agentIds],
    parent_tool_use_ids: [...seen.parentToolUseIds],
    agent_tool_use_blocks: Object.fromEntries(seen.agentToolUseIds),
    parent_derivable:
      [...seen.parentToolUseIds].length > 0 &&
      [...seen.parentToolUseIds].every((id) => seen.agentToolUseIds.has(id)),
    task_events: seen.taskEvents.map((t) => ({
      type: t.type,
      task_id: t.task_id ?? null,
      tool_use_id: t.tool_use_id ?? null,
      description: t.description ?? null,
    })),
  },
  hooks: hookStats,
  captures: { messages: messages.path, hooks: hooks.path },
}

const reportPath = writeReport("claude", report)
console.log(JSON.stringify(report, null, 2))
console.log(`\nreporte: ${reportPath}`)
