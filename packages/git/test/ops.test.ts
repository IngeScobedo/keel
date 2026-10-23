import { afterEach, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  changedFiles,
  commitPaths,
  contentHash,
  currentBranch,
  headSha,
  numstat,
  pushBranch,
  unifiedDiff,
} from "../src/index.ts"

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
const sh = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, stdio: "pipe" }).toString().trim()

test("cambios, hash de contenido, numstat, commit con autor y push sin forzar", async () => {
  const base = mkdtempSync(join(tmpdir(), "keel-ops-"))
  dirs.push(base)
  const remote = join(base, "remote.git")
  const work = join(base, "work")
  sh(base, "init", "-q", "--bare", "-b", "main", remote)
  sh(base, "init", "-q", "-b", "main", work)
  sh(work, "config", "user.name", "t")
  sh(work, "config", "user.email", "t@t")
  writeFileSync(join(work, "a.txt"), "uno\ndos\n")
  writeFileSync(join(work, "borrar.txt"), "x\n")
  sh(work, "add", ".")
  sh(work, "commit", "-qm", "init")
  sh(work, "remote", "add", "origin", remote)
  sh(work, "push", "-q", "origin", "main")
  sh(work, "checkout", "-qb", "keel/K-1/run")

  writeFileSync(join(work, "a.txt"), "uno\nDOS\ntres\n")
  writeFileSync(join(work, "nuevo.txt"), "1\n2\n")
  unlinkSync(join(work, "borrar.txt"))
  const files = await changedFiles(work)
  expect(files).toEqual([
    { path: "a.txt", status: "M" },
    { path: "borrar.txt", status: "D" },
    { path: "nuevo.txt", status: "A" },
  ])
  expect(await numstat(work, files)).toEqual([
    { path: "a.txt", status: "M", additions: 2, deletions: 1 },
    { path: "borrar.txt", status: "D", additions: 0, deletions: 1 },
    { path: "nuevo.txt", status: "A", additions: 2, deletions: 0 },
  ])
  expect(await unifiedDiff(work, files)).toContain("+tres")
  const paths = files.map((f) => f.path)
  const h1 = await contentHash(work, paths)
  writeFileSync(join(work, "nuevo.txt"), "1\n2\n3\n")
  expect(await contentHash(work, paths)).not.toBe(h1)

  const before = await headSha(work)
  const c = await commitPaths(work, {
    message: "cambios del plan",
    files: paths,
    env: {
      GIT_AUTHOR_NAME: "Claude (Keel K-1)",
      GIT_AUTHOR_EMAIL: "run@agents.keel.local",
      GIT_COMMITTER_NAME: "Claude (Keel K-1)",
      GIT_COMMITTER_EMAIL: "run@agents.keel.local",
    },
  })
  expect(c.sha).not.toBe(before)
  expect(c.files).toEqual(["a.txt", "borrar.txt", "nuevo.txt"])
  expect(sh(work, "log", "-1", "--format=%an <%ae>")).toBe(
    "Claude (Keel K-1) <run@agents.keel.local>",
  )
  expect(await currentBranch(work)).toBe("keel/K-1/run")

  const p = await pushBranch(work, { remote: "origin", branch: "keel/K-1/run" })
  expect(p).toEqual({ old_sha: null, new_sha: c.sha })
  expect(sh(remote, "rev-parse", "refs/heads/keel/K-1/run")).toBe(c.sha)
}, 30_000)
