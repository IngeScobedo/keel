import { afterEach, describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  canonical,
  captureChanges,
  createWorktree,
  GitError,
  type GitRepo,
  openRepo,
  preserveChanges,
  RESCUE_REF_PREFIX,
  RUN_REF_PREFIX,
  reconcile,
  removeWorktree,
} from "../src/index.ts"

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function sh(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, LC_ALL: "C" } })
}

/** Repo real con un commit; los worktrees van a un directorio hermano. */
async function fixture(retry?: GitRepo["retry"]) {
  const base = mkdtempSync(join(tmpdir(), "keel-git-"))
  dirs.push(base)
  const root = join(base, "repo")
  mkdirSync(root)
  sh(root, "init", "-q", "-b", "main")
  sh(root, "config", "user.name", "test")
  sh(root, "config", "user.email", "test@example.com")
  writeFileSync(join(root, "README.md"), "hola\n")
  sh(root, "add", ".")
  sh(root, "commit", "-q", "-m", "inicial")
  const repo = await openRepo(root, retry ? { retry } : {})
  return { repo, root, wt: (id: string) => join(base, "wt", id) }
}

const refs = (root: string, prefix: string) =>
  sh(root, "for-each-ref", "--format=%(refname)", prefix).trim().split("\n").filter(Boolean)

async function kindOf(p: Promise<unknown>): Promise<string | null> {
  try {
    await p
    return null
  } catch (e) {
    return e instanceof GitError ? e.kind : `no-GitError: ${String(e)}`
  }
}

describe("@keel/git: worktrees por run con el estado en el propio repo (ADR-0007 §5)", () => {
  test("crear deja ref con la base, rama keel/<run>, metadatos y estado active", async () => {
    const { repo, root, wt } = await fixture()
    const head = sh(root, "rev-parse", "HEAD").trim()
    const w = await createWorktree(repo, { runId: "run-1", path: wt("run-1"), owner: "test" })
    expect(w).toMatchObject({ state: "active", branch: "keel/run-1", baseSha: head, dirty: false })
    expect(sh(root, "rev-parse", `${RUN_REF_PREFIX}run-1`).trim()).toBe(head)
    expect(existsSync(join(wt("run-1"), "README.md"))).toBe(true)
    const [listed] = await reconcile(repo)
    expect(listed).toMatchObject({ runId: "run-1", state: "active", path: canonical(wt("run-1")) })
    expect(w.path).toBe(listed?.path ?? null)
    expect(listed?.meta).toMatchObject({
      version: 1,
      run_id: "run-1",
      base_sha: head,
      owner: "test",
    })
  })

  test("conflictos y argumentos inválidos fallan tipados sin tocar lo existente", async () => {
    const { repo, root, wt } = await fixture()
    await createWorktree(repo, { runId: "dup", path: wt("dup") })
    expect(await kindOf(createWorktree(repo, { runId: "dup", path: wt("dup-2") }))).toBe("conflict")
    expect(await kindOf(createWorktree(repo, { runId: "../x", path: wt("x") }))).toBe(
      "invalid_argument",
    )
    expect(await kindOf(createWorktree(repo, { runId: "rel", path: "relativo/x" }))).toBe(
      "invalid_argument",
    )
    expect(refs(root, RUN_REF_PREFIX)).toEqual([`${RUN_REF_PREFIX}dup`])
    expect(existsSync(wt("dup-2"))).toBe(false)
  })

  test("si worktree add falla, no quedan ni el ref ni la rama", async () => {
    const { repo, root, wt } = await fixture()
    mkdirSync(wt("ocupado"), { recursive: true })
    writeFileSync(join(wt("ocupado"), "algo"), "x")
    expect(await kindOf(createWorktree(repo, { runId: "r", path: wt("ocupado") }))).toBe("conflict")
    expect(refs(root, RUN_REF_PREFIX)).toEqual([])
    expect(sh(root, "branch", "--list", "keel/*").trim()).toBe("")
  })

  test("captureChanges ve commits sobre la base y archivos sin commit", async () => {
    const { repo, wt } = await fixture()
    const w = await createWorktree(repo, { runId: "c", path: wt("c") })
    writeFileSync(join(wt("c"), "nuevo.ts"), "export {}\n")
    sh(wt("c"), "add", "nuevo.ts")
    sh(wt("c"), "commit", "-q", "-m", "nuevo")
    writeFileSync(join(wt("c"), "README.md"), "cambiado\n")
    writeFileSync(join(wt("c"), "suelto.txt"), "sin rastrear\n")
    const ch = await captureChanges(wt("c"), w.baseSha as string)
    expect(ch.commitsAhead).toBe(1)
    expect(ch.dirty).toBe(true)
    expect(ch.files).toEqual([
      { path: "README.md", status: " M" },
      { path: "suelto.txt", status: "??" },
    ])
  })

  test("quitar un worktree con cambios los rescata antes, conserva la rama y es idempotente", async () => {
    const { repo, root, wt } = await fixture()
    await createWorktree(repo, { runId: "sucio", path: wt("sucio") })
    writeFileSync(join(wt("sucio"), "trabajo.txt"), "no perder\n")
    const r = await removeWorktree(repo, "sucio")
    expect(r.removed).toBe(true)
    expect(r.branchKept).toBe(true)
    expect(r.rescueRef?.startsWith(`${RESCUE_REF_PREFIX}sucio/`)).toBe(true)
    expect(sh(root, "show", `${r.rescueRef}:trabajo.txt`)).toBe("no perder\n")
    expect(existsSync(wt("sucio"))).toBe(false)
    expect(refs(root, RUN_REF_PREFIX)).toEqual([])
    expect(sh(root, "branch", "--list", "keel/sucio").trim()).toBe("keel/sucio")
    expect(await reconcile(repo)).toEqual([])
    expect(await removeWorktree(repo, "sucio")).toEqual({
      removed: false,
      rescueRef: null,
      branchKept: false,
    })
  })

  test("rescatar no toca el índice ni la rama del worktree", async () => {
    const { repo, wt } = await fixture()
    await createWorktree(repo, { runId: "idx", path: wt("idx") })
    writeFileSync(join(wt("idx"), "a.txt"), "a\n")
    const before = sh(wt("idx"), "status", "--porcelain")
    const head = sh(wt("idx"), "rev-parse", "HEAD")
    expect(await preserveChanges(repo, { runId: "idx", path: wt("idx") })).not.toBeNull()
    expect(sh(wt("idx"), "status", "--porcelain")).toBe(before)
    expect(sh(wt("idx"), "rev-parse", "HEAD")).toBe(head)
  })

  test("quitar un worktree limpio y sin commits borra también la rama", async () => {
    const { repo, root, wt } = await fixture()
    await createWorktree(repo, { runId: "limpio", path: wt("limpio") })
    expect(await removeWorktree(repo, "limpio")).toEqual({
      removed: true,
      rescueRef: null,
      branchKept: false,
    })
    expect(sh(root, "branch", "--list", "keel/*").trim()).toBe("")
  })
})

describe("@keel/git: ids jerárquicos (SDD 02: keel/<work-item>/<run>/<lane>)", () => {
  test("crea, reconcilia, rescata y quita con un id de varios segmentos", async () => {
    const { repo, root, wt } = await fixture()
    const id = "KEEL-7/run-1/root"
    const w = await createWorktree(repo, { runId: id, path: wt("k7-root") })
    expect(w.branch).toBe("keel/KEEL-7/run-1/root")
    await createWorktree(repo, { runId: "KEEL-7/run-1/lane-a", path: wt("k7-a") })
    expect((await reconcile(repo)).map((x) => x.runId)).toEqual([
      "KEEL-7/run-1/lane-a",
      "KEEL-7/run-1/root",
    ])
    writeFileSync(join(wt("k7-root"), "f.txt"), "x\n")
    const r = await removeWorktree(repo, id)
    expect(r.rescueRef?.startsWith(`${RESCUE_REF_PREFIX}${id}/`)).toBe(true)
    expect(refs(root, RUN_REF_PREFIX)).toEqual([`${RUN_REF_PREFIX}KEEL-7/run-1/lane-a`])
  })

  test("un id prefijo de otro por segmentos es conflict; segmentos inválidos, invalid_argument", async () => {
    const { repo, wt } = await fixture()
    await createWorktree(repo, { runId: "a/b", path: wt("ab") })
    expect(await kindOf(createWorktree(repo, { runId: "a", path: wt("a") }))).toBe("conflict")
    for (const bad of ["a//b", "/a", "a/", "a/.x", "a/b.lock", "a/..", "a b"])
      expect(await kindOf(createWorktree(repo, { runId: bad, path: wt("bad") }))).toBe(
        "invalid_argument",
      )
    expect((await reconcile(repo)).map((x) => x.runId)).toEqual(["a/b"])
  })
})

describe("@keel/git: reconciliar tras un crash sólo con git", () => {
  test("directorio borrado → missing; ref sin worktree → orphan_ref; rama keel/* sin ref → unregistered", async () => {
    const { repo, root, wt } = await fixture()
    await createWorktree(repo, { runId: "borrado", path: wt("borrado") })
    rmSync(wt("borrado"), { recursive: true, force: true })
    // crash entre escribir el ref y crear el worktree
    sh(root, "update-ref", `${RUN_REF_PREFIX}huerfano`, "HEAD")
    sh(root, "worktree", "add", "-q", "-b", "keel/a-mano", wt("a-mano"))

    const states = Object.fromEntries((await reconcile(repo)).map((w) => [w.runId, w.state]))
    expect(states).toEqual({ "a-mano": "unregistered", borrado: "missing", huerfano: "orphan_ref" })

    for (const id of ["borrado", "huerfano"])
      expect((await removeWorktree(repo, id)).removed).toBe(true)
    expect(refs(root, RUN_REF_PREFIX)).toEqual([])
    const left = await reconcile(repo)
    expect(left.map((w) => [w.runId, w.state])).toEqual([["a-mano", "unregistered"]])
  })
})

describe("@keel/git: concurrencia sobre el .git compartido", () => {
  test("un lock ajeno se respeta: reintenta, falla tipado y no borra el archivo", async () => {
    const { repo, root, wt } = await fixture({ attempts: 3, baseDelayMs: 5, maxDelayMs: 10 })
    const lock = join(root, ".git", "refs", "keel", "runs", "bloq.lock")
    mkdirSync(join(root, ".git", "refs", "keel", "runs"), { recursive: true })
    writeFileSync(lock, "")
    expect(await kindOf(createWorktree(repo, { runId: "bloq", path: wt("bloq") }))).toBe("locked")
    expect(existsSync(lock)).toBe(true)
    expect(existsSync(wt("bloq"))).toBe(false)
  })

  test("si el lock se libera durante los reintentos, la operación termina", async () => {
    const { repo, root, wt } = await fixture({ attempts: 8, baseDelayMs: 10, maxDelayMs: 40 })
    const lock = join(root, ".git", "refs", "keel", "runs", "espera.lock")
    mkdirSync(join(root, ".git", "refs", "keel", "runs"), { recursive: true })
    writeFileSync(lock, "")
    setTimeout(() => rmSync(lock), 30)
    const w = await createWorktree(repo, { runId: "espera", path: wt("espera") })
    expect(w.state).toBe("active")
  })

  // En Windows cada worktree cuesta ~10 veces más que en Linux (procesos git): timeout amplio.
  test("ocho worktrees creados en paralelo sobre el mismo repo terminan todos", async () => {
    const { repo, root, wt } = await fixture()
    const ids = Array.from({ length: 8 }, (_, i) => `par-${i}`)
    await Promise.all(ids.map((id) => createWorktree(repo, { runId: id, path: wt(id) })))
    expect(refs(root, RUN_REF_PREFIX)).toHaveLength(8)
    expect((await reconcile(repo)).every((w) => w.state === "active")).toBe(true)
    await Promise.all(ids.map((id) => removeWorktree(repo, id)))
    expect(await reconcile(repo)).toEqual([])
  }, 60_000)
})
