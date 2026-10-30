/**
 * Un repo con el flujo de zero-reports (ADR-0043): development → stage → main, PRs con
 * merge commit, promociones con su mensaje y los workflows que despliegan. El remoto es
 * un repo bare local.
 */
import { execFileSync } from "node:child_process"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"

export function makeFlowRepo(repo: string, origin: string): void {
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "Dev",
    GIT_AUTHOR_EMAIL: "dev@x",
    GIT_COMMITTER_NAME: "Dev",
    GIT_COMMITTER_EMAIL: "dev@x",
  }
  const sh = (...args: string[]) => execFileSync("git", args, { cwd: repo, env, encoding: "utf8" })
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin])
  sh("remote", "add", "origin", origin)
  const base = sh("rev-parse", "--abbrev-ref", "HEAD").trim()
  if (base !== "main") sh("branch", "-M", base, "main")
  mkdirSync(join(repo, ".github", "workflows"), { recursive: true })
  writeFileSync(
    join(repo, ".github", "workflows", "deploy-stage.yml"),
    "name: Deploy · stage\non:\n  push:\n    branches: [stage]\njobs: {}\n",
  )
  writeFileSync(
    join(repo, ".github", "workflows", "deploy-prod.yml"),
    "name: Deploy · prod\non:\n  push:\n    branches: [main]\njobs: {}\n",
  )
  sh("add", ".github")
  sh("commit", "-q", "-m", "ci: deploys de stage y prod")
  sh("branch", "development")
  sh("branch", "stage")
  const pr = (n: number) => {
    sh("checkout", "-q", "-b", `fix/cambio-${n}`, "development")
    writeFileSync(join(repo, `cambio-${n}.txt`), `${n}\n`)
    sh("add", `cambio-${n}.txt`)
    sh("commit", "-q", "-m", `fix(api): cambio ${n}`)
    sh("checkout", "-q", "development")
    sh("merge", "-q", "--no-ff", `fix/cambio-${n}`, "-m", `Merge pull request #${n} from o/fix/cambio-${n}\n\nfix(api): cambio ${n}`)
  }
  const promo = (from: string, to: string) => {
    sh("checkout", "-q", to)
    sh("merge", "-q", "--no-ff", from, "-m", `chore(release): promueve ${from} a ${to}`)
  }
  for (const n of [1, 2]) {
    pr(n)
    promo("development", "stage")
    promo("stage", "main")
  }
  pr(3)
  sh("checkout", "-q", "development")
  sh("push", "-q", "origin", "main", "stage", "development")
}
