import { afterEach, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs"
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

test("leer el estado no reescribe el índice: un commit concurrente no choca con su lock", async () => {
  const base = mkdtempSync(join(tmpdir(), "keel-status-"))
  dirs.push(base)
  sh(base, "init", "-q", "-b", "main", base)
  writeFileSync(join(base, "a.txt"), "uno\n")
  sh(base, "add", "a.txt")
  sh(base, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "a")
  const index = join(base, ".git", "index")
  const before = statSync(index).mtimeMs
  // Mismo contenido, mtime nuevo: un `git status` con locks opcionales refrescaría el
  // índice y lo escribiría tomando `index.lock`.
  await Bun.sleep(1100)
  const t = new Date()
  utimesSync(join(base, "a.txt"), t, t)
  await repoStatus(base)
  expect(statSync(index).mtimeMs).toBe(before)
})
