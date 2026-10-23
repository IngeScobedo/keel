/**
 * `queryFn` falso para tests: reproduce los mensajes y hooks grabados por el
 * spike (fixtures redactados) en el orden en que llegaron, invocando los hooks
 * registrados en `options.hooks` igual que lo haría el SDK.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import type { HookCallback, Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import type { QueryFn } from "../src/index.ts"

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
