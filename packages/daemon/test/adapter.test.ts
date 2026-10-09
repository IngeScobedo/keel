import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { EventNotification } from "@keel/core"
import {
  type ApprovalWaiter,
  ClaudeAdapter,
  DEFAULT_PROFILE,
  EventBus,
  openStore,
  Repo,
} from "../src/index.ts"
import { askingQuery, hangingQuery, replayQuery } from "./replay.ts"

function setup(
  queryFn: ReturnType<typeof replayQuery>,
  waitApproval: ApprovalWaiter = async () => "expired",
) {
  const dir = mkdtempSync(join(tmpdir(), "keel-adapter-"))
  const store = openStore(join(dir, "keel.sqlite"), { loadVector: false })
  const repo = new Repo(store.db)
  const bus = new EventBus()
  const published: EventNotification[] = []
  bus.subscribe((n) => published.push(n))
  const { project_id } = repo.ensureDefaultProject(dir)
  const w = repo.createWorkItem({ project_id, title: "lista src", kind: "chore" })
  const run = repo.createRun({ project_id, work_item_id: w.id, purpose: "execute" })
  const adapter = new ClaudeAdapter({ repo, bus, queryFn, waitApproval, binary: "/fake/claude" })
  return {
    dir,
    store,
    repo,
    bus,
    published,
    project_id,
    run,
    adapter,
    done: () => rmSync(dir, { recursive: true, force: true }),
  }
}

describe("adaptador Claude SDK (ADR-0002 §4, ADR-0006) sobre la corrida grabada del spike", () => {
  test("proyecta run, árbol de agentes con parent_source sdk, tool calls y costo estimado", async () => {
    const s = setup(replayQuery())
    const final = await s.adapter.execute(s.run, "Usa el subagente lister", {
      ...DEFAULT_PROFILE,
      cwd: s.dir,
    })
    expect(final.status).toBe("completed")
    expect(final.end_reason).toBe("completed")
    expect(final.cost_kind).toBe("estimated")
    expect(final.total_cost_micro_usd).toBe(6041)
    expect(final.input_tokens).toBeGreaterThan(0)

    const agents = s.repo.agentsOfRun(s.run.id)
    const root = agents.find((a) => a.classification === "root")
    const worker = agents.find((a) => a.classification === "worker")
    expect(root?.state).toBe("succeeded")
    expect(worker?.external_agent_id).toBe("acd80ec38e2940285")
    expect(worker?.parent_agent_id).toBe(root?.id)
    expect(worker?.parent_source).toBe("sdk")
    expect(worker?.agent_type).toBe("lister")
    expect(worker?.state).toBe("succeeded")

    const calls = s.repo.toolCallsOfRun(s.run.id)
    const names = calls.map((c) => `${c.tool_name}:${c.state}`).sort()
    expect(names).toEqual(["Agent:succeeded", "Glob:succeeded"])
    const glob = calls.find((c) => c.tool_name === "Glob")
    expect(glob?.agent_id).toBe(worker?.id)
    expect(glob?.label).toBe("src/**/*")
    expect(glob?.wall_ms).toBeGreaterThanOrEqual(0)

    const kinds = new Set(s.published.map((n) => n.kind))
    expect(kinds.has("sdk.system")).toBe(true)
    expect(kinds.has("hook.SubagentStart")).toBe(true)
    expect(kinds.has("run.updated")).toBe(true)
    expect(s.repo.lastEventSeq()).toBeGreaterThan(20)
    expect(JSON.parse(s.repo.getRun(s.run.id)?.context_manifest_json ?? "{}").auth_mode).toBe(
      "subscription_session",
    )
    s.store.db.close()
    s.done()
  })

  test("cancelación: sin result del SDK, el daemon sintetiza cancelled en run y tool calls (FINDINGS §1)", async () => {
    const s = setup(hangingQuery())
    const p = s.adapter.execute(s.run, "cuelga", { ...DEFAULT_PROFILE, cwd: s.dir })
    await new Promise((r) => setTimeout(r, 50))
    expect(s.adapter.activeRuns).toBe(1)
    expect(s.adapter.cancel(s.run.id, "test")).toBe(true)
    const final = await p
    expect(final.status).toBe("cancelled")
    expect(final.end_reason).toBe("cancelled")
    expect(s.repo.toolCallsOfRun(s.run.id).map((c) => c.state)).toEqual(["cancelled"])
    expect(s.repo.agentsOfRun(s.run.id).every((a) => a.state === "cancelled")).toBe(true)
    expect(s.adapter.activeRuns).toBe(0)
    s.store.db.close()
    s.done()
  })

  test("canUseTool sin decisión humana → deny-on-timeout y solicitud expirada en el inbox (SDD 02 §9)", async () => {
    const s = setup(askingQuery())
    const final = await s.adapter.execute(s.run, "borra", {
      ...DEFAULT_PROFILE,
      cwd: s.dir,
      approval_timeout_ms: 20,
    })
    expect(final.status).toBe("completed")
    const kinds = s.published.map((n) => n.kind)
    expect(kinds).toContain("approval.requested")
    expect(kinds).toContain("approval.resolved")
    const req = s.published.find((n) => n.kind === "approval.requested")?.payload as {
      approval_id: string
    }
    expect(s.repo.getApproval(req.approval_id)?.state).toBe("expired")
    const resultMsg = s.published.find((n) => n.kind === "sdk.result")?.payload as {
      result: string
    }
    expect(resultMsg.result).toBe("deny")
    s.store.db.close()
    s.done()
  })

  test("canUseTool aprobado por el humano → allow y aprobación consumida", async () => {
    const s = setup(askingQuery(), async () => "approved" as const)
    await s.adapter.execute(s.run, "borra", { ...DEFAULT_PROFILE, cwd: s.dir })
    const req = s.published.find((n) => n.kind === "approval.requested")?.payload as {
      approval_id: string
    }
    expect(s.repo.getApproval(req.approval_id)?.state).toBe("consumed")
    const resultMsg = s.published.find((n) => n.kind === "sdk.result")?.payload as {
      result: string
    }
    expect(resultMsg.result).toBe("allow")
    s.store.db.close()
    s.done()
  })

  test("subscription_session sin binario instalado falla antes de arrancar, sin fallback a API key", async () => {
    const s = setup(replayQuery())
    const adapter = new ClaudeAdapter({
      repo: s.repo,
      bus: s.bus,
      queryFn: replayQuery(),
      waitApproval: async () => "expired",
      binary: null,
    })
    const final = await adapter.execute(s.run, "x", { ...DEFAULT_PROFILE, cwd: s.dir })
    expect(final.status).toBe("failed")
    expect(final.end_reason).toBe("fatal_error")
    s.store.db.close()
    s.done()
  })
})
