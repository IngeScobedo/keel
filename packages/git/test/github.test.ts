/**
 * @keel/git/github contra un `gh` falso que registra sus argumentos: la sesión sin
 * token, el merge atado a la cabeza vista y sin tocar el checkout, y los errores tipados.
 */
import { afterEach, describe, expect, test } from "bun:test"
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  failedLogTail,
  GhError,
  ghStatus,
  mergePullRequest,
  pullRequest,
} from "../src/github/index.ts"

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

/** Un `gh` en Node: responde según los argumentos y deja cada llamada en `calls`. */
function fakeGh(script: string): { gh: string; cwd: string; calls: () => string[][] } {
  const dir = mkdtempSync(join(tmpdir(), "keel-gh-"))
  dirs.push(dir)
  const log = join(dir, "calls.jsonl")
  const gh = join(dir, "gh")
  writeFileSync(
    gh,
    `#!/usr/bin/env node
const fs = require("node:fs")
const args = process.argv.slice(2)
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + "\\n")
const out = (s) => process.stdout.write(typeof s === "string" ? s : JSON.stringify(s))
const fail = (msg, code = 1) => { process.stderr.write(msg); process.exit(code) }
${script}
`,
  )
  chmodSync(gh, 0o755)
  return {
    gh,
    cwd: dir,
    calls: () =>
      readFileSync(log, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l)),
  }
}

const PR = {
  number: 51,
  title: "fix(api): corrige la portada",
  url: "https://github.com/o/r/pull/51",
  state: "OPEN",
  isDraft: false,
  baseRefName: "development",
  headRefName: "fix/api-portada",
  headRefOid: "abc123",
  mergeable: "MERGEABLE",
  mergeStateStatus: "CLEAN",
  reviewDecision: "APPROVED",
  additions: 3,
  deletions: 1,
  author: { login: "dev" },
  mergedAt: null,
  mergedBy: null,
  body: "",
  statusCheckRollup: [{ __typename: "CheckRun", name: "main", status: "IN_PROGRESS", conclusion: "" }],
  files: [{ path: "a.ts", additions: 3, deletions: 1 }],
}

describe.skipIf(process.platform === "win32")("@keel/git/github", () => {
  test("la sesión: cuenta, scopes y protocolo, sin pedir el token", async () => {
    const f = fakeGh(`
if (args[0] === "--version") out("gh version 2.96.0 (2026-07-02)\\n")
else if (args[0] === "auth") out({ hosts: { "github.com": [{ state: "success", active: true, host: "github.com", login: "IngeScobedo", tokenSource: "keyring", scopes: "repo, workflow", gitProtocol: "ssh" }] } })
`)
    const st = await ghStatus({ cwd: f.cwd, gh: f.gh })
    expect(st).toEqual({
      installed: true,
      version: "2.96.0",
      ready: true,
      accounts: [
        {
          host: "github.com",
          login: "IngeScobedo",
          active: true,
          ok: true,
          scopes: ["repo", "workflow"],
          git_protocol: "ssh",
          error: null,
        },
      ],
    })
    expect(JSON.stringify(st)).not.toContain("keyring")
    expect(f.calls().flat()).not.toContain("--show-token")
  })

  test("sin gh o sin sesión se dice, no se rompe", async () => {
    const missing = await ghStatus({ cwd: tmpdir(), gh: "/no/existe/gh" })
    expect(missing).toMatchObject({ installed: false, ready: false })
    const f = fakeGh(`
if (args[0] === "--version") out("gh version 2.96.0\\n")
else fail("You are not logged into any GitHub hosts. To log in, run: gh auth login")
`)
    expect(await ghStatus({ cwd: f.cwd, gh: f.gh })).toMatchObject({
      installed: true,
      accounts: [],
      ready: false,
    })
    await expect(pullRequest({ cwd: f.cwd, gh: f.gh }, 51)).rejects.toMatchObject({
      kind: "unauthenticated",
    })
  })

  test("merge: atado a la cabeza vista; la rama se borra en el remoto, no en el checkout", async () => {
    const f = fakeGh(`
if (args[0] === "pr" && args[1] === "view") out(${JSON.stringify(PR)})
`)
    const opts = { cwd: f.cwd, gh: f.gh }
    const pr = await pullRequest(opts, 51)
    expect(pr.statusCheckRollup?.[0]?.status).toBe("IN_PROGRESS")
    await mergePullRequest(opts, 51, {
      method: "squash",
      headSha: pr.headRefOid,
      subject: "fix(api): corrige la portada (#51)",
      deleteBranch: pr.headRefName,
    })
    const [, merge, del] = f.calls()
    expect(merge).toEqual([
      "pr",
      "merge",
      "51",
      "--squash",
      "--match-head-commit",
      "abc123",
      "--subject",
      "fix(api): corrige la portada (#51)",
    ])
    expect(merge).not.toContain("--delete-branch")
    expect(del).toEqual(["api", "-X", "DELETE", "repos/{owner}/{repo}/git/refs/heads/fix/api-portada"])
  })

  test("GitHub rechaza un merge si la cabeza cambió: error `rejected`", async () => {
    const f = fakeGh(`fail("GraphQL: Head branch was modified. Review and try the merge again. (mergePullRequest)")`)
    const merge = mergePullRequest({ cwd: f.cwd, gh: f.gh }, 51, { method: "merge", headSha: "old" })
    await expect(merge).rejects.toBeInstanceOf(GhError)
    await expect(merge).rejects.toMatchObject({ kind: "rejected" })
  })

  test("el log de los pasos fallidos llega sin el prefijo de job, paso y hora", async () => {
    const f = fakeGh(`out("deploy\\tBuild\\t2026-10-30T10:00:00.1Z step 1\\ndeploy\\tBuild\\t2026-10-30T10:00:01.2Z ERROR: no space left\\n")`)
    expect(await failedLogTail({ cwd: f.cwd, gh: f.gh }, 7)).toBe("step 1\nERROR: no space left")
  })
})
