/** ADR-0022 §2: la rama de la feature y la integración de las subtareas, con git real. */
import { afterEach, describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createFeatureBranch, featureBranchName, integrateInto, slug } from "../src/features.ts"
import { initRepo } from "./git-fixture.ts"

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function repo() {
  const dir = mkdtempSync(join(tmpdir(), "keel-features-"))
  dirs.push(dir)
  const root = initRepo(join(dir, "repo"))
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: "pipe" }).trim()
  /** Una rama desde `base` con un commit que escribe `file`. */
  const branchWith = (name: string, base: string, file: string, content: string) => {
    git("switch", "-q", "-c", name, base)
    writeFileSync(join(root, file), content)
    git("add", file)
    git("commit", "-q", "-m", `${name}: ${file}`)
    git("switch", "-q", "main")
  }
  return { root, git, branchWith }
}

describe("ADR-0022: la rama de la feature", () => {
  test("el nombre sale del id y del título, sin acentos", () => {
    expect(slug("Capítulos en el detalle: ¡ya!")).toBe("capitulos-en-el-detalle-ya")
    expect(featureBranchName("feat/", "KEEL-12", "Capítulos")).toBe("feat/KEEL-12-capitulos")
  })

  test("se crea desde la base y un reintento la reutiliza", async () => {
    const { root, git } = repo()
    const a = await createFeatureBranch(root, "feat/KEEL-1-x", "main")
    expect(a.created).toBe(true)
    expect(a.sha).toBe(git("rev-parse", "main"))
    const b = await createFeatureBranch(root, "feat/KEEL-1-x", "main")
    expect(b).toEqual({ sha: a.sha, created: false })
  })

  test("integra por fast-forward, con merge sin checkout y detecta lo ya integrado", async () => {
    const { root, git, branchWith } = repo()
    await createFeatureBranch(root, "feat/f", "main")
    branchWith("t1", "feat/f", "a.txt", "a\n")
    const ff = await integrateInto(root, "feat/f", "refs/heads/t1", { message: "t1" })
    expect(ff).toMatchObject({ ok: true, mode: "fast_forward" })
    expect(git("rev-parse", "feat/f")).toBe(git("rev-parse", "t1"))
    // t2 salió de la feature antes de t3: hace falta un merge, sin tocar el árbol de main.
    branchWith("t2", "feat/f", "b.txt", "b\n")
    branchWith("t3", "feat/f", "c.txt", "c\n")
    await integrateInto(root, "feat/f", "refs/heads/t2", { message: "t2" })
    const merged = await integrateInto(root, "feat/f", "refs/heads/t3", { message: "Integra t3" })
    expect(merged).toMatchObject({ ok: true, mode: "merge" })
    expect(git("ls-tree", "--name-only", "feat/f").split("\n")).toEqual(
      expect.arrayContaining(["a.txt", "b.txt", "c.txt"]),
    )
    expect(git("log", "-1", "--format=%s", "feat/f")).toBe("Integra t3")
    expect(git("branch", "--show-current")).toBe("main")
    const again = await integrateInto(root, "feat/f", "refs/heads/t3", { message: "x" })
    expect(again).toMatchObject({ ok: true, mode: "already" })
  })

  test("un conflicto no mueve la feature y nombra los archivos", async () => {
    const { root, git, branchWith } = repo()
    await createFeatureBranch(root, "feat/f", "main")
    branchWith("t1", "feat/f", "same.txt", "uno\n")
    branchWith("t2", "feat/f", "same.txt", "dos\n")
    await integrateInto(root, "feat/f", "refs/heads/t1", { message: "t1" })
    const before = git("rev-parse", "feat/f")
    const r = await integrateInto(root, "feat/f", "refs/heads/t2", { message: "t2" })
    expect(r).toMatchObject({ ok: false, conflicts: ["same.txt"] })
    expect(git("rev-parse", "feat/f")).toBe(before)
  })
})
