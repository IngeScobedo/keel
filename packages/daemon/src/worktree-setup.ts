/**
 * ADR-0030 §3: cada worktree de Keel nace sin dependencias (`node_modules` no está en git),
 * y sin ellas `verify` falla igual antes y después del cambio: el agente cierra sin
 * verificar nada (KEEL-19 a 23). Keel corre el `setup` del perfil al preparar el worktree
 * y otra vez si cambia un lockfile.
 *
 * La marca de lo instalado va en el directorio git del worktree (`git rev-parse
 * --git-dir`), no en el árbol de trabajo: no ensucia el diff y sobrevive a reinicios.
 */
import { createHash } from "node:crypto"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { isAbsolute, join, relative } from "node:path"
import type { ProjectProfile, VerifyResult } from "@keel/core"
import { git } from "./base-sync.js"
import { runOne } from "./verify.js"

type Setup = NonNullable<ProjectProfile["setup"]>
export type SetupOutcome =
  | { state: "skipped"; reason: string }
  | { state: "ready" }
  | { state: "done"; result: VerifyResult }
  /** Esperó la instalación que otro ya había empezado; ése la cuenta. */
  | { state: "joined"; ok: boolean }

export type WorktreeSetupDeps = {
  /** Guarda la salida completa y devuelve su referencia. */
  store: (text: string) => string
  /** Raíz de los worktrees de Keel: el checkout del humano no se toca. */
  worktreesDir: string
}

const MARK = "keel-setup"

export class WorktreeSetup {
  private readonly running = new Map<string, Promise<SetupOutcome>>()
  private readonly deps: WorktreeSetupDeps

  constructor(deps: WorktreeSetupDeps) {
    this.deps = deps
  }

  /** Instala si hace falta; una segunda llamada para el mismo worktree espera la primera. */
  ensure(cwd: string, setup: Setup | null, onStart?: () => void): Promise<SetupOutcome> {
    if (!setup) return Promise.resolve({ state: "skipped", reason: "el perfil no tiene setup" })
    const rel = relative(this.deps.worktreesDir, cwd)
    if (rel.startsWith("..") || isAbsolute(rel))
      return Promise.resolve({ state: "skipped", reason: "no es un worktree de Keel" })
    const current = this.running.get(cwd)
    if (current)
      return current.then((o) => (o.state === "done" ? { state: "joined", ok: o.result.ok } : o))
    const job = this.run(cwd, setup, onStart).finally(() => this.running.delete(cwd))
    this.running.set(cwd, job)
    return job
  }

  private async run(cwd: string, setup: Setup, onStart?: () => void): Promise<SetupOutcome> {
    const gitDir = await git(cwd, ["rev-parse", "--absolute-git-dir"], {})
    if (gitDir.code !== 0) return { state: "skipped", reason: "el worktree no es un repo git" }
    const mark = join(gitDir.out.trim(), MARK)
    const wanted = fingerprint(cwd, setup)
    if (existsSync(mark) && readFileSync(mark, "utf8") === wanted) return { state: "ready" }
    onStart?.()
    const result = await runOne(
      cwd,
      {
        name: "setup",
        command: setup.command,
        ...(setup.timeout_ms ? { timeout_ms: setup.timeout_ms } : {}),
      },
      { store: this.deps.store },
    )
    if (result.ok) writeFileSync(mark, wanted)
    return { state: "done", result }
  }
}

/** El comando y el contenido de sus lockfiles: si cambia algo, se instala otra vez. */
function fingerprint(cwd: string, setup: Setup): string {
  const h = createHash("sha256").update(setup.command)
  for (const f of setup.lockfiles) {
    const p = join(cwd, f)
    h.update(`\0${f}\0`)
    if (existsSync(p)) h.update(readFileSync(p))
  }
  return h.digest("hex")
}
