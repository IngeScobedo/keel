/**
 * ADR-0015: operaciones de git con plan aprobado y verificado. Git real con un
 * remoto `bare`; daemon y SQLite reales; el proveedor es la corrida grabada.
 */
import { afterEach, describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import { Daemon, IpcClient, type QueryFn } from "../src/index.ts"
import { initRepo } from "./git-fixture.ts"
import { replayQuery } from "./replay.ts"

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
const meta = () => ({ request_id: "r", idempotency_key: crypto.randomUUID() })
const sh = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, stdio: "pipe" }).toString().trim()

type Plan = {
  plan_id: string
  plan_hash: string
  plan: { files: { path: string }[]; branch: string; operations: { op: string; branch?: string }[] }
}

async function boot(queryFn: QueryFn = replayQuery()) {
  const dir = mkdtempSync(join(tmpdir(), "keel-gitplan-"))
  dirs.push(dir)
  const repo = initRepo(join(dir, "repo"))
  const remote = join(dir, "remote.git")
  sh(dir, "init", "-q", "--bare", "-b", "main", remote)
  sh(repo, "remote", "add", "origin", remote)
  sh(repo, "push", "-q", "origin", "main")
  sh(repo, "fetch", "-q", "origin")
  sh(repo, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main")
  const daemon = new Daemon({
    dbPath: join(dir, "keel.sqlite"),
    socketPath: join(dir, "keel.sock"),
    rootPath: repo,
    worktreesDir: join(dir, "worktrees"),
    adapterDeps: { queryFn, binary: "/fake/claude" },
    mcpBridge: false,
    sandbox: "off",
    gh: null,
  })
  daemon.start()
  daemons.push(daemon)
  const human = await IpcClient.connect(daemon.server.path)
  clients.push(human)
  /** Un run execute terminado: su worktree se conserva para la revisión. */
  const executed = async () => {
    const w = (await human.call("work_items.create", {
      ...meta(),
      title: "cambio",
      kind: "chore",
    })) as {
      id: string
    }
    await human.call("work_items.transition", { ...meta(), work_item_id: w.id, to: "planned" })
    const run = (await human.call("runs.start", {
      ...meta(),
      work_item_id: w.id,
      purpose: "execute",
    })) as {
      id: string
    }
    await daemon.idle()
    const wt = daemon.repo.runWorktrees(run.id)[0]?.worktree_path as string
    return { run, wt, w }
  }
  const approve = (plan: Plan) =>
    human.call("approvals.resolve", {
      ...meta(),
      approval_id: plan.plan_id,
      operation_hash: plan.plan_hash,
      decision: "approve_once",
    })
  const status = (plan: Plan) =>
    human.call("git.plan_status", { plan_id: plan.plan_id }) as Promise<{
      state: string
      steps: { op: string; state: string; detail: Record<string, unknown> }[]
    }>
  return { dir, daemon, human, remote, executed, approve, status }
}

describe("ADR-0015: git con plan aprobado", () => {
  test("proponer, aprobar y ejecutar: commit a nombre del agente, push a la rama del run y PR pendiente sin gh", async () => {
    const { daemon, human, remote, executed, approve, status } = await boot()
    const { run, wt, w } = await executed()
    writeFileSync(join(wt, "nuevo.ts"), "export const x = 1\n")
    writeFileSync(join(wt, "README.md"), "fixture\ncambiado\n")
    const st = (await human.call("git.status", { run_id: run.id })) as { files: { path: string }[] }
    expect(st.files.map((f) => f.path)).toEqual(["README.md", "nuevo.ts"])

    const plan = (await human.call("git.propose", {
      ...meta(),
      run_id: run.id,
      message: "añade x",
      push: {},
      pr: { title: "Añade x" },
    })) as Plan
    expect(plan.plan.operations.map((o) => o.op)).toEqual(["commit", "push", "pr.create"])
    // Pendiente en el inbox con su hash, sin haber tocado nada.
    const pending = (await human.call("approvals.list", {})) as { approvals: { id: string }[] }
    expect(pending.approvals.map((a) => a.id)).toContain(plan.plan_id)
    expect((await status(plan)).state).toBe("pending")

    await approve(plan)
    await daemon.idle()
    const s = await status(plan)
    expect(s.state).toBe("completed")
    const commit = s.steps.find((x) => x.op === "git.commit.created")?.detail as {
      sha: string
      files: string[]
    }
    // La tarjeta muestra los mismos archivos que el commit creado.
    expect(commit.files).toEqual(plan.plan.files.map((f) => f.path))
    expect(sh(wt, "log", "-1", "--format=%an")).toStartWith("Claude (Keel KEEL-")
    // ADR-0043 §7: se publica con la convención del repo (tipo + resumen), no como keel/….
    const push = plan.plan.operations.find((o) => o.op === "push") as unknown as { branch: string }
    expect(push.branch).toBe("chore/cambio")
    expect(sh(remote, "rev-parse", "refs/heads/chore/cambio")).toBe(commit.sha)
    expect(s.steps.find((x) => x.op === "git.pull_request.pending")?.detail.reason).toContain(
      "gh no está configurado",
    )
    // Eventos semánticos instrumentados y el diff aprobado como evidencia.
    const sem = (await human.call("semantic.list", { run_id: run.id })) as {
      events: { kind: string; coverage: string }[]
    }
    expect(sem.events.filter((e) => e.coverage === "instrumented").map((e) => e.kind)).toEqual([
      "git.plan.proposed",
      "git.plan.approved",
      "git.commit.created",
      "git.push.completed",
    ])
    const ev = (await human.call("evidence.list", { work_item_id: w.id })) as {
      evidence: { kind: string }[]
    }
    // El diff aprobado y el registro de cambios de la tarea (commits y diff contra la base).
    expect(ev.evidence.map((e) => e.kind)).toEqual(["diff", "diff"])
  })

  test("la historia de la tarea (commits y diff) sobrevive a liberar el worktree", async () => {
    const { daemon, human, executed, approve } = await boot()
    const { run, wt, w } = await executed()
    writeFileSync(join(wt, "nuevo.ts"), "export const x = 1\n")
    type Changes = {
      source: string
      commits: { subject: string; files: { path: string }[] }[]
      files: { path: string; additions: number; deletions: number }[]
      diff: string
    }
    // Mientras vive el worktree: en vivo, con lo que aún no está en un commit.
    const live = (await human.call("tasks.changes", { work_item_id: w.id })) as Changes
    expect(live.source).toBe("worktree")
    expect(live.commits).toEqual([])
    expect(live.files).toEqual([{ path: "nuevo.ts", additions: 1, deletions: 0 }])
    const plan = (await human.call("git.propose", {
      ...meta(),
      run_id: run.id,
      message: "feat: añade x",
    })) as Plan
    await approve(plan)
    await daemon.idle()
    writeFileSync(join(wt, "README.md"), "fixture\nsin commit\n")
    // Se libera el worktree (como al mergear y cerrar la tarea).
    await (daemon as unknown as { captureAndRelease(id: string): Promise<void> }).captureAndRelease(
      run.id,
    )
    expect(existsSync(wt)).toBe(false)
    const kept = (await human.call("tasks.changes", { work_item_id: w.id })) as Changes & {
      captured_at: string
    }
    expect(kept.source).toBe("record")
    expect(kept.captured_at).toBeTruthy()
    expect(kept.commits.map((c) => [c.subject, c.files.map((f) => f.path)])).toEqual([
      ["feat: añade x", ["nuevo.ts"]],
    ])
    expect(kept.files.map((f) => f.path).sort()).toEqual(["README.md", "nuevo.ts"])
    expect(kept.diff).toContain("+export const x = 1")
    expect(kept.diff).toContain("+sin commit")
  })

  test("KEEL-5: el plan sube a la rama que nombra, no vence solo y uno nuevo reemplaza al que esperaba", async () => {
    const { daemon, human, remote, executed, approve, status } = await boot()
    const { run, wt, w } = await executed()
    writeFileSync(join(wt, "a.ts"), "1\n")
    const first = (await human.call("git.propose", {
      ...meta(),
      run_id: run.id,
      message: "a",
    })) as Plan
    // ADR-0020 §3: sin límite elegido por el humano, el plan espera sin vencer.
    const listed = (await human.call("approvals.list", {})) as {
      approvals: { id: string; expires_at: string | null }[]
    }
    expect(listed.approvals.find((a) => a.id === first.plan_id)?.expires_at).toBeNull()
    const second = (await human.call("git.propose", {
      ...meta(),
      run_id: run.id,
      message: "a",
      push: { branch: "fix/a-con-nombre" },
    })) as Plan
    expect((await status(first)).state).toBe("expired")
    await expect(approve(first)).rejects.toThrow("expired")
    await approve(second)
    await daemon.idle()
    const s = await status(second)
    expect(s.state).toBe("completed")
    // El worktree sigue en keel/…; el remoto recibe la rama que nombró el plan.
    expect(second.plan.branch).toStartWith("keel/")
    expect(sh(remote, "rev-parse", "refs/heads/fix/a-con-nombre")).toBe(sh(wt, "rev-parse", "HEAD"))
    const last = (
      daemon as unknown as { lastGitPlan(id: string): { plan_id: string; state: string } }
    ).lastGitPlan(w.id)
    expect(last).toMatchObject({ plan_id: second.plan_id, state: "completed" })
  })

  test("si el push falla, la tarea dice por qué y qué sí se hizo", async () => {
    const { daemon, human, remote, executed, approve } = await boot()
    const { run, wt, w } = await executed()
    writeFileSync(join(wt, "a.ts"), "1\n")
    const plan = (await human.call("git.propose", {
      ...meta(),
      run_id: run.id,
      message: "a",
      push: {},
    })) as Plan
    rmSync(remote, { recursive: true, force: true })
    await approve(plan)
    await daemon.idle()
    const d = daemon as unknown as {
      lastGitPlan(id: string): { state: string; reason: string | null; done: string[] }
      gitPlanNote(id: string): string
    }
    const last = d.lastGitPlan(w.id)
    expect(last.state).toBe("failed")
    expect(last.reason).toContain("does not appear to be a git repository")
    expect(last.done).toEqual(["git.commit.created"])
    expect(d.gitPlanNote(w.id)).toContain("git_propose")
  })

  test("modificar un archivo después de proponer hace caducar el plan antes del commit", async () => {
    const { daemon, human, executed, approve, status } = await boot()
    const { run, wt } = await executed()
    writeFileSync(join(wt, "a.ts"), "1\n")
    const before = sh(wt, "rev-parse", "HEAD")
    const plan = (await human.call("git.propose", {
      ...meta(),
      run_id: run.id,
      message: "a",
    })) as Plan
    writeFileSync(join(wt, "a.ts"), "2\n")
    await approve(plan)
    await daemon.idle()
    const s = await status(plan)
    expect(s.state).toBe("expired")
    expect(sh(wt, "rev-parse", "HEAD")).toBe(before)
    const expired = daemon.repo
      .eventsAfter(0, null, 10_000)
      .find((e) => e.kind === "git.plan.expired")
    expect(JSON.parse(expired?.payload_json ?? "{}").reason).toContain("contenido")
  })

  test("un plan que apunta a la rama por defecto se rechaza al proponerse", async () => {
    const { human, executed } = await boot()
    const { run, wt } = await executed()
    writeFileSync(join(wt, "a.ts"), "1\n")
    await expect(
      human.call("git.propose", {
        ...meta(),
        run_id: run.id,
        message: "a",
        push: { branch: "main" },
      }),
    ).rejects.toThrow("protegida")
  })

  test("git push por Bash se niega en el perfil por defecto y sugiere git_propose", async () => {
    let behavior = ""
    let message = ""
    const asking: QueryFn = ({ options }) =>
      (async function* () {
        yield { type: "system", subtype: "init", session_id: "s", uuid: "u0" } as never
        const d = await options.canUseTool?.("Bash", { command: "git push origin keel/x" }, {
          signal: new AbortController().signal,
          suggestions: [],
        } as never)
        behavior = d?.behavior ?? ""
        message = (d as { message?: string }).message ?? ""
        yield {
          type: "result",
          subtype: "success",
          uuid: "u1",
          session_id: "s",
          is_error: false,
          result: "ok",
          total_cost_usd: 0,
          usage: { input_tokens: 1, output_tokens: 1 },
        } as unknown as SDKMessage
      })()
    const { executed } = await boot(asking)
    await executed()
    expect(behavior).toBe("deny")
    expect(message).toContain("git_propose")
  })

  test("un commit hecho por shell durante el run queda como inferred al cerrarlo", async () => {
    const shellCommit: QueryFn = ({ options }) =>
      (async function* () {
        yield { type: "system", subtype: "init", session_id: "s", uuid: "u0" } as never
        execFileSync(
          "git",
          [
            "-c",
            "user.name=a",
            "-c",
            "user.email=a@a",
            "commit",
            "-q",
            "--allow-empty",
            "-m",
            "por shell",
          ],
          {
            cwd: options.cwd as string,
          },
        )
        yield {
          type: "result",
          subtype: "success",
          uuid: "u1",
          session_id: "s",
          is_error: false,
          result: "ok",
          total_cost_usd: 0,
          usage: { input_tokens: 1, output_tokens: 1 },
        } as unknown as SDKMessage
      })()
    const { human, executed } = await boot(shellCommit)
    const { run } = await executed()
    const sem = (await human.call("semantic.list", { run_id: run.id })) as {
      events: {
        kind: string
        coverage: string
        interpreter: string
        payload: { message: string }
      }[]
    }
    expect(sem.events).toEqual([
      expect.objectContaining({
        kind: "git.commit.created",
        coverage: "inferred",
        interpreter: "git-refs@1",
        payload: expect.objectContaining({ message: "por shell" }),
      }),
    ])
  })
})
