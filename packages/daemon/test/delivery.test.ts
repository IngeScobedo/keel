/**
 * ADR-0043 §4 y §6 contra un remoto real (repo bare) y un `gh` doble: el flujo se
 * detecta de la historia y de los workflows, la promoción se ata a las cabezas vistas,
 * a producción pide confirmar y el gate espera el deploy verde; un conflicto no se
 * resuelve a ciegas. El checkout del humano no se toca.
 */
import { afterEach, describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Daemon, IpcClient } from "../src/index.ts"
import { replayQuery } from "./replay.ts"

const dirs: string[] = []
const daemons: Daemon[] = []
const clients: IpcClient[] = []
afterEach(() => {
  for (const c of clients.splice(0)) c.close()
  for (const d of daemons.splice(0)) d.stop()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
const meta = () => ({ request_id: "t", idempotency_key: crypto.randomUUID() })

function sh(cwd: string, ...args: string[]) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Dev",
      GIT_AUTHOR_EMAIL: "dev@x",
      GIT_COMMITTER_NAME: "Dev",
      GIT_COMMITTER_EMAIL: "dev@x",
    },
  }).trim()
}

/** Un repo con development → stage → main y su historia, como zero-reports. */
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "keel-delivery-"))
  dirs.push(dir)
  const origin = join(dir, "origin.git")
  sh(dir, "init", "-q", "--bare", "-b", "main", origin)
  const repo = join(dir, "repo")
  sh(dir, "clone", "-q", origin, repo)
  const commit = (file: string, text: string, msg: string) => {
    writeFileSync(join(repo, file), text)
    sh(repo, "add", file)
    sh(repo, "commit", "-q", "-m", msg)
  }
  mkdirSync(join(repo, ".github", "workflows"), { recursive: true })
  writeFileSync(
    join(repo, ".github", "workflows", "deploy-stage.yml"),
    "name: Deploy · stage\non:\n  push:\n    branches: [stage]\njobs: {}\n",
  )
  writeFileSync(
    join(repo, ".github", "workflows", "deploy-prod.yml"),
    "name: Deploy · prod\non:\n  push:\n    branches: [main]\njobs: {}\n",
  )
  writeFileSync(join(repo, "CLAUDE.md"), "- NUNCA `Co-Authored-By: Claude` en ningún commit.\n")
  commit("README.md", "hola\n", "chore: inicio")
  sh(repo, "branch", "development")
  sh(repo, "branch", "stage")
  const pr = (n: number, branch: string, file: string) => {
    sh(repo, "checkout", "-q", "-b", branch, "development")
    commit(file, `${branch}\n`, `fix(api): cambio ${n}`)
    sh(repo, "checkout", "-q", "development")
    sh(
      repo,
      "merge",
      "-q",
      "--no-ff",
      branch,
      "-m",
      `Merge pull request #${n} from o/${branch}\n\nfix(api): cambio ${n}`,
    )
  }
  const promo = (from: string, to: string) => {
    sh(repo, "checkout", "-q", to)
    sh(repo, "merge", "-q", "--no-ff", from, "-m", `chore(release): promueve ${from} a ${to}`)
  }
  for (const n of [1, 2]) {
    pr(n, `fix/cambio-${n}`, `f${n}.txt`)
    promo("development", "stage")
    promo("stage", "main")
  }
  pr(3, "fix/cambio-3", "f3.txt")
  sh(repo, "checkout", "-q", "development")
  sh(repo, "push", "-q", "origin", "main", "stage", "development")
  return { dir, repo, origin, commit, sh: (...a: string[]) => sh(repo, ...a) }
}

async function boot() {
  const f = fixture()
  const runs = join(f.dir, "runs.json")
  writeFileSync(runs, "[]")
  const gh = join(f.dir, "gh")
  writeFileSync(
    gh,
    `#!/usr/bin/env node
const fs = require("node:fs")
const args = process.argv.slice(2)
const out = (s) => process.stdout.write(JSON.stringify(s))
if (args[0] === "--version") process.stdout.write("gh version 2.96.0\\n")
else if (args[0] === "auth") out({ hosts: { "github.com": [{ state: "success", active: true, host: "github.com", login: "dev", gitProtocol: "ssh" }] } })
else if (args[0] === "run" && args[1] === "list") { const all = JSON.parse(fs.readFileSync(${JSON.stringify(runs)}, "utf8")); const i = args.indexOf("--commit"); out(i >= 0 ? all.filter((r) => r.headSha === args[i + 1]) : []) }
else if (args[0] === "pr" && args[1] === "list") out([])
else { process.stderr.write("no sé " + args.join(" ")); process.exit(1) }
`,
  )
  chmodSync(gh, 0o755)
  const daemon = new Daemon({
    dbPath: join(f.dir, "keel.sqlite"),
    socketPath: join(f.dir, "keel.sock"),
    rootPath: f.repo,
    worktreesDir: join(f.dir, "worktrees"),
    adapterDeps: { queryFn: replayQuery(), binary: "/fake/claude" },
    mcpBridge: false,
    gh,
  })
  daemon.start()
  daemons.push(daemon)
  const human = await IpcClient.connect(daemon.server.path)
  clients.push(human)
  const setRuns = (r: unknown[]) => writeFileSync(runs, JSON.stringify(r))
  return { ...f, daemon, human, setRuns }
}

type Status = {
  flow: {
    work_base: string
    pr_merge_method: string
    promotions: { from: string; to: string; environment: string; requires: string[] }[]
  }
  flow_source: string
  branches: { name: string; head: { sha: string } | null }[]
  promotions: {
    from: string
    to: string
    from_sha: string
    to_sha: string
    pending: { pr: number | null; title: string }[]
    blocked_by: string[]
  }[]
}

describe("ADR-0043: Entregas y promociones", () => {
  test("detecta el flujo; promueve atado a las cabezas; a prod confirma y espera el deploy", async () => {
    const { human, daemon, sh, origin, setRuns, commit } = await boot()
    const st = (await human.call("delivery.status", {})) as Status
    expect(st.flow_source).toBe("detected")
    expect(st.flow).toMatchObject({
      work_base: "development",
      pr_merge_method: "merge",
      promotions: [
        { from: "development", to: "stage", environment: "staging", requires: [] },
        { from: "stage", to: "main", environment: "prod", requires: ["Deploy · stage"] },
      ],
    })
    const toStage = st.promotions[0] as Status["promotions"][number]
    expect(toStage.pending.map((c) => [c.pr, c.title])).toEqual([[3, "fix(api): cambio 3"]])
    expect(toStage.blocked_by).toEqual([])
    const toMain = st.promotions[1] as Status["promotions"][number]
    expect(toMain.blocked_by).toEqual([
      "stage ya tiene todo lo de main".replace(
        "stage ya tiene todo lo de main",
        "main ya tiene todo lo de stage",
      ),
    ])

    // Si development se mueve después de verlo, el plan caduca.
    const userHead = sh("rev-parse", "HEAD")
    commit("f4.txt", "4\n", "fix(api): cambio 4 directo")
    sh("push", "-q", "origin", "development")
    await expect(
      human.call("delivery.promote", {
        ...meta(),
        from: "development",
        to: "stage",
        from_sha: toStage.from_sha,
        to_sha: toStage.to_sha,
      }),
    ).rejects.toThrow("caducó")

    // Con las cabezas de ahora, se promueve: merge con el mensaje del proyecto, sin checkout.
    const fresh = (await human.call("delivery.status", {})) as Status
    const p = fresh.promotions[0] as Status["promotions"][number]
    const done = (await human.call("delivery.promote", {
      ...meta(),
      from: "development",
      to: "stage",
      from_sha: p.from_sha,
      to_sha: p.to_sha,
    })) as { sha: string }
    const remoteStage = execFileSync("git", ["rev-parse", "stage"], {
      cwd: origin,
      encoding: "utf8",
    }).trim()
    expect(remoteStage).toBe(done.sha)
    const parents = execFileSync("git", ["log", "-1", "--format=%P%n%s", done.sha], {
      cwd: origin,
      encoding: "utf8",
    })
    expect(parents).toContain(`${p.to_sha} ${p.from_sha}`)
    expect(parents).toContain("chore(release): promueve development a stage")
    expect(parents).not.toContain("Co-Authored-By")
    // El checkout del humano sigue donde estaba (development, con su commit nuevo).
    expect(sh("rev-parse", "--abbrev-ref", "HEAD")).toBe("development")
    expect(sh("rev-parse", "HEAD")).not.toBe(userHead)
    const ev = daemon.repo
      .eventsAfter(0, null, 5000)
      .find((e) => e.kind === "git.promotion.completed")
    expect(JSON.parse(ev?.payload_json ?? "{}")).toMatchObject({
      from: "development",
      to: "stage",
      sha: done.sha,
      prs: [3],
    })

    // A producción: sin el deploy de stage verde no se puede, y pide confirmar.
    const prod = ((await human.call("delivery.status", {})) as Status)
      .promotions[1] as Status["promotions"][number]
    expect(prod.blocked_by).toEqual([`Deploy · stage no corrió para ${done.sha.slice(0, 7)}`])
    setRuns([
      {
        databaseId: 1,
        workflowName: "Deploy · stage",
        status: "in_progress",
        conclusion: "",
        event: "push",
        headBranch: "stage",
        headSha: done.sha,
        url: "https://github.com/o/r/actions/runs/1",
        createdAt: "2026-10-30T10:00:00Z",
        updatedAt: "2026-10-30T10:01:00Z",
      },
    ])
    const running = ((await human.call("delivery.status", {})) as Status)
      .promotions[1] as Status["promotions"][number]
    expect(running.blocked_by[0]).toContain("sigue corriendo")
    setRuns([
      {
        databaseId: 1,
        workflowName: "Deploy · stage",
        status: "completed",
        conclusion: "success",
        event: "push",
        headBranch: "stage",
        headSha: done.sha,
        url: "https://github.com/o/r/actions/runs/1",
        createdAt: "2026-10-30T10:00:00Z",
        updatedAt: "2026-10-30T10:09:00Z",
      },
    ])
    const green = ((await human.call("delivery.status", {})) as Status)
      .promotions[1] as Status["promotions"][number]
    expect(green.blocked_by).toEqual([])
    const args = {
      ...meta(),
      from: "stage",
      to: "main",
      from_sha: green.from_sha,
      to_sha: green.to_sha,
    }
    await expect(human.call("delivery.promote", args)).rejects.toThrow("producción")
    const prodDone = (await human.call("delivery.promote", {
      ...args,
      ...meta(),
      confirm_prod: true,
    })) as { sha: string }
    expect(
      execFileSync("git", ["rev-parse", "main"], { cwd: origin, encoding: "utf8" }).trim(),
    ).toBe(prodDone.sha)
  }, 60_000)

  test("un conflicto no se resuelve a ciegas: dice los archivos y no empuja nada", async () => {
    const { human, sh, origin } = await boot()
    // stage recibe un cambio propio que choca con lo que trae development.
    sh("checkout", "-q", "stage")
    writeFileSync(join(sh("rev-parse", "--show-toplevel"), "f3.txt"), "hotfix en stage\n")
    sh("add", "f3.txt")
    sh("commit", "-q", "-m", "fix: hotfix directo en stage")
    sh("push", "-q", "origin", "stage")
    sh("checkout", "-q", "development")
    const before = execFileSync("git", ["rev-parse", "stage"], {
      cwd: origin,
      encoding: "utf8",
    }).trim()
    const p = ((await human.call("delivery.status", {})) as Status)
      .promotions[0] as Status["promotions"][number]
    const err = await human
      .call("delivery.promote", {
        ...meta(),
        from: "development",
        to: "stage",
        from_sha: p.from_sha,
        to_sha: p.to_sha,
      })
      .catch((e: unknown) => e as { message: string; rpc?: { details?: { conflicts?: string[] } } })
    expect((err as { message: string }).message).toContain("conflictos")
    expect((err as { rpc: { details: { conflicts: string[] } } }).rpc.details.conflicts).toEqual([
      "f3.txt",
    ])
    expect(
      execFileSync("git", ["rev-parse", "stage"], { cwd: origin, encoding: "utf8" }).trim(),
    ).toBe(before)
  }, 60_000)
})
