/**
 * Un `gh` doble para los flujos de la GUI (ADR-0043): sesión de IngeScobedo, el repo
 * de zero-reports, la PR #51 abierta hasta que se mergea y un run de `Deploy · stage`
 * que avanza con el reloj (≈6 s en curso, luego verde). Nunca toca GitHub.
 */
import { chmodSync, mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"

export function writeFakeGh(dir: string, opts: { loggedIn?: boolean } = {}): string {
  mkdirSync(dir, { recursive: true })
  const state = join(dir, "gh-state")
  mkdirSync(state, { recursive: true })
  if (opts.loggedIn === false) writeFileSync(join(state, "logged"), "0")
  const gh = join(dir, "gh")
  writeFileSync(
    gh,
    `#!/usr/bin/env node
const fs = require("node:fs")
const path = require("node:path")
const st = ${JSON.stringify(state)}
fs.mkdirSync(st, { recursive: true })
const read = (k, d) => { try { return fs.readFileSync(path.join(st, k), "utf8") } catch { return d } }
const write = (k, v) => fs.writeFileSync(path.join(st, k), String(v))
const args = process.argv.slice(2)
const out = (s) => process.stdout.write(typeof s === "string" ? s : JSON.stringify(s))
const iso = (ms) => new Date(ms).toISOString().replace(/\\.\\d+Z$/, "Z")
const [a, b] = args
const pr = () => {
  const merged = read("pr", "OPEN") === "MERGED"
  return { number: 51, title: "fix(api): corrige la portada de Pre Purchase", url: "https://github.com/inprodiwebstudio/zero-reports-mono/pull/51", state: merged ? "MERGED" : "OPEN", isDraft: false, baseRefName: "development", headRefName: "fix/api-pre-purchase-cover-layout", headRefOid: "932834a0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6", mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", reviewDecision: "APPROVED", additions: 33, deletions: 3, author: { login: "inprodi-web-studio" }, mergedAt: merged ? read("merged-at", iso(Date.now())) : null, mergedBy: merged ? { login: "IngeScobedo" } : null, body: "", statusCheckRollup: [{ __typename: "CheckRun", name: "main", workflowName: "CI", status: "COMPLETED", conclusion: "SUCCESS", startedAt: "2026-10-30T10:00:00Z", completedAt: "2026-10-30T10:01:30Z", detailsUrl: "https://github.com/inprodiwebstudio/zero-reports-mono/actions/runs/7" }], files: [{ path: "apps/api/src/app/report-documents/services/report-documents.service.ts", additions: 18, deletions: 3 }, { path: "apps/api/src/app/report-documents/processors/report-document.processor.ts", additions: 1, deletions: 0 }] }
}
const run = () => {
  const t0 = Number(read("run-start", "0")) || Date.now()
  if (read("run-start", "") === "") write("run-start", t0)
  const done = Date.now() - t0 > 6000
  const step = (name, from, to) => ({ name, status: Date.now() - t0 >= to ? "completed" : Date.now() - t0 >= from ? "in_progress" : "queued", conclusion: Date.now() - t0 >= to ? "success" : "", startedAt: Date.now() - t0 >= from ? iso(t0 + from) : null, completedAt: Date.now() - t0 >= to ? iso(t0 + to) : null })
  return { databaseId: 7, workflowName: "Deploy · stage", displayTitle: "chore(release): promueve development a stage", status: done ? "completed" : "in_progress", conclusion: done ? "success" : "", event: "push", headBranch: "stage", headSha: "c2db8f7a0ed6148e93fd151c7da237ecaab99f4b", url: "https://github.com/inprodiwebstudio/zero-reports-mono/actions/runs/7", createdAt: iso(t0), updatedAt: iso(done ? t0 + 6000 : Date.now()), attempt: 1, jobs: [{ name: "deploy", status: done ? "completed" : "in_progress", conclusion: done ? "success" : "", startedAt: iso(t0), steps: [step("Build + push (tags <sha> + stage)", 0, 3000), step("Rollout de stage (corre migraciones + actualiza services)", 3000, 6000)] }] }
}
if (a === "--version") out("gh version 2.96.0 (2026-07-02)\\n")
else if (a === "auth" && b === "status") read("logged", "1") === "1" ? out({ hosts: { "github.com": [{ state: "success", active: true, host: "github.com", login: "IngeScobedo", scopes: "repo, workflow", gitProtocol: "ssh" }] } }) : (process.stderr.write("You are not logged into any GitHub hosts. To log in, run: gh auth login"), process.exit(1))
else if (a === "auth" && b === "login") { process.stderr.write("! First copy your one-time code: KEEL-2026\\nOpen this URL to continue in your web browser: https://github.com/login/device\\n"); setTimeout(() => { write("logged", "1"); process.exit(0) }, 1500) }
else if (a === "repo") out({ nameWithOwner: "inprodiwebstudio/zero-reports-mono", url: "https://github.com/inprodiwebstudio/zero-reports-mono", defaultBranchRef: { name: "main" }, mergeCommitAllowed: true, squashMergeAllowed: true, rebaseMergeAllowed: true, deleteBranchOnMerge: false })
else if (a === "pr" && b === "view") read("logged", "1") === "1" ? out(pr()) : (process.stderr.write("To get started with GitHub CLI, please run: gh auth login"), process.exit(4))
else if (a === "pr" && b === "list") out([pr()])
else if (a === "pr" && b === "merge") { write("pr", "MERGED"); write("merged-at", iso(Date.now())); write("merge-args", JSON.stringify(args)) }
else if (a === "api") out("")
else if (a === "run" && b === "list") { const i = args.indexOf("--branch"); const c = args.indexOf("--commit"); const one = ({ jobs, ...r }) => (c >= 0 ? { ...r, headSha: args[c + 1] } : r); out(i >= 0 && args[i + 1] !== "stage" ? [] : [run()].map(one)) }
else if (a === "run" && b === "view") out(run())
else { process.stderr.write("gh doble: no sé " + args.join(" ")); process.exit(1) }
`,
  )
  chmodSync(gh, 0o755)
  return gh
}
