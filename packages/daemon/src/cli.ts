/**
 * Cliente mínimo de línea de comandos (ADR-0005: sólo habla el protocolo).
 *
 *   bun packages/daemon/src/cli.ts health
 *   bun packages/daemon/src/cli.ts run "prompt" [--purpose execute] [--profile claude|codex]
 *   bun packages/daemon/src/cli.ts tail                # eventos en vivo con visual_state
 *   bun packages/daemon/src/cli.ts approve <id> <hash> # o deny
 *   bun packages/daemon/src/cli.ts pairings            # sesiones externas pendientes (ADR-0009 §4)
 *   bun packages/daemon/src/cli.ts pair-approve <id> [--task <work_item_id>] [--scopes a,b]
 *   bun packages/daemon/src/cli.ts pair-reject <id>
 *   bun packages/daemon/src/cli.ts requests            # peticiones de run de agentes (ADR-0009 §5)
 *   bun packages/daemon/src/cli.ts request-approve <id> # o request-reject
 */
import { IpcClient } from "./ipc/client.js"
import { defaultPaths } from "./main.js"

type View = {
  visual_state?: string
  display_id?: string
  status?: string
  lifecycle?: string
  id?: string
  cost_kind?: string
  total_cost_micro_usd?: number | null
}

function fmtEvent(n: {
  event_seq: number
  kind: string
  run_id: string | null
  payload?: unknown
}): string {
  const p = (n.payload ?? {}) as View & {
    tool?: string
    approval_id?: string
    operation_hash?: string
    agent?: string
    tool_calls?: string[]
    hook_event_name?: string
    tool_name?: string
    type?: string
    subtype?: string
  }
  const vs = p.visual_state ? ` [${p.visual_state}]` : ""
  let detail = ""
  if (n.kind.startsWith("hook.")) detail = ` ${p.tool_name ?? ""}`
  else if (n.kind === "approval.requested")
    detail = ` ${p.tool} → approve ${p.approval_id} ${p.operation_hash}`
  else if (n.kind === "run.updated")
    detail = ` ${p.status}${p.cost_kind ? ` · costo ${p.cost_kind}${p.total_cost_micro_usd != null ? ` $${(p.total_cost_micro_usd / 1e6).toFixed(4)}` : ""}` : ""}`
  else if (n.kind.startsWith("work_item.")) detail = ` ${p.display_id} ${p.lifecycle}`
  else if (n.kind.startsWith("sdk.")) detail = p.subtype ? `/${p.subtype}` : ""
  return `#${n.event_seq} ${n.kind}${detail}${vs}`
}

if (import.meta.main) {
  const [cmd, ...rest] = process.argv.slice(2)
  const socket = process.env.KEEL_SOCKET ?? defaultPaths().socketPath
  const client = await IpcClient.connect(socket)
  const key = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  if (cmd === "health") {
    console.log(JSON.stringify(await client.call("daemon.health", {}), null, 2))
    client.close()
  } else if (cmd === "tail") {
    client.onEvent((n) => console.log(fmtEvent(n)))
    const sub = (await client.call("events.subscribe", {
      after_event_seq: Number(process.env.KEEL_AFTER ?? 0),
    })) as { cursor: number }
    console.log(`suscrito; cursor ${sub.cursor}. Ctrl+C para salir.`)
  } else if (cmd === "run") {
    const prompt = rest.filter((a) => !a.startsWith("--")).join(" ")
    const purpose = rest.includes("--purpose") ? rest[rest.indexOf("--purpose") + 1] : "execute"
    client.onEvent((n) => console.log(fmtEvent(n)))
    await client.call("events.subscribe", { after_event_seq: Number.MAX_SAFE_INTEGER - 1 }) // «desde ahora»
    const w = (await client.call("work_items.create", {
      request_id: key(),
      idempotency_key: key(),
      title: prompt.slice(0, 80),
      kind: "chore",
    })) as { id: string; display_id: string }
    console.log(`tarea ${w.display_id} (${w.id})`)
    // Un run execute arranca desde planned (SDD 01 §3); desde la CLI, crear y
    // pedir la ejecución es la decisión humana de que el alcance ya está claro.
    if (purpose === "execute")
      await client.call("work_items.transition", {
        request_id: key(),
        idempotency_key: key(),
        work_item_id: w.id,
        to: "planned",
      })
    const run = (await client.call("runs.start", {
      request_id: key(),
      idempotency_key: key(),
      work_item_id: w.id,
      purpose,
      prompt,
      ...(rest.includes("--profile") ? { profile: rest[rest.indexOf("--profile") + 1] } : {}),
    })) as { id: string }
    console.log(`run ${run.id} arrancado; esperando eventos…`)
    const done = new Set(["completed", "failed", "cancelled", "interrupted", "budget_exceeded"])
    client.onEvent((n) => {
      const p = (n.payload ?? {}) as View
      if (n.kind === "run.updated" && n.run_id === run.id && p.status && done.has(p.status)) {
        console.log(`run terminado: ${p.status}`)
        setTimeout(() => {
          client.close()
          process.exit(0)
        }, 300)
      }
    })
  } else if (cmd === "approve" || cmd === "deny") {
    const [id, hash] = rest
    console.log(
      JSON.stringify(
        await client.call("approvals.resolve", {
          request_id: key(),
          idempotency_key: key(),
          approval_id: id,
          operation_hash: hash,
          decision: cmd === "approve" ? "approve_once" : "deny",
        }),
      ),
    )
    client.close()
  } else if (cmd === "pairings") {
    const { pairings } = (await client.call("session.pairings_list", { state: "pending" })) as {
      pairings: { id: string; code: string; client_name: string; cwd: string | null }[]
    }
    for (const p of pairings)
      console.log(`${p.id}  código ${p.code}  ${p.client_name}  ${p.cwd ?? ""}`)
    if (pairings.length === 0) console.log("no hay sesiones externas pendientes")
    client.close()
  } else if (cmd === "pair-approve" || cmd === "pair-reject") {
    const flag = (name: string) => (rest.includes(name) ? rest[rest.indexOf(name) + 1] : undefined)
    const task = flag("--task")
    const scopes = flag("--scopes")
    console.log(
      JSON.stringify(
        await client.call("session.pair_resolve", {
          request_id: key(),
          idempotency_key: key(),
          pairing_id: rest[0],
          decision: cmd === "pair-approve" ? "approve" : "reject",
          ...(task ? { work_item_id: task } : {}),
          ...(scopes ? { scopes: scopes.split(",") } : {}),
        }),
        null,
        2,
      ),
    )
    client.close()
  } else if (cmd === "requests") {
    const { requests } = (await client.call("runs.requests_list", { state: "pending" })) as {
      requests: {
        id: string
        work_item_id: string
        purpose: string
        requested_by: string
        reason: string
      }[]
    }
    for (const r of requests)
      console.log(
        `${r.id}  ${r.purpose} sobre ${r.work_item_id}  por ${r.requested_by}: ${r.reason}`,
      )
    if (requests.length === 0) console.log("no hay peticiones de run pendientes")
    client.close()
  } else if (cmd === "request-approve" || cmd === "request-reject") {
    console.log(
      JSON.stringify(
        await client.call("runs.request_resolve", {
          request_id: key(),
          idempotency_key: key(),
          run_request_id: rest[0],
          decision: cmd === "request-approve" ? "approve" : "reject",
        }),
        null,
        2,
      ),
    )
    client.close()
  } else {
    console.log(
      "uso: health | tail | run <prompt> [--purpose plan|execute] [--profile claude|codex] | approve <id> <hash> | deny <id> <hash> | pairings | pair-approve <id> [--task id] [--scopes a,b] | pair-reject <id> | requests | request-approve <id> | request-reject <id>",
    )
    client.close()
  }
}
