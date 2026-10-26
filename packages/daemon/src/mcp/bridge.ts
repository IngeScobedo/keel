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
import {
  CEREMONIES,
  LifecycleSchema,
  PrioritySchema,
  RunPurposeSchema,
  STAGES,
  TASK_DOC_KINDS,
} from "@keel/core"
import { z } from "zod"
import { IpcClient } from "../ipc/client.js"
import { agentDoorPath, defaultEndpoint } from "../ipc/endpoint.js"
import { type McpResources, type McpTool, serveMcp } from "./stdio-server.js"

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
      "Crea una tarea nueva en triage con lo que encontraste: título, tipo, prioridad (urgent para un issue de seguridad) y en context_markdown los archivos, la evidencia y por qué importa. Queda ligada a la tarea de esta sesión; un humano decide si se trabaja.",
      z.object({
        title: z.string().min(1),
        kind: z.enum(KINDS).default("chore"),
        priority: PrioritySchema.default("medium"),
        context_markdown: z.string().optional(),
        /** Nombre anterior de `context_markdown`; se mantiene por compatibilidad. */
        spec_markdown: z.string().optional(),
      }),
      ({ context_markdown, spec_markdown, ...a }) =>
        client.call("work_items.create", {
          ...mutation(),
          ...a,
          ...((context_markdown ?? spec_markdown)
            ? { spec_markdown: context_markdown ?? spec_markdown }
            : {}),
        }),
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
      "evidence_attach",
      "Adjunta como evidencia de tu tarea un archivo de tu worktree (resultado de pruebas, captura, diff, log). Queda con su hash y su procedencia.",
      z.object({
        path: z.string().min(1),
        kind: z.enum([
          "sql_result",
          "screenshot",
          "diff",
          "test_report",
          "chart",
          "document",
          "log",
        ]),
        title: z.string().max(200).optional(),
      }),
      (a) => client.call("evidence.attach", { ...mutation(), ...a }),
    ),
    tool(
      "git_status",
      "Estado del worktree de tu run: rama, HEAD y archivos cambiados con sus líneas.",
      z.object({}),
      () => client.call("git.status", {}),
    ),
    tool(
      "git_diff",
      "Diff de tu worktree respecto de HEAD, opcionalmente de algunos archivos.",
      z.object({ paths: z.array(z.string()).optional() }),
      (a) => client.call("git.diff", a),
    ),
    tool(
      "git_propose",
      "Propone confirmar cambios (y, si quieres, empujar la rama y abrir una PR) como un plan que el humano aprueba. No ejecuta nada: devuelve el plan_id; consúltalo con git_plan_status. Nunca empuja a una rama protegida ni con force.",
      z.object({
        message: z.string().min(1),
        paths: z.array(z.string()).optional(),
        push: z.object({ remote: z.string().optional(), branch: z.string().optional() }).optional(),
        pr: z
          .object({ base: z.string().optional(), title: z.string(), body: z.string().optional() })
          .optional(),
      }),
      (a) => client.call("git.propose", { ...mutation(), ...a }),
    ),
    tool(
      "git_plan_status",
      "Estado de un plan de git: pendiente, ejecutándose, completado (con sha, push y PR) o caducado con su motivo.",
      z.object({ plan_id: z.string() }),
      (a) => client.call("git.plan_status", a),
    ),
    // --- el método (ADR-0021): Keel valida y verifica; el agente recibe lo justo ---
    tool(
      "stage_current",
      "Etapa del método en que está tu tarea (brief, design, implement, review, close), su ceremonia, si hay un gate esperando al humano y el baseline de la verificación.",
      z.object({}),
      async (_a, b) =>
        ((await client.call("tasks.flow", { work_item_id: linkedTask(b) })) as { flow: unknown })
          .flow,
    ),
    tool(
      "stage_advance",
      "Avanza tu tarea a la siguiente etapa del método. Keel valida la transición y los documentos que exige; si falta algo te dice exactamente qué. Al cerrar el brief declara ceremony: direct (trabajo directo) o formal (toca contrato o invariante, dos responsables en paralelo o módulo grande sin SDD), con reason en una frase. Si la transición tiene gate, queda esperando al humano: termina tu turno con un resumen.",
      z.object({
        to: z.enum(STAGES),
        ceremony: z.enum(CEREMONIES).optional(),
        reason: z.string().max(4_000).optional(),
      }),
      async (a, b) => {
        const r = (await client.call("stages.advance", {
          ...mutation(),
          work_item_id: linkedTask(b),
          ...a,
        })) as { flow: { stage: string }; gate: { gate: string } | null }
        return r.gate
          ? `Gate «${r.gate.gate}» pedido al humano. Termina tu turno con un resumen breve; Keel te avisa cuando decida.`
          : `Etapa: ${r.flow.stage}.`
      },
    ),
    tool(
      "task_doc_put",
      "Guarda una versión nueva de un documento de tu tarea (brief, spec, design, tasks, story, qa) en Keel, no en el repo. Devuelve la validación del método: lo que falta para avanzar.",
      z.object({ kind: z.enum(TASK_DOC_KINDS), content_markdown: z.string().min(1) }),
      async (a, b) => {
        const d = (await client.call("task_docs.put", {
          ...mutation(),
          work_item_id: linkedTask(b),
          ...a,
        })) as {
          version: number
          report: { ok: boolean; checks: { ok: boolean; msg: string; detail?: string }[] }
        }
        const missing = d.report.checks.filter((c) => !c.ok)
        return missing.length
          ? `Guardado ${a.kind} v${d.version}. Falta: ${missing.map((c) => `${c.msg}${c.detail ? ` (${c.detail})` : ""}`).join("; ")}.`
          : `Guardado ${a.kind} v${d.version}. Valida.`
      },
    ),
    tool(
      "task_doc_get",
      "Lee un documento de tu tarea (la última versión, o una concreta).",
      z.object({ kind: z.enum(TASK_DOC_KINDS), version: z.number().int().positive().optional() }),
      async (a, b) => {
        const r = (await client.call("task_docs.get", { work_item_id: linkedTask(b), ...a })) as {
          doc: { content_markdown?: string; version: number } | null
        }
        return r.doc ? r.doc.content_markdown : `No hay ${a.kind} todavía.`
      },
    ),
    tool(
      "task_docs_list",
      "Qué documentos tiene tu tarea, su versión y si validan.",
      z.object({}),
      async (_a, b) => {
        const r = (await client.call("task_docs.list", { work_item_id: linkedTask(b) })) as {
          docs: { kind: string; version: number; report: { ok: boolean } }[]
        }
        return r.docs.map((d) => `${d.kind} v${d.version} ${d.report.ok ? "valida" : "no valida"}`)
      },
    ),
    tool(
      "verify_run",
      "Keel corre la verificación del proyecto (lint, typecheck, test, build según el perfil) en tu worktree y devuelve sólo el delta contra el baseline y las últimas líneas de lo que falló. No corras esos comandos tú.",
      z.object({}),
      async (_a, b) => {
        const r = (await client.call("verify.run", {
          ...mutation(),
          work_item_id: linkedTask(b),
        })) as {
          results: { name: string; ok: boolean; duration_ms: number; tail: string }[]
          delta: { green: boolean; newRed: string[]; stillRed: string[]; fixed: string[] }
          baseline: boolean
        }
        if (r.results.length === 0)
          return "El proyecto no tiene comandos de verificación en su perfil."
        return {
          green: r.delta.green,
          new_red: r.delta.newRed,
          already_red: r.delta.stillRed,
          fixed: r.delta.fixed,
          baseline: r.baseline,
          // Sólo lo que falló trae salida: lo verde no gasta contexto.
          checks: r.results.map((c) =>
            c.ok
              ? { name: c.name, ok: true, seconds: Math.round(c.duration_ms / 1000) }
              : {
                  name: c.name,
                  ok: false,
                  seconds: Math.round(c.duration_ms / 1000),
                  tail: c.tail,
                },
          ),
        }
      },
    ),
    tool(
      "project_profile",
      "Perfil del proyecto según Keel: stack, comandos de verificación, ramas protegidas y prefijos, rutas generadas, dónde vive su canon (ADR, SDD, roadmap) e invariantes.",
      z.object({}),
      async () => ((await client.call("projects.profile_get", {})) as { profile: unknown }).profile,
    ),
    tool(
      "context_search",
      "Busca en el proyecto de Keel (tareas, notas, evidencia, investigaciones). Devuelve fragmentos y referencias keel:// que puedes leer como recurso; dice si la búsqueda es léxica.",
      z.object({
        query: z.string().min(1),
        scopes: z.array(z.enum(["tasks", "notes", "evidence", "research"])).optional(),
        limit: z.number().int().positive().max(50).optional(),
      }),
      (a) => client.call("context.search", a),
    ),
    tool(
      "resources_list",
      "Conexiones del proyecto (bases de datos, SSH, Terraform) con sus operaciones, su política (auto, ask, deny) y qué garantiza el servidor. Nunca credenciales.",
      z.object({}),
      () => client.call("resources.list", {}),
    ),
    tool(
      "db_schema",
      "Esquema de una base de datos del proyecto (tablas y columnas).",
      z.object({ connection: z.string() }),
      (a) =>
        client.call("resources.execute", {
          ...mutation(),
          connection: a.connection,
          operation: "schema.read",
          input: {},
        }),
    ),
    tool(
      "db_query",
      "Ejecuta SQL en una base del proyecto. Por defecto es lectura (transacción de sólo lectura, la base rechaza escribir); write: true pide la operación de escritura, que puede requerir aprobación. Keel ejecuta con la credencial y guarda el resultado como evidencia.",
      z.object({
        connection: z.string(),
        sql: z.string().min(1),
        params: z.array(z.unknown()).optional(),
        write: z.boolean().optional(),
      }),
      (a) =>
        client.call("resources.execute", {
          ...mutation(),
          connection: a.connection,
          operation: a.write ? "query.write" : "query.read",
          input: { sql: a.sql, ...(a.params ? { params: a.params } : {}) },
        }),
    ),
    tool(
      "ssh_run",
      "Ejecuta un comando en un servidor del proyecto por SSH (con las llaves del usuario, nunca expuestas). Puede requerir aprobación.",
      z.object({ connection: z.string(), command: z.string().min(1) }),
      (a) =>
        client.call("resources.execute", {
          ...mutation(),
          connection: a.connection,
          operation: "command.run",
          input: { command: a.command },
        }),
    ),
    tool(
      "iac_plan",
      "Planea Terraform en una conexión del proyecto. Devuelve plan_sha256: sólo ese plan se podrá aplicar.",
      z.object({ connection: z.string() }),
      (a) =>
        client.call("resources.execute", {
          ...mutation(),
          connection: a.connection,
          operation: "iac.plan",
          input: {},
        }),
    ),
    tool(
      "iac_apply",
      "Aplica un plan de Terraform ya planeado, por su plan_sha256. Requiere aprobación; si el plan cambió, se rechaza.",
      z.object({ connection: z.string(), plan_sha256: z.string() }),
      (a) =>
        client.call("resources.execute", {
          ...mutation(),
          connection: a.connection,
          operation: "iac.apply",
          input: { plan_sha256: a.plan_sha256 },
        }),
    ),
    tool(
      "research_hypothesis_add",
      "Registra una hipótesis en la investigación de tu tarea. Sólo un humano la verifica o refuta.",
      z.object({ statement: z.string().min(1) }),
      (a) =>
        client.call("research.claim_add", {
          ...mutation(),
          kind: "hypothesis",
          statement: a.statement,
        }),
    ),
    tool(
      "research_finding_add",
      "Registra un hallazgo citando evidencia (ids de evidence_attach o de resultados de db_query). Sin evidencia queda marcado como «sin evidencia».",
      z.object({ statement: z.string().min(1), evidence_ids: z.array(z.string()).default([]) }),
      (a) =>
        client.call("research.claim_add", {
          ...mutation(),
          kind: "finding",
          statement: a.statement,
          evidence_ids: a.evidence_ids,
        }),
    ),
    tool(
      "research_conclusion_propose",
      "Propone una conclusión. Queda como propuesta hasta que un humano la verifique.",
      z.object({ statement: z.string().min(1), evidence_ids: z.array(z.string()).default([]) }),
      (a) =>
        client.call("research.claim_add", {
          ...mutation(),
          kind: "conclusion",
          statement: a.statement,
          evidence_ids: a.evidence_ids,
        }),
    ),
    tool(
      "research_claims",
      "Las hipótesis, hallazgos y conclusiones de la investigación de tu tarea, con su estado.",
      z.object({}),
      () => client.call("research.claims_list", {}),
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

type TaskDetail = {
  item: { id: string; display_id: string; title: string; lifecycle: string }
  spec_markdown: string
  notes: { author: string; content_markdown: string; created_at: string }[]
}

/**
 * Recursos MCP de ADR-0017: el contexto se pide. `keel://task/current` sale
 * del vínculo (del run o del emparejamiento), nunca de suponer una tarea activa.
 */
export function keelResources(client: IpcClient, binding: () => Promise<Binding>): McpResources {
  const task = async (id: string): Promise<string> => {
    const d = await client.call<TaskDetail>("work_items.get", { work_item_id: id })
    const ev = await client
      .call<{
        evidence: { kind: string; title: string | null; sha256: string; created_by: string }[]
      }>("evidence.list", { work_item_id: id })
      .catch(() => ({ evidence: [] }))
    return [
      `# ${d.item.display_id} · ${d.item.title}`,
      `Estado: ${d.item.lifecycle} · id ${d.item.id}`,
      "",
      "## Especificación",
      d.spec_markdown || "(sin especificación)",
      "",
      "## Notas",
      ...(d.notes.length
        ? d.notes.map((n) => `- ${n.author} (${n.created_at}): ${n.content_markdown}`)
        : ["(sin notas)"]),
      "",
      "## Evidencia",
      ...(ev.evidence.length
        ? ev.evidence.map(
            (e) =>
              `- ${e.kind} · ${e.title ?? "sin título"} · sha256 ${e.sha256.slice(0, 16)} · ${e.created_by}`,
          )
        : ["(sin evidencia)"]),
    ].join("\n")
  }
  return {
    async list() {
      const b = await binding()
      return [
        ...(b.work_item_id
          ? [
              {
                uri: "keel://task/current",
                name: "Tarea vinculada",
                description: "La tarea de esta sesión: especificación, notas, evidencia y estado.",
                mimeType: "text/markdown",
              },
            ]
          : []),
        {
          uri: "keel://project/context",
          name: "Contexto del proyecto",
          description: "Documentos de always_read y la lista de ADRs del proyecto.",
          mimeType: "text/markdown",
        },
      ]
    },
    templates: [
      {
        uriTemplate: "keel://task/{id}",
        name: "Tarea",
        description: "Una tarea del proyecto vinculado.",
        mimeType: "text/markdown",
      },
    ],
    async read(uri: string) {
      const b = await binding()
      if (uri === "keel://task/current") {
        if (!b.work_item_id) throw new Error("esta sesión no tiene una tarea vinculada")
        return { mimeType: "text/markdown", text: await task(b.work_item_id) }
      }
      const m = /^keel:\/\/task\/([0-9A-Z]{26})$/.exec(uri)
      if (m) return { mimeType: "text/markdown", text: await task(m[1] as string) }
      if (uri === "keel://project/context") {
        const c = await client.call<{
          root: string
          always_read: { path: string; text: string; truncated: boolean }[]
          adrs: { path: string; title: string }[]
        }>("context.project", {})
        return {
          mimeType: "text/markdown",
          text: [
            `# Contexto del proyecto (${c.root})`,
            "",
            "## ADRs",
            ...(c.adrs.length ? c.adrs.map((a) => `- ${a.path}: ${a.title}`) : ["(sin ADRs)"]),
            ...c.always_read.flatMap((d) => [
              "",
              `## ${d.path}${d.truncated ? " (recortado)" : ""}`,
              d.text,
            ]),
          ].join("\n"),
        }
      }
      throw new Error(`recurso desconocido: ${uri}`)
    },
  }
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
      resources: keelResources(client, () => bound),
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
    await serveMcp({
      name: "keel",
      version: BRIDGE_VERSION,
      tools: keelTools(client, current),
      resources: keelResources(client, current),
    })
  }
  client.close()
}
