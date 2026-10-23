/**
 * `keel mcp` (ADR-0009): puente stdio entre un agente que habla MCP y el
 * daemon que habla el protocolo de ADR-0005. Las tools son adaptadores de los
 * comandos de dominio; la autoridad la decide el daemon en cada operación.
 *
 * El puente nunca actúa como humano (ADR-0009 §2). Dos modos:
 * - **Run de Keel** (`KEEL_RUN_TOKEN_FILE`): antes de responder a `initialize`
 *   se vincula con el token de un solo uso del run. Si el vínculo falla,
 *   responde el error y sale sin servir nada.
 * - **Sesión externa** (sin token, §4): pide `session.pair` y responde
 *   `initialize` en el acto. Mientras el humano no apruebe, cada tool le dice al
 *   agente qué código aprobar; el daemon no le deja hacer nada más.
 */
import { randomUUID } from "node:crypto"
import { readFileSync, rmSync } from "node:fs"
import { LifecycleSchema, RunPurposeSchema } from "@keel/core"
import { z } from "zod"
import { IpcClient } from "../ipc/client.js"
import { agentDoorPath, defaultEndpoint } from "../ipc/endpoint.js"
import { type McpTool, serveMcp } from "./stdio-server.js"

export const BRIDGE_VERSION = "0.2.0"

/** Lo que sabe el puente de su vínculo: el run, o el emparejamiento aprobado. */
export type Binding = {
  actor_id: string
  run_id: string | null
  project_id: string
  work_item_id: string | null
}

type Pairing = {
  id: string
  code: string
  state: "pending" | "approved" | "rejected" | "closed"
  project_id: string | null
  work_item_id: string | null
}

const KINDS = ["feature", "bug", "refactor", "chore", "docs", "research"] as const

/** Lee el token y borra el archivo en el acto: un solo uso. */
export function takeToken(file: string): string {
  const token = readFileSync(file, "utf8").trim()
  rmSync(file, { force: true })
  return token
}

export function keelTools(client: IpcClient, binding: () => Promise<Binding>): McpTool[] {
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
    call: async (raw) => run(schema.parse(raw), await binding()),
  })
  const linkedTask = (b: Binding): string => {
    if (!b.work_item_id)
      throw new Error(
        "esta sesión no tiene una tarea vinculada; usa tasks_list o pide al humano que la vincule",
      )
    return b.work_item_id
  }
  return [
    tool(
      "task_current",
      "La tarea de Keel vinculada a esta sesión: título, estado, especificación y notas.",
      z.object({}),
      (_a, b) => client.call("work_items.get", { work_item_id: linkedTask(b) }),
    ),
    tool(
      "tasks_list",
      "Lista las tareas del proyecto de Keel vinculado, opcionalmente filtradas por estado.",
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
        kind: z.enum(KINDS).default("chore"),
        spec_markdown: z.string().optional(),
      }),
      (a) => client.call("work_items.create", { ...mutation(), ...a }),
    ),
    tool(
      "note_add",
      "Añade una nota de progreso a la tarea vinculada.",
      z.object({ content_markdown: z.string().min(1) }),
      (a, b) =>
        client.call("notes.add", {
          ...mutation(),
          work_item_id: linkedTask(b),
          content_markdown: a.content_markdown,
        }),
    ),
    tool(
      "handoff_request",
      "Pide un handoff: deja una nota en la tarea vinculada y crea una tarea en triage con el resumen.",
      z.object({
        title: z.string().min(1),
        summary_markdown: z.string().min(1),
        kind: z.enum(KINDS).optional(),
      }),
      (a) => client.call("handoffs.request", { ...mutation(), ...a }),
    ),
    tool(
      "run_request",
      "Pide que Keel arranque un run sobre una tarea (plan, execute o triage_eval). No lo arranca: un humano lo aprueba.",
      z.object({
        work_item_id: z.string(),
        purpose: RunPurposeSchema,
        reason: z.string().min(1),
        prompt: z.string().optional(),
      }),
      (a) => client.call("runs.request", { ...mutation(), ...a }),
    ),
  ]
}

/** Entrada de `keel mcp`. Devuelve cuando el agente cierra stdin. */
export async function runBridge(
  env: Record<string, string | undefined> = process.env,
): Promise<void> {
  // Por defecto, la puerta de agentes (ADR-0018 §2): el puente nunca entra por la humana.
  const client = await IpcClient.connect(env.KEEL_SOCKET ?? agentDoorPath(defaultEndpoint()))
  const tokenFile = env.KEEL_RUN_TOKEN_FILE
  if (tokenFile) {
    let token: string
    try {
      token = takeToken(tokenFile)
    } catch (e) {
      process.stderr.write(`keel mcp: no se pudo leer el token: ${(e as Error).message}\n`)
      process.exit(2)
    }
    const bound = client.call<Binding>("session.bind_agent", { token })
    // Si el daemon rechaza el vínculo, `initialize` responde el error y el puente sale.
    bound.catch((e: unknown) => {
      process.stderr.write(`keel mcp: el daemon rechazó el vínculo: ${(e as Error).message}\n`)
    })
    await serveMcp({
      name: "keel",
      version: BRIDGE_VERSION,
      tools: keelTools(client, () => bound),
      ready: bound,
    })
  } else {
    const pairing = await client.call<Pairing>("session.pair", {
      client_name: env.KEEL_CLIENT_NAME ?? "agente externo",
      cwd: process.cwd(),
    })
    process.stderr.write(
      `keel mcp: sesión externa pendiente. Código ${pairing.code}; apruébala en Keel con «cli.ts pair-approve ${pairing.id}».\n`,
    )
    const current = async (): Promise<Binding> => {
      const p = await client.call<Pairing>("session.pair_status", {})
      if (p.state === "approved" && p.project_id)
        return {
          actor_id: `agent:ext:${p.id}`,
          run_id: null,
          project_id: p.project_id,
          work_item_id: p.work_item_id,
        }
      if (p.state === "pending")
        throw new Error(
          `Esta sesión aún no está aprobada en Keel. Pide al humano que apruebe el código ${p.code} (cli.ts pair-approve ${p.id}).`,
        )
      throw new Error(
        `El humano ${p.state === "rejected" ? "rechazó" : "cerró"} esta sesión en Keel.`,
      )
    }
    await serveMcp({ name: "keel", version: BRIDGE_VERSION, tools: keelTools(client, current) })
  }
  client.close()
}
