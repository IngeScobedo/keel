/**
 * `keel mcp` (ADR-0009): puente stdio entre un agente que habla MCP y el
 * daemon que habla el protocolo de ADR-0005. Las tools son adaptadores de los
 * comandos de dominio; la autoridad la decide el daemon en cada operación.
 *
 * El puente nunca actúa como humano (ADR-0009 §2): antes de responder a
 * `initialize` se vincula con el token de un solo uso del run. Sin token, o si
 * el vínculo falla, sale sin servir nada (falla cerrado). El emparejamiento de
 * sesiones externas (ADR-0009 §4) todavía no está implementado.
 */
import { randomUUID } from "node:crypto"
import { readFileSync, rmSync } from "node:fs"
import { LifecycleSchema } from "@keel/core"
import { z } from "zod"
import { IpcClient } from "../ipc/client.js"
import { defaultEndpoint } from "../ipc/endpoint.js"
import { type McpTool, serveMcp } from "./stdio-server.js"

export const BRIDGE_VERSION = "0.1.0"

type Binding = { actor_id: string; run_id: string; project_id: string; work_item_id: string }

/** Lee el token y borra el archivo en el acto: un solo uso. */
export function takeToken(file: string): string {
  const token = readFileSync(file, "utf8").trim()
  rmSync(file, { force: true })
  return token
}

export function keelTools(client: IpcClient, binding: Promise<Binding>): McpTool[] {
  const mutation = () => ({ request_id: randomUUID(), idempotency_key: randomUUID() })
  const tool = <S extends z.ZodObject>(
    name: string,
    description: string,
    schema: S,
    run: (args: z.infer<S>, b: Binding) => Promise<unknown>,
  ): McpTool => ({
    name,
    description,
    inputSchema: z.toJSONSchema(schema) as Record<string, unknown>,
    call: async (raw) => run(schema.parse(raw), await binding),
  })
  return [
    tool(
      "task_current",
      "La tarea de Keel en la que trabaja este run: título, estado, especificación y notas.",
      z.object({}),
      (_a, b) => client.call("work_items.get", { work_item_id: b.work_item_id }),
    ),
    tool(
      "tasks_list",
      "Lista las tareas del proyecto de Keel de este run, opcionalmente filtradas por estado.",
      z.object({
        lifecycle: z.array(LifecycleSchema).optional(),
        limit: z.number().int().positive().max(500).optional(),
      }),
      (a) => client.call("work_items.list", a),
    ),
    tool(
      "task_get",
      "Detalle de una tarea del proyecto: especificación y notas.",
      z.object({ work_item_id: z.string() }),
      (a) => client.call("work_items.get", a),
    ),
    tool(
      "task_create",
      "Crea una tarea nueva en triage. Un humano decide si se planifica.",
      z.object({
        title: z.string().min(1),
        kind: z.enum(["feature", "bug", "refactor", "chore", "docs", "research"]).default("chore"),
        spec_markdown: z.string().optional(),
      }),
      (a) => client.call("work_items.create", { ...mutation(), ...a }),
    ),
    tool(
      "note_add",
      "Añade una nota de progreso a la tarea de este run.",
      z.object({ content_markdown: z.string().min(1) }),
      (a, b) =>
        client.call("notes.add", {
          ...mutation(),
          work_item_id: b.work_item_id,
          content_markdown: a.content_markdown,
        }),
    ),
    tool(
      "handoff_request",
      "Pide un handoff: deja una nota en la tarea de este run y crea una tarea en triage con el resumen.",
      z.object({
        title: z.string().min(1),
        summary_markdown: z.string().min(1),
        kind: z.enum(["feature", "bug", "refactor", "chore", "docs", "research"]).optional(),
      }),
      (a) => client.call("handoffs.request", { ...mutation(), ...a }),
    ),
  ]
}

/** Entrada de `keel mcp`. Devuelve cuando el agente cierra stdin. */
export async function runBridge(
  env: Record<string, string | undefined> = process.env,
): Promise<void> {
  const tokenFile = env.KEEL_RUN_TOKEN_FILE
  if (!tokenFile) {
    process.stderr.write(
      "keel mcp: falta KEEL_RUN_TOKEN_FILE. Sin vínculo no se sirve nada; el emparejamiento de sesiones externas aún no está implementado (ADR-0009 §4).\n",
    )
    process.exit(2)
  }
  let token: string
  try {
    token = takeToken(tokenFile)
  } catch (e) {
    process.stderr.write(`keel mcp: no se pudo leer el token: ${(e as Error).message}\n`)
    process.exit(2)
  }
  const client = await IpcClient.connect(env.KEEL_SOCKET ?? defaultEndpoint())
  const binding = client.call<Binding>("session.bind_agent", { token })
  // Si el daemon rechaza el vínculo, `initialize` responde el error y el puente sale.
  binding.catch((e: unknown) => {
    process.stderr.write(`keel mcp: el daemon rechazó el vínculo: ${(e as Error).message}\n`)
  })
  await serveMcp({
    name: "keel",
    version: BRIDGE_VERSION,
    tools: keelTools(client, binding),
    ready: binding,
  })
  client.close()
}
