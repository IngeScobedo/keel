/** ADR-0028: la rama base al día antes de trabajar, con un remoto real en disco. */
import { afterEach, describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
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
const meta = () => ({ request_id: "r", idempotency_key: crypto.randomUUID() })

/** Un `origin` bare, el checkout del humano y otra copia que empuja commits. */
async function boot() {
  const dir = mkdtempSync(join(tmpdir(), "keel-base-"))
  dirs.push(dir)
  const g = (cwd: string, ...args: string[]) =>
    execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" }).trim()
  const seed = initRepo(join(dir, "seed"))
  g(dir, "clone", "-q", "--bare", seed, "origin.git")
  g(dir, "clone", "-q", join(dir, "origin.git"), "repo")
  g(dir, "clone", "-q", join(dir, "origin.git"), "other")
  const repo = join(dir, "repo")
  const other = join(dir, "other")
  for (const r of [repo, other]) {
    g(r, "config", "user.name", "t")
    g(r, "config", "user.email", "t@e.com")
  }
  const commit = (cwd: string, file: string) => {
    writeFileSync(join(cwd, file), `${file}\n`)
    g(cwd, "add", file)
    g(cwd, "commit", "-q", "-m", file)
  }
  const daemon = new Daemon({
    dbPath: join(dir, "keel.sqlite"),
    socketPath: join(dir, "keel.sock"),
    rootPath: repo,
    worktreesDir: join(dir, "worktrees"),
    adapterDeps: { queryFn: replayQuery(), binary: "/fake/claude" },
    mcpBridge: false,
  })
  daemon.start()
  daemons.push(daemon)
  const human = await IpcClient.connect(daemon.server.path)
  clients.push(human)
  return { repo, other, g, commit, human }
}

type Base = {
  branch: string
  upstream: string | null
  ahead: number
  behind: number
  fetched: boolean
  error: string | null
}

describe("ADR-0028: la base al día", () => {
  test("avisa que main va atrás de origin y actualiza sólo avanzando", async () => {
    const { repo, other, g, commit, human } = await boot()
    commit(other, "a.txt")
    commit(other, "b.txt")
    g(other, "push", "-q", "origin", "main")
    const before = (await human.call("projects.base_check", {})) as Base
    expect(before).toMatchObject({
      branch: "main",
      upstream: "origin/main",
      behind: 2,
      ahead: 0,
      fetched: true,
      error: null,
    })
    // Un cambio local que no choca se conserva al avanzar.
    writeFileSync(join(repo, "local.txt"), "mío\n")
    const after = (await human.call("projects.pull", { ...meta() })) as Base
    expect(after.behind).toBe(0)
    expect(g(repo, "rev-parse", "HEAD")).toBe(g(other, "rev-parse", "HEAD"))
    expect(g(repo, "status", "--porcelain")).toContain("local.txt")
  })

  test("con historia divergente no toca nada y dice por qué", async () => {
    const { repo, other, g, commit, human } = await boot()
    commit(other, "remoto.txt")
    g(other, "push", "-q", "origin", "main")
    commit(repo, "local.txt")
    const head = g(repo, "rev-parse", "HEAD")
    const state = (await human.call("projects.base_check", {})) as Base
    expect(state).toMatchObject({ ahead: 1, behind: 1 })
    const err = await human.call("projects.pull", { ...meta() }).catch((e: Error) => e.message)
    expect(String(err)).toMatch(/fast-forward|Not possible|diverg/i)
    expect(g(repo, "rev-parse", "HEAD")).toBe(head)
  })

  test("sin remoto lo dice y no falla", async () => {
    const { repo, g, human } = await boot()
    g(repo, "branch", "--unset-upstream")
    const state = (await human.call("projects.base_check", {})) as Base
    expect(state.upstream).toBeNull()
    expect(state.error).toContain("no sigue a ningún remoto")
  })
})
