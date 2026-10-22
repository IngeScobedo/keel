import { execFileSync } from "node:child_process"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"

/** Repo git real con un commit, para los runs `execute` (SDD 04 Fase 0: exigen git). */
export function initRepo(dir: string): string {
  mkdirSync(dir, { recursive: true })
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "pipe" })
  git("init", "-q", "-b", "main")
  git("config", "user.name", "test")
  git("config", "user.email", "test@example.com")
  writeFileSync(join(dir, "README.md"), "fixture\n")
  git("add", ".")
  git("commit", "-q", "-m", "inicial")
  return dir
}
