/**
 * Servidor MCP mínimo por stdio: JSON-RPC 2.0, un mensaje por línea. Cubre lo
 * que usa `keel mcp` (ADR-0009): `initialize`, `ping`, `tools/list` y
 * `tools/call`. Se escribe a mano para no sumar una dependencia sin ADR; esas
 * primitivas son estables entre versiones de la especificación, así que se
 * acepta la versión que pida el cliente.
 */
import { LineDecoder } from "../ipc/framing.js"

export type McpTool = {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  call(args: Record<string, unknown>): Promise<unknown>
}

export type McpServerOptions = {
  name: string
  version: string
  tools: McpTool[]
  /** Se espera antes de responder `initialize`; si falla, el servidor responde error y sale. */
  ready?: Promise<unknown>
  input?: ReadableStream<Uint8Array>
  write?: (line: string) => void
  exit?: (code: number) => void
}

const FALLBACK_PROTOCOL = "2025-06-18"

type Incoming = { jsonrpc: "2.0"; id?: string | number | null; method?: string; params?: unknown }

export async function serveMcp(opts: McpServerOptions): Promise<void> {
  const write = opts.write ?? ((line: string) => process.stdout.write(line))
  const exit = opts.exit ?? ((code: number) => process.exit(code))
  const send = (msg: unknown) => write(`${JSON.stringify(msg)}\n`)
  const tools = new Map(opts.tools.map((t) => [t.name, t]))
  const decoder = new LineDecoder()

  const handle = async (m: Incoming): Promise<void> => {
    if (m.id === undefined || m.id === null || !m.method) return // notificaciones y respuestas
    const reply = (result: unknown) => send({ jsonrpc: "2.0", id: m.id, result })
    const fail = (code: number, message: string) =>
      send({ jsonrpc: "2.0", id: m.id, error: { code, message } })
    switch (m.method) {
      case "initialize": {
        try {
          await opts.ready
        } catch (e) {
          fail(-32603, e instanceof Error ? e.message : String(e))
          exit(1)
          return
        }
        const asked = (m.params as { protocolVersion?: unknown } | undefined)?.protocolVersion
        reply({
          protocolVersion: typeof asked === "string" ? asked : FALLBACK_PROTOCOL,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: opts.name, version: opts.version },
        })
        return
      }
      case "ping":
        reply({})
        return
      case "tools/list":
        reply({
          tools: opts.tools.map(({ name, description, inputSchema }) => ({
            name,
            description,
            inputSchema,
          })),
        })
        return
      case "tools/call": {
        const p = (m.params ?? {}) as { name?: string; arguments?: Record<string, unknown> }
        const tool = p.name ? tools.get(p.name) : undefined
        if (!tool) {
          fail(-32602, `tool desconocida: ${String(p.name)}`)
          return
        }
        try {
          const result = await tool.call(p.arguments ?? {})
          reply({
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
            ...(result && typeof result === "object" && !Array.isArray(result)
              ? { structuredContent: result }
              : {}),
          })
        } catch (e) {
          // Un error de la tool es un resultado para el modelo, no un fallo del protocolo.
          reply({
            content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }],
            isError: true,
          })
        }
        return
      }
      default:
        fail(-32601, `método no soportado: ${m.method}`)
    }
  }

  const input = opts.input ?? (Bun.stdin.stream() as ReadableStream<Uint8Array>)
  const pending: Promise<void>[] = []
  for await (const chunk of input) {
    for (const d of decoder.push(chunk)) {
      if (!d.ok) continue
      let msg: Incoming
      try {
        msg = JSON.parse(d.line) as Incoming
      } catch {
        send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "JSON inválido" } })
        continue
      }
      pending.push(handle(msg))
    }
  }
  await Promise.allSettled(pending)
}
