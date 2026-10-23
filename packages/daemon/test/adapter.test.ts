import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { EventNotification } from "@keel/core"
import {
  ApprovalGate,
  type ApprovalWaiter,
  ClaudeAdapter,
  createRunContext,
  DEFAULT_PROFILE,
  EventBus,
  INLINE_JSON_MAX_BYTES,
  openStore,
  Repo,
  SOURCE,
} from "../src/index.ts"
import { askingQuery, hangingQuery, loadRecordedRun, replayQuery } from "./replay.ts"

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
  const adapter = new ClaudeAdapter({ queryFn, binary: "/fake/claude" })
  // El daemon pone eventos, proyección y política; el adaptador sólo traduce el SDK.
  const ctx = createRunContext({
    repo,
    bus,
    run,
    gate: new ApprovalGate({ repo, waitApproval, timeoutMs: 20 }),
    source: SOURCE,
    adapterVersion: adapter.adapterVersion,
  })
  return {
    dir,
    store,
    repo,
    bus,
    published,
    project_id,
    run,
    ctx,
    adapter,
    done: () => rmSync(dir, { recursive: true, force: true }),
  }
}

describe("adaptador Claude SDK (ADR-0002 §4, ADR-0006) sobre la corrida grabada del spike", () => {
  test("proyecta run, árbol de agentes con parent_source sdk, tool calls y costo estimado", async () => {
    const s = setup(replayQuery())
    const final = await s.adapter.execute(s.ctx, "Usa el subagente lister", {
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

  test("K-06: una tool_response de 300 000 caracteres deja preview JSON válido y referencia al cuerpo íntegro", async () => {
    const entries = loadRecordedRun()
    const post = entries.find(
      (e) => e.kind === "hook" && e.name === "PostToolUse" && e.input.tool_name === "Glob",
    )
    if (post?.kind !== "hook") throw new Error("la corrida grabada no tiene PostToolUse de Glob")
    const body = { filenames: ["x".repeat(300_000)], numFiles: 1 }
    post.input = { ...post.input, tool_response: body }
    const s = setup(replayQuery(entries))
    const final = await s.adapter.execute(s.ctx, "grande", { ...DEFAULT_PROFILE, cwd: s.dir })
    expect(final.status).toBe("completed")

    const row = s.store.db
      .query<{ state: string; output_json: string; artifact_ref: string }, [string]>(
        "SELECT state, output_json, artifact_ref FROM tool_calls WHERE run_id = ? AND tool_name = 'Glob'",
      )
      .get(s.run.id)
    expect(row?.state).toBe("succeeded")
    const full = JSON.stringify(body)
    const preview = JSON.parse(row?.output_json ?? "null")
    expect(preview).toMatchObject({
      keel_preview: 1,
      bytes: full.length,
      sha256: new Bun.CryptoHasher("sha256").update(full).digest("hex"),
      body_ref: row?.artifact_ref,
    })
    expect(full.length).toBeGreaterThan(INLINE_JSON_MAX_BYTES)
    expect((row?.output_json.length ?? 0) < 8 * 1024).toBe(true)

    // la referencia lleva al evento con el cuerpo íntegro
    const [, eventId] = /^event:([^#]+)#\/tool_response$/.exec(row?.artifact_ref ?? "") ?? []
    const ev = s.store.db
      .query<{ payload_json: string }, [string]>("SELECT payload_json FROM events WHERE id = ?")
      .get(eventId ?? "")
    expect(JSON.parse(ev?.payload_json ?? "{}").tool_response).toEqual(body)
    s.store.db.close()
    s.done()
  })

  test("SDD 03 §5: los secretos de hooks y mensajes no llegan a ninguna tabla ni al bus", async () => {
    // Falsos y armados por partes: ningún escáner los toma por credenciales reales.
    const bearer = ["tok", "x".repeat(30)].join("")
    const gh = ["gh", "p_", "Z".repeat(36)].join("")
    const entries = loadRecordedRun()
    for (const e of entries) {
      if (e.kind !== "hook" || e.input.tool_name !== "Glob") continue
      if (e.name === "PreToolUse")
        e.input = {
          ...e.input,
          tool_input: { pattern: "src/**/*", note: `Authorization: Bearer ${bearer}` },
        }
      if (e.name === "PostToolUse")
        e.input = { ...e.input, tool_response: { filenames: [`GITHUB_TOKEN=${gh}`] } }
    }
    const s = setup(replayQuery(entries))
    const final = await s.adapter.execute(s.ctx, "secretos", { ...DEFAULT_PROFILE, cwd: s.dir })
    expect(final.status).toBe("completed")
    const dump = s.store.db
      .query<{ t: string }, []>(
        "SELECT group_concat(payload_json, ' ') t FROM events UNION ALL SELECT group_concat(coalesce(input_json,'') || coalesce(output_json,''), ' ') FROM tool_calls",
      )
      .all()
      .map((r) => r.t)
      .join(" ")
    expect(dump).not.toContain(bearer)
    expect(dump).not.toContain(gh)
    expect(JSON.stringify(s.published)).not.toContain(bearer)
    const glob = s.repo.toolCallsOfRun(s.run.id).find((c) => c.tool_name === "Glob")
    expect(glob?.label).toBe("src/**/*")
    const redacted = s.published.filter((n) => n.kind === "ingest.redacted")
    expect(redacted.length).toBeGreaterThanOrEqual(2)
    expect(redacted[0]?.payload).toMatchObject({ rules_version: 1, hits: expect.any(Array) })
    s.store.db.close()
    s.done()
  })

  test("cancelación: sin result del SDK, el daemon sintetiza cancelled en run y tool calls (FINDINGS §1)", async () => {
    const s = setup(hangingQuery())
    const p = s.adapter.execute(s.ctx, "cuelga", { ...DEFAULT_PROFILE, cwd: s.dir })
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
    const final = await s.adapter.execute(s.ctx, "borra", {
      ...DEFAULT_PROFILE,
      cwd: s.dir,
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
    await s.adapter.execute(s.ctx, "borra", { ...DEFAULT_PROFILE, cwd: s.dir })
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

  test("el evento de aprobación lleva el comando que se pide, redactado", async () => {
    const secret = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz"
    const s = setup(
      askingQuery({ command: `curl -H "x-api-key: ${secret}" https://x` }),
      async () => "approved" as const,
    )
    await s.adapter.execute(s.ctx, "borra", { ...DEFAULT_PROFILE, cwd: s.dir })
    const req = s.published.find((n) => n.kind === "approval.requested")?.payload as {
      input: { command: string }
    }
    expect(req.input.command).toStartWith("curl -H")
    expect(JSON.stringify(req)).not.toContain(secret)
    s.store.db.close()
    s.done()
  })

  test("subscription_session sin binario instalado falla antes de arrancar, sin fallback a API key", async () => {
    const s = setup(replayQuery())
    const adapter = new ClaudeAdapter({ queryFn: replayQuery(), binary: null })
    const profile = { ...DEFAULT_PROFILE, cwd: s.dir }
    expect(adapter.preflight(profile)).toMatchObject({ ok: false })
    const final = await adapter.execute(s.ctx, "x", profile)
    expect(final.status).toBe("failed")
    expect(final.end_reason).toBe("fatal_error")
    expect(s.published.map((n) => n.kind)).toContain("run.start_failed")
    s.store.db.close()
    s.done()
  })
})
