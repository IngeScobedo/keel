import { afterEach, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { repoStatus } from "../src/index.ts"

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
const sh = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, stdio: "pipe" }).toString().trim()

test("rama, HEAD, upstream con adelanto y atraso, y archivos cambiados", async () => {
  const base = mkdtempSync(join(tmpdir(), "keel-status-"))
  dirs.push(base)
  const origin = join(base, "origin")
  const work = join(base, "work")
  sh(base, "init", "-q", "-b", "main", origin)
  sh(
    origin,
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@t",
    "commit",
    "-q",
    "--allow-empty",
    "-m",
    "a",
  )
  expect(await repoStatus(origin)).toMatchObject({ branch: "main", upstream: null, changed: 0 })

  sh(base, "clone", "-q", origin, work)
  sh(work, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "b")
  sh(
    origin,
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@t",
    "commit",
    "-q",
    "--allow-empty",
    "-m",
    "c",
  )
  sh(work, "fetch", "-q")
  writeFileSync(join(work, "nuevo.txt"), "x")
  const s = await repoStatus(work)
  expect(s).toMatchObject({
    branch: "main",
    upstream: "origin/main",
    ahead: 1,
    behind: 1,
    changed: 1,
    untracked: 1,
  })
  expect(s.head).toBe(sh(work, "rev-parse", "HEAD"))

  const empty = join(base, "empty")
  sh(base, "init", "-q", "-b", "main", empty)
  expect(await repoStatus(empty)).toMatchObject({ branch: "main", head: null })
  // Tres repos, un clone y un fetch: en Windows pasa de los 5 s por defecto.
}, 30_000)
