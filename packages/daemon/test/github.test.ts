/**
 * ADR-0043 contra el daemon real y un `gh` falso: la sesión, el inicio de sesión de
 * `gh` (Keel sólo muestra su código), la PR con su merge sólo humano y los runs con sus
 * pasos y su «suele tardar».
 */
import { afterEach, describe, expect, test } from "bun:test"
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Daemon, IpcClient } from "../src/index.ts"
import { initRepo } from "./git-fixture.ts"
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

const PR = {
  number: 51,
  title: "fix(api): corrige la portada",
  url: "https://github.com/o/r/pull/51",
  state: "OPEN",
  isDraft: false,
  baseRefName: "development",
  headRefName: "fix/api-portada",
  headRefOid: "abc1234",
  mergeable: "MERGEABLE",
  mergeStateStatus: "CLEAN",
  reviewDecision: "APPROVED",
  additions: 3,
  deletions: 1,
  author: { login: "dev" },
  mergedAt: null,
  mergedBy: null,
  body: "",
  statusCheckRollup: [
    {
      __typename: "CheckRun",
      name: "main",
      workflowName: "CI",
      status: "COMPLETED",
      conclusion: "SUCCESS",
      detailsUrl: "https://github.com/o/r/actions/runs/7/job/1",
    },
  ],
  files: [{ path: "a.ts", additions: 3, deletions: 1 }],
}
const RUN = {
  databaseId: 7,
  workflowName: "Deploy · stage",
  displayTitle: "chore(release): promueve development a stage",
  status: "in_progress",
  conclusion: "",
  event: "push",
  headBranch: "stage",
  headSha: "c2db8f7",
  url: "https://github.com/o/r/actions/runs/7",
  createdAt: "2026-10-30T10:00:00Z",
  updatedAt: "2026-10-30T10:03:00Z",
  attempt: 1,
}

async function boot() {
  const dir = mkdtempSync(join(tmpdir(), "keel-gh-"))
  dirs.push(dir)
  initRepo(join(dir, "repo"))
  const state = join(dir, "pr-state")
  writeFileSync(state, "OPEN")
  const log = join(dir, "calls.jsonl")
  const gh = join(dir, "gh")
  writeFileSync(
    gh,
    `#!/usr/bin/env node
const fs = require("node:fs")
const args = process.argv.slice(2)
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + "\\n")
const out = (s) => process.stdout.write(typeof s === "string" ? s : JSON.stringify(s))
const pr = () => ({ ...${JSON.stringify(PR)}, state: fs.readFileSync(${JSON.stringify(state)}, "utf8"), mergedBy: fs.readFileSync(${JSON.stringify(state)}, "utf8") === "MERGED" ? { login: "IngeScobedo" } : null })
const [a, b] = args
if (a === "--version") out("gh version 2.96.0\\n")
else if (a === "auth" && b === "status") out({ hosts: { "github.com": [{ state: "success", active: true, host: "github.com", login: "IngeScobedo", scopes: "repo, workflow", gitProtocol: "ssh" }] } })
else if (a === "auth" && b === "login") { process.stderr.write("! First copy your one-time code: ABCD-1234\\nOpen this URL to continue in your web browser: https://github.com/login/device\\n"); setTimeout(() => process.exit(0), 300) }
else if (a === "repo") out({ nameWithOwner: "o/r", url: "https://github.com/o/r", defaultBranchRef: { name: "main" }, mergeCommitAllowed: true, squashMergeAllowed: true, rebaseMergeAllowed: false, deleteBranchOnMerge: false })
else if (a === "pr" && b === "view") out(pr())
else if (a === "pr" && b === "list") out([pr()])
else if (a === "pr" && b === "merge") { if (args[args.indexOf("--match-head-commit") + 1] !== "abc1234") { process.stderr.write("Head branch was modified. Review and try the merge again."); process.exit(1) } fs.writeFileSync(${JSON.stringify(state)}, "MERGED") }
else if (a === "api") out("")
else if (a === "run" && b === "list") out(args.includes("--workflow") ? [{ ...${JSON.stringify(RUN)}, databaseId: 1, status: "completed", conclusion: "success", createdAt: "2026-10-29T10:00:00Z", updatedAt: "2026-10-29T10:09:00Z" }, { ...${JSON.stringify(RUN)}, databaseId: 2, status: "completed", conclusion: "success", createdAt: "2026-10-28T10:00:00Z", updatedAt: "2026-10-28T10:08:00Z" }, { ...${JSON.stringify(RUN)}, databaseId: 3, status: "completed", conclusion: "failure", createdAt: "2026-10-27T10:00:00Z", updatedAt: "2026-10-27T10:01:00Z" }] : [${JSON.stringify(RUN)}])
else if (a === "run" && b === "view" && args.includes("--log-failed")) out("deploy\\tRollout\\t2026-10-30T10:01:00.1Z Error: token=ghp_abcdefghijklmnopqrstuvwxyz0123456789 rechazado\\n")
else if (a === "run" && b === "view") out({ ...${JSON.stringify(RUN)}, jobs: [{ name: "deploy", status: "in_progress", conclusion: "", startedAt: "2026-10-30T10:00:05Z", steps: [{ name: "Build + push", status: "completed", conclusion: "success", startedAt: "2026-10-30T10:00:10Z", completedAt: "2026-10-30T10:02:00Z" }, { name: "Rollout de stage", status: "in_progress", conclusion: "", startedAt: "2026-10-30T10:02:00Z", completedAt: null }] }] })
else if (a === "run" && b === "rerun") out("")
else { process.stderr.write("no sé " + args.join(" ")); process.exit(1) }
`,
  )
  chmodSync(gh, 0o755)
  const daemon = new Daemon({
    dbPath: join(dir, "keel.sqlite"),
    socketPath: join(dir, "keel.sock"),
    rootPath: join(dir, "repo"),
    worktreesDir: join(dir, "worktrees"),
    adapterDeps: { queryFn: replayQuery(), binary: "/fake/claude" },
    mcpBridge: false,
    gh,
  })
  daemon.start()
  daemons.push(daemon)
  const human = await IpcClient.connect(daemon.server.path)
  clients.push(human)
  const calls = () =>
    readFileSync(log, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as string[])
  return { daemon, human, calls, dir }
}

describe.skipIf(process.platform === "win32")("ADR-0043: GitHub por el gh del humano", () => {
  test("la sesión y el repo: cuenta, protocolo y métodos de merge permitidos", async () => {
    const { human } = await boot()
    const st = (await human.call("github.status", {})) as {
      gh: { ready: boolean; accounts: { login: string }[] }
      repo: { name_with_owner: string; merge_methods: string[]; default_branch: string }
    }
    expect(st.gh.ready).toBe(true)
    expect(st.gh.accounts[0]?.login).toBe("IngeScobedo")
    expect(st.repo).toMatchObject({
      name_with_owner: "o/r",
      default_branch: "main",
      merge_methods: ["merge", "squash"],
    })
  })

  test("iniciar sesión: Keel muestra el código que imprime gh y ve terminar el login", async () => {
    const { human, calls } = await boot()
    const started = (await human.call("github.login", { ...meta() })) as { state: string }
    expect(started.state).toBe("waiting")
    let s = { state: "waiting", code: null as string | null, url: null as string | null }
    for (let i = 0; i < 20 && !s.code; i++) {
      await Bun.sleep(25)
      s = (await human.call("github.login_state", {})) as typeof s
    }
    expect(s).toMatchObject({ code: "ABCD-1234", url: "https://github.com/login/device" })
    for (let i = 0; i < 40 && s.state === "waiting"; i++) {
      await Bun.sleep(25)
      s = (await human.call("github.login_state", {})) as typeof s
    }
    expect(s).toMatchObject({ state: "done", code: null })
    const login = calls().find((c) => c[0] === "auth" && c[1] === "login")
    expect(login).toEqual([
      "auth",
      "login",
      "--hostname",
      "github.com",
      "--web",
      "--git-protocol",
      "ssh",
      "--skip-ssh-key",
    ])
  })

  test("la PR y su merge: sólo humano, atado a la cabeza vista; si cambió, conflicto", async () => {
    const { human, daemon, calls } = await boot()
    const pr = (await human.call("github.pr", { number: 51 })) as {
      state: string
      head_sha: string
      checks: { name: string; workflow: string; conclusion: string }[]
    }
    expect(pr).toMatchObject({ state: "open", head_sha: "abc1234" })
    expect(pr.checks[0]).toMatchObject({ name: "main", workflow: "CI", conclusion: "success" })

    await expect(
      human.call("github.pr_merge", {
        ...meta(),
        number: 51,
        method: "squash",
        head_sha: "old0000",
      }),
    ).rejects.toThrow("Head branch was modified")

    const merged = (await human.call("github.pr_merge", {
      ...meta(),
      number: 51,
      method: "squash",
      head_sha: "abc1234",
      subject: "fix(api): corrige la portada (#51)",
      delete_branch: true,
    })) as { state: string; merged_by: string }
    expect(merged).toMatchObject({ state: "merged", merged_by: "IngeScobedo" })
    const merge = calls()
      .filter((c) => c[0] === "pr" && c[1] === "merge")
      .at(-1)
    expect(merge).toEqual([
      "pr",
      "merge",
      "51",
      "--squash",
      "--match-head-commit",
      "abc1234",
      "--subject",
      "fix(api): corrige la portada (#51)",
    ])
    expect(calls().at(-2)).toEqual([
      "api",
      "-X",
      "DELETE",
      "repos/{owner}/{repo}/git/refs/heads/fix/api-portada",
    ])
    const ev = daemon.repo.eventsAfter(0, null, 1000).find((e) => e.kind === "github.pr.merged")
    expect(JSON.parse(ev?.payload_json ?? "{}")).toMatchObject({ number: 51, method: "squash" })
  })

  test("un run con sus pasos, su «suele tardar» y el log fallido redactado", async () => {
    const { human } = await boot()
    const runs = (await human.call("github.runs", { commit: "c2db8f7" })) as {
      runs: { id: number; workflow: string; status: string }[]
    }
    expect(runs.runs[0]).toMatchObject({ id: 7, workflow: "Deploy · stage", status: "in_progress" })
    const run = (await human.call("github.run", { id: 7 })) as {
      typical_ms: number
      jobs: { steps: { name: string; status: string }[] }[]
    }
    expect(run.jobs[0]?.steps.map((s) => [s.name, s.status])).toEqual([
      ["Build + push", "completed"],
      ["Rollout de stage", "in_progress"],
    ])
    // Mediana de las verdes (9 y 8 min): la fallida no cuenta.
    expect(run.typical_ms).toBe(9 * 60_000)
    const log = (await human.call("github.run_log", { id: 7 })) as { tail: string }
    expect(log.tail).toContain("rechazado")
    expect(log.tail).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123456789")
  })
})
