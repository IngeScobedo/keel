/**
 * ADR-0030 §3: las dependencias de cada worktree. Git real; el comando de setup es de
 * shell, así la prueba no depende de bun ni de la red.
 */
import { afterEach, describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { detectSetup } from "../src/project-profile.ts"
import { WorktreeSetup } from "../src/worktree-setup.ts"
import { initRepo } from "./git-fixture.ts"

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "keel-setup-"))
  dirs.push(dir)
  return dir
}

describe("ADR-0030 §3: setup del worktree", () => {
  test("se detecta por el lockfile, siempre congelado", () => {
    const dir = scratch()
    expect(detectSetup(dir)).toBeNull()
    writeFileSync(join(dir, "package-lock.json"), "{}")
    expect(detectSetup(dir)).toEqual({ command: "npm ci", lockfiles: ["package-lock.json"] })
    writeFileSync(join(dir, "pnpm-lock.yaml"), "")
    expect(detectSetup(dir)?.command).toBe("pnpm install --frozen-lockfile")
    writeFileSync(join(dir, "bun.lock"), "")
    expect(detectSetup(dir)).toEqual({
      command: "bun install --frozen-lockfile",
      lockfiles: ["bun.lock"],
    })
  })

  test("instala una vez por worktree y lockfile, y nunca en el checkout del humano", async () => {
    const dir = scratch()
    const repo = initRepo(join(dir, "repo"))
    const worktrees = join(dir, "worktrees")
    mkdirSync(worktrees)
    const wt = join(worktrees, "KEEL-1", "root")
    execFileSync("git", ["worktree", "add", "-q", "-b", "keel/KEEL-1", wt], { cwd: repo })
    writeFileSync(join(wt, "deps.lock"), "v1")
    const setup = {
      command: "echo x >> ../installs && mkdir -p node_modules",
      lockfiles: ["deps.lock"],
    }
    const s = new WorktreeSetup({ store: () => "artifact:sha256:x", worktreesDir: worktrees })
    const installs = () => readFileSync(join(worktrees, "KEEL-1", "installs"), "utf8").length / 2

    let started = 0
    const first = await s.ensure(wt, setup, () => started++)
    expect(first.state).toBe("done")
    expect(first.state === "done" && first.result.ok).toBe(true)
    expect(existsSync(join(wt, "node_modules"))).toBe(true)
    // Ya instalado: no se instala otra vez.
    const [a, b] = await Promise.all([s.ensure(wt, setup), s.ensure(wt, setup)])
    expect([a.state, b.state]).toEqual(["ready", "ready"])
    expect(installs()).toBe(1)
    expect(started).toBe(1)
    // La marca vive en el git del worktree: el árbol no cambia.
    expect(
      execFileSync("git", ["status", "--short", "--", "deps.lock"], { cwd: wt }).toString(),
    ).toBe("?? deps.lock\n")
    // Cambia el lockfile: se instala otra vez, y quien llega mientras tanto espera la misma.
    writeFileSync(join(wt, "deps.lock"), "v2")
    const [owner, joiner] = await Promise.all([s.ensure(wt, setup), s.ensure(wt, setup)])
    expect(owner.state).toBe("done")
    expect(joiner).toEqual({ state: "joined", ok: true })
    expect(installs()).toBe(2)

    // El checkout del humano no es un worktree de Keel.
    expect(await s.ensure(repo, setup)).toEqual({
      state: "skipped",
      reason: "no es un worktree de Keel",
    })
    expect(await s.ensure(wt, null)).toMatchObject({ state: "skipped" })
  })

  test("un setup que falla no deja marca: se intenta otra vez", async () => {
    const dir = scratch()
    const repo = initRepo(join(dir, "repo"))
    const worktrees = join(dir, "worktrees")
    const wt = join(worktrees, "KEEL-2", "root")
    mkdirSync(worktrees)
    execFileSync("git", ["worktree", "add", "-q", "-b", "keel/KEEL-2", wt], { cwd: repo })
    const s = new WorktreeSetup({ store: () => "artifact:sha256:x", worktreesDir: worktrees })
    const failing = { command: "echo sin red; exit 3", lockfiles: [] }
    const r = await s.ensure(wt, failing)
    expect(r.state === "done" && r.result.ok).toBe(false)
    expect(r.state === "done" && r.result.exit_code).toBe(3)
    expect(r.state === "done" && r.result.tail).toContain("sin red")
    expect((await s.ensure(wt, failing)).state).toBe("done")
  })
})
