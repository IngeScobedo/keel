/**
 * ADR-0019 §2: varios proyectos en un daemon. Cada carpeta abierta es su
 * proyecto, con sus tareas, sus runs en su repo y sus eventos; el estado de git
 * sale de `@keel/git`. Daemon, git y SQLite reales.
 */
import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { Daemon, IpcClient } from "../src/index.ts"
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

let n = 0
const meta = () => ({ request_id: "r", idempotency_key: `proj-${++n}` })

function start(dir: string, rootPath?: string) {
  const daemon = new Daemon({
    dbPath: join(dir, "keel.sqlite"),
    socketPath: join(dir, "keel.sock"),
    ...(rootPath ? { rootPath } : {}),
    worktreesDir: join(dir, "worktrees"),
    adapterDeps: { queryFn: replayQuery(), binary: "/fake/claude" },
    mcpBridge: false,
  })
  daemon.start()
  daemons.push(daemon)
  return daemon
}

async function connect(daemon: Daemon) {
  const c = await IpcClient.connect(daemon.server.path)
  clients.push(c)
  return c
}

describe("ADR-0019 §2: proyectos", () => {
  test("abrir una carpeta crea su proyecto, separa tareas y eventos, y los runs usan su repo", async () => {
    const dir = mkdtempSync(join(tmpdir(), "keel-proj-"))
    dirs.push(dir)
    const a = initRepo(join(dir, "alpha"))
    const b = initRepo(join(dir, "beta"))
    const daemon = start(dir, a)
    const c = await connect(daemon)

    const opened = (await c.call("projects.open", { path: b })) as { id: string; name: string }
    expect(opened.name).toBe("beta")
    expect(opened.id).not.toBe(daemon.project.project_id)
    // Reabrirla da el mismo proyecto.
    expect(((await c.call("projects.open", { path: b })) as { id: string }).id).toBe(opened.id)

    // Lo que crea la conexión va al proyecto activo, con sus eventos en él.
    const w = (await c.call("work_items.create", {
      ...meta(),
      title: "en beta",
      kind: "chore",
    })) as {
      id: string
      project_id: string
    }
    expect(w.project_id).toBe(opened.id)
    const other = await connect(daemon)
    const inA = (await other.call("events.subscribe", {
      project_id: daemon.project.project_id,
    })) as {
      snapshot: { work_items: unknown[] }
    }
    expect(inA.snapshot.work_items).toHaveLength(0)
    const inB = (await other.call("events.subscribe", { project_id: opened.id })) as {
      snapshot: { work_items: { id: string }[] }
    }
    expect(inB.snapshot.work_items.map((x) => x.id)).toEqual([w.id])

    // Un run execute en beta crea su worktree desde el repo de beta y sus eventos van a beta.
    await c.call("work_items.transition", { ...meta(), work_item_id: w.id, to: "planned" })
    const run = (await c.call("runs.start", {
      ...meta(),
      work_item_id: w.id,
      purpose: "execute",
    })) as {
      id: string
    }
    await daemon.idle()
    const events = daemon.repo.eventsAfter(0, null, 10_000).filter((e) => e.run_id === run.id)
    expect(events.length).toBeGreaterThan(0)
    expect(events.every((e) => e.project_id === opened.id)).toBe(true)
    const created = events.find((e) => e.kind === "worktree.created")
    expect(created).toBeDefined()
    const repoRow = daemon.repo.getProjectRepo(
      (JSON.parse(created?.payload_json ?? "{}") as { project_repo_id: string }).project_repo_id,
    )
    expect(basename(repoRow?.local_path ?? "")).toBe("beta")

    const list = (await c.call("projects.list", {})) as {
      projects: { id: string; name: string }[]
      current: string
    }
    expect(list.current).toBe(opened.id)
    expect(list.projects.map((p) => p.name).sort()).toEqual(["alpha", "beta"])
  })

  test("projects.status da rama, HEAD y cambios; una carpeta sin git da git null", async () => {
    const dir = mkdtempSync(join(tmpdir(), "keel-proj-"))
    dirs.push(dir)
    const a = initRepo(join(dir, "alpha"))
    const daemon = start(dir, a)
    const c = await connect(daemon)
    writeFileSync(join(a, "nuevo.txt"), "x")
    const s = (await c.call("projects.status", {})) as {
      git: { branch: string; head: string; changed: number }
    }
    expect(s.git).toMatchObject({ branch: "main", changed: 1 })
    expect(s.git.head).toMatch(/^[0-9a-f]{40}$/)

    const plain = join(dir, "sin-git")
    mkdirSync(plain)
    await c.call("projects.open", { path: plain })
    expect(((await c.call("projects.status", {})) as { git: unknown }).git).toBeNull()
    await expect(c.call("projects.open", { path: join(dir, "no-existe") })).rejects.toThrow(
      "no se puede abrir",
    )
  })

  test("sin --root el daemon abre el último proyecto usado", async () => {
    const dir = mkdtempSync(join(tmpdir(), "keel-proj-"))
    dirs.push(dir)
    const a = initRepo(join(dir, "alpha"))
    const b = initRepo(join(dir, "beta"))
    const first = start(dir, a)
    const c = await connect(first)
    const opened = (await c.call("projects.open", { path: b })) as { id: string }
    c.close()
    await first.idle()
    first.stop()
    daemons.splice(daemons.indexOf(first), 1)

    const again = start(dir)
    expect(again.project.project_id).toBe(opened.id)
    const health = (await (await connect(again)).call("daemon.health", {})) as {
      project: { root_path: string }
    }
    expect(basename(health.project.root_path)).toBe("beta")
  })

  test("un evento de sistema sin run va al proyecto de su tarea, y los que cayeron en otro se vuelven a registrar", async () => {
    const dir = mkdtempSync(join(tmpdir(), "keel-proj-"))
    dirs.push(dir)
    const a = initRepo(join(dir, "alpha"))
    const b = initRepo(join(dir, "beta"))
    const daemon = start(dir, a)
    const c = await connect(daemon)
    const beta = (await c.call("projects.open", { path: b })) as { id: string }
    const parent = daemon.repo.createWorkItem({
      project_id: beta.id,
      title: "feature",
      kind: "feature",
    })
    const where = (kind: string) =>
      daemon.store.db
        .query<{ project_id: string; payload_json: string }, [string]>(
          "SELECT project_id, payload_json FROM events WHERE kind = ? ORDER BY event_seq",
        )
        .all(kind)
    const internals = daemon as unknown as {
      emitSystem(kind: string, runId: string | null, payload: unknown): void
      refileMisplacedEvents(): void
    }

    // El padre de una feature no tiene run: antes caía en el proyecto por defecto (alpha).
    internals.emitSystem("feature.subtask_integrated", null, { work_item_id: parent.id, key: "T1" })
    expect(where("feature.subtask_integrated").map((e) => e.project_id)).toEqual([beta.id])

    // Uno que quedó en alpha se copia a beta una sola vez.
    daemon.repo.appendEvent({
      project_id: daemon.project.project_id,
      run_id: null,
      source: "daemon",
      source_event_key: "viejo",
      fidelity: "full",
      adapter_version: "daemon/0",
      kind: "feature.branch_created",
      occurred_at: null,
      payload_json: JSON.stringify({ work_item_id: parent.id, branch: "feat/x" }),
    })
    internals.refileMisplacedEvents()
    internals.refileMisplacedEvents()
    const copies = where("feature.branch_created")
    expect(copies.map((e) => e.project_id)).toEqual([daemon.project.project_id, beta.id])
    expect(JSON.parse(copies[1]?.payload_json ?? "{}")).toMatchObject({
      branch: "feat/x",
      refiled_from: expect.any(Number),
    })
  })

  test("events.history da la historia de una tarea antes de un cursor, por páginas", async () => {
    const dir = mkdtempSync(join(tmpdir(), "keel-proj-"))
    dirs.push(dir)
    const daemon = start(dir, initRepo(join(dir, "alpha")))
    const c = await connect(daemon)
    const pid = daemon.project.project_id
    const mineTask = daemon.repo.createWorkItem({ project_id: pid, title: "vieja", kind: "chore" })
    const other = daemon.repo.createWorkItem({ project_id: pid, title: "otra", kind: "chore" })
    const run = daemon.repo.createRun({
      project_id: pid,
      work_item_id: mineTask.id,
      purpose: "execute",
    })
    const add = (runId: string | null, kind: string, payload: unknown) =>
      daemon.repo.appendEvent({
        project_id: pid,
        run_id: runId,
        source: "daemon",
        source_event_key: `${kind}:${Math.random()}`,
        fidelity: "full",
        adapter_version: "daemon/0",
        kind,
        occurred_at: null,
        payload_json: JSON.stringify(payload),
      })
    add(run.id, "sdk.assistant", { text: "consulta SQL" })
    add(null, "note.added", { work_item_id: mineTask.id })
    add(null, "note.added", { work_item_id: other.id })
    add(run.id, "projection.updated", {})
    const last = add(run.id, "sdk.result", { ok: true })?.event_seq ?? 0

    const all = (await c.call("events.history", {
      work_item_id: mineTask.id,
      before_event_seq: last + 1,
    })) as { events: { kind: string; event_seq: number }[]; more: boolean }
    const own = all.events.filter((e) =>
      ["sdk.assistant", "note.added", "sdk.result"].includes(e.kind),
    )
    expect(own.map((e) => e.kind)).toEqual(["sdk.assistant", "note.added", "sdk.result"])
    expect(all.events.some((e) => e.kind === "projection.updated")).toBe(false)
    expect(all.more).toBe(false)

    const page = (await c.call("events.history", {
      work_item_id: mineTask.id,
      before_event_seq: last,
      limit: 1,
    })) as { events: { kind: string }[]; more: boolean }
    expect(page.events.map((e) => e.kind)).toEqual(["note.added"])
    expect(page.more).toBe(true)
  })
})

describe("ADR-0034 §6: avisos entre proyectos", () => {
  test("una aprobación de otro proyecto avisa a toda ventana humana y se lista y resuelve desde ahí", async () => {
    const dir = mkdtempSync(join(tmpdir(), "keel-proj-"))
    dirs.push(dir)
    const a = initRepo(join(dir, "alpha"))
    const b = initRepo(join(dir, "beta"))
    const daemon = start(dir, a)
    const c = await connect(daemon)
    const beta = (await c.call("projects.open", { path: b })) as { id: string }
    // La ventana mira alpha.
    await c.call("projects.use", { project_id: daemon.project.project_id })
    const heard: { project_id: string; kind: string }[] = []
    c.onNotification((m, p) => {
      if (m === "attention.changed") heard.push(p as { project_id: string; kind: string })
    })
    const repo = daemon.repo
    const w = repo.createWorkItem({ project_id: beta.id, title: "desplegar beta", kind: "chore" })
    const run = repo.createRun({ project_id: beta.id, work_item_id: w.id, purpose: "execute" })
    const id = repo.createApproval({
      project_id: beta.id,
      run_id: run.id,
      operation_hash: "h",
      operation: { tool: "Bash", input: { command: "ls" }, run_id: run.id },
      expires_at: null,
    })
    ;(daemon as unknown as { emitSystem: (k: string, r: string, p: unknown) => void }).emitSystem(
      "approval.requested",
      run.id,
      {
        approval_id: id,
        operation_hash: "h",
        tool: "Bash",
        input: { command: "ls" },
        expires_at: null,
      },
    )
    const end = Date.now() + 5_000
    while (heard.length === 0 && Date.now() < end) await Bun.sleep(10)
    expect(heard[0]).toEqual({ project_id: beta.id, kind: "approval.requested" })

    // Sin all_projects, la ventana sólo ve las de su proyecto; con él, también la de beta.
    const own = (await c.call("approvals.list", {})) as { approvals: unknown[] }
    expect(own.approvals).toHaveLength(0)
    const all = (await c.call("approvals.list", { all_projects: true })) as {
      approvals: { id: string; project_name: string; work_item_title: string }[]
    }
    expect(all.approvals).toMatchObject([
      { id, project_name: "beta", work_item_title: "desplegar beta" },
    ])
    await c.call("approvals.resolve", {
      ...meta(),
      approval_id: id,
      operation_hash: "h",
      decision: "deny",
    })
    expect(repo.getApproval(id)?.state).toBe("denied")
  })
})
