/**
 * ADR-0019 §4: modo por run, «aprobar para esta sesión», reglas del proyecto y
 * su revocación. ADR-0018 §1: atribución en el entorno del agente. Daemon, git
 * y SQLite reales; el proveedor es un guion que pide permiso por `canUseTool`.
 */
import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import { Daemon, IpcClient, type QueryFn } from "../src/index.ts"
import { initRepo } from "./git-fixture.ts"

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
const meta = () => ({ request_id: "r", idempotency_key: `perm-${++n}` })
type Op = { tool: string; input: Record<string, unknown> }
type Approval = { id: string; operation_hash: string; operation: { input: { command?: string } } }

/** Un run que pide cada operación en orden y anota qué decidió Keel. */
function scripted(ops: Op[], out: { behaviors: string[]; options?: Options }): QueryFn {
  return ({ options }) =>
    (async function* () {
      out.options = options
      yield {
        type: "system",
        subtype: "init",
        session_id: "s",
        model: "haiku",
        uuid: "u0",
      } as never
      for (const op of ops) {
        const d = await options.canUseTool?.(op.tool, op.input, {
          signal: new AbortController().signal,
          suggestions: [],
        } as never)
        out.behaviors.push(d?.behavior ?? "none")
      }
      yield {
        type: "result",
        subtype: "success",
        uuid: "u1",
        session_id: "s",
        is_error: false,
        result: "ok",
        total_cost_usd: 0.001,
        usage: { input_tokens: 1, output_tokens: 1 },
      } as unknown as SDKMessage
    })()
}

async function boot() {
  const dir = mkdtempSync(join(tmpdir(), "keel-perm-"))
  dirs.push(dir)
  initRepo(join(dir, "repo"))
  let next: QueryFn = scripted([], { behaviors: [] })
  const daemon = new Daemon({
    dbPath: join(dir, "keel.sqlite"),
    socketPath: join(dir, "keel.sock"),
    rootPath: join(dir, "repo"),
    worktreesDir: join(dir, "worktrees"),
    adapterDeps: { queryFn: (a) => next(a), binary: "/fake/claude" },
    profile: { approval_timeout_ms: 3_000 },
    mcpBridge: false,
  })
  daemon.start()
  daemons.push(daemon)
  const human = await IpcClient.connect(daemon.server.path)
  clients.push(human)

  /**
   * Corre un run `execute` con el guion y responde cada aprobación con `decide`
   * (o la deja vencer si devuelve null).
   */
  async function run(
    ops: Op[],
    decide: (a: Approval) => string | null,
    options: Record<string, unknown> = {},
  ) {
    const out: { behaviors: string[]; options?: Options } = { behaviors: [] }
    next = scripted(ops, out)
    const w = (await human.call("work_items.create", { ...meta(), title: "t", kind: "chore" })) as {
      id: string
    }
    await human.call("work_items.transition", { ...meta(), work_item_id: w.id, to: "planned" })
    const r = (await human.call("runs.start", {
      ...meta(),
      work_item_id: w.id,
      purpose: "execute",
      options,
    })) as { id: string }
    const answered = new Set<string>()
    let asked = 0
    while (
      !["completed", "failed", "cancelled", "interrupted"].includes(
        daemon.repo.getRun(r.id)?.status ?? "",
      )
    ) {
      const { approvals } = (await human.call("approvals.list", { run_id: r.id })) as {
        approvals: Approval[]
      }
      for (const a of approvals) {
        if (answered.has(a.id)) continue
        answered.add(a.id)
        asked++
        const decision = decide(a)
        if (decision)
          await human.call("approvals.resolve", {
            ...meta(),
            approval_id: a.id,
            operation_hash: a.operation_hash,
            decision,
          })
      }
      await Bun.sleep(10)
    }
    await daemon.idle()
    const auto = daemon.repo
      .eventsAfter(0, null, 100_000)
      .filter((e) => e.kind === "approval.auto" && e.run_id === r.id)
      .map((e) => JSON.parse(e.payload_json) as { source: string; effect: string; label: string })
    return { run: r, out, asked, auto }
  }
  return { daemon, human, run }
}

const bash = (command: string): Op => ({ tool: "Bash", input: { command } })

describe("ADR-0019 §4: permisos recordables", () => {
  test("aprobar para la sesión cubre el mismo prefijo, nunca un encadenamiento", async () => {
    const { run } = await boot()
    const r = await run(
      [bash("git status"), bash("git status --short"), bash("git status; rm -rf ~")],
      (a) => (a.operation.input.command === "git status" ? "approve_session" : "deny"),
    )
    expect(r.out.behaviors).toEqual(["allow", "allow", "deny"])
    expect(r.asked).toBe(2)
    expect(r.auto).toHaveLength(1)
    expect(r.auto[0]).toMatchObject({ effect: "auto", label: "Bash(git status:*)" })
    expect(r.auto[0]?.source).toStartWith("session:")
  })

  test("aprobar siempre crea una regla del proyecto; revocarla vuelve a preguntar", async () => {
    const { human, run } = await boot()
    const first = await run([bash("bun test a")], () => "approve_always")
    expect(first.out.behaviors).toEqual(["allow"])
    const { rules } = (await human.call("permissions.rules_list", {})) as {
      rules: { id: string; label: string; source_approval_id: string | null }[]
    }
    expect(rules).toHaveLength(1)
    expect(rules[0]?.label).toBe("Bash(bun test:*)")
    expect(rules[0]?.source_approval_id).not.toBeNull()

    const second = await run([bash("bun test b")], () => "deny")
    expect(second.out.behaviors).toEqual(["allow"])
    expect(second.asked).toBe(0)
    expect(second.auto[0]?.source).toBe(`rule:${rules[0]?.id}`)

    await human.call("permissions.rule_revoke", { ...meta(), rule_id: rules[0]?.id })
    const third = await run([bash("bun test c")], () => "deny")
    expect(third.out.behaviors).toEqual(["deny"])
    expect(third.asked).toBe(1)
    const all = (await human.call("permissions.rules_list", { include_revoked: true })) as {
      rules: { revoked_at: string | null }[]
    }
    expect(all.rules[0]?.revoked_at).not.toBeNull()
    // La vista de permisos ve todas las decisiones, no sólo las pendientes.
    const history = (await human.call("approvals.list", { include_resolved: true })) as {
      approvals: { state: string; decision_actor: string | null }[]
    }
    expect(history.approvals.map((a) => a.state).sort()).toEqual(["consumed", "denied"])
  })

  test("una regla deny gana sin preguntar; una auto no cubre archivos fuera del worktree", async () => {
    const { human, run } = await boot()
    await human.call("permissions.rule_add", {
      ...meta(),
      tool: "Bash",
      prefix: "curl",
      effect: "deny",
    })
    await human.call("permissions.rule_add", {
      ...meta(),
      tool: "Write",
      prefix: null,
      effect: "auto",
    })
    const r = await run(
      [
        bash("curl https://example.com"),
        { tool: "Write", input: { file_path: "src/a.ts", content: "x" } },
        { tool: "Write", input: { file_path: "/etc/keel-test", content: "x" } },
      ],
      () => "deny",
    )
    expect(r.out.behaviors).toEqual(["deny", "allow", "deny"])
    expect(r.asked).toBe(1)
    expect(r.auto.map((a) => a.effect)).toEqual(["deny", "auto"])
  })
})

describe("ADR-0019 §4 y ADR-0018 §1: opciones del run y atribución", () => {
  test("modelo, turnos y modo llegan al SDK; el agente firma con su nombre", async () => {
    const { daemon, run } = await boot()
    const r = await run([], () => null, {
      model: "sonnet",
      max_turns: 40,
      permission_mode: "bypass",
    })
    const o = r.out.options as Options & { env: Record<string, string> }
    expect(o).toMatchObject({
      model: "sonnet",
      maxTurns: 40,
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
    })
    expect(o.env.GIT_AUTHOR_NAME).toStartWith("Claude (Keel KEEL-")
    expect(o.env.GIT_COMMITTER_EMAIL).toBe(`${r.run.id.toLowerCase()}@agents.keel.local`)
    expect(o.env.KEEL_RUN_ID).toBe(r.run.id)
    const view = daemon.repo.runView(daemon.repo.getRun(r.run.id) as never)
    expect(view.options).toEqual({ model: "sonnet", max_turns: 40, permission_mode: "bypass" })
  })

  test("un run que no ejecuta no admite bypass ni accept_edits", async () => {
    const { human } = await boot()
    const w = (await human.call("work_items.create", { ...meta(), title: "p", kind: "chore" })) as {
      id: string
    }
    for (const permission_mode of ["bypass", "accept_edits"])
      await expect(
        human.call("runs.start", {
          ...meta(),
          work_item_id: w.id,
          purpose: "plan",
          options: { permission_mode },
        }),
      ).rejects.toThrow("sólo admite los modos ask o plan")
  })
})
