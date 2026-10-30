/**
 * Perfil del proyecto (ADR-0021 §5): lo que Keel necesita para conducir el
 * método en un repo que no conoce. Se detecta leyendo archivos del repo, sin
 * agente y sin tokens, y el humano lo confirma o lo corrige en la GUI.
 *
 * Es el `init` de la visión del CLI de Casa Matte, sin generar archivos: Keel
 * no escribe nada en el repo para saber cómo verificarlo.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"
import type { ProjectProfile } from "@keel/core"
import { git } from "@keel/git"
import { detectFlow } from "./git-flow.js"

const SKIP = new Set(["node_modules", ".git", "dist", "build", ".next", "target", ".nx", "vendor"])

/** Prefijos de rama por tipo de tarea; los del método de Casa Matte (Conventional Commits). */
export const DEFAULT_BRANCH_PREFIXES: Record<string, string> = {
  feature: "feat/",
  bug: "fix/",
  chore: "chore/",
  docs: "docs/",
  refactor: "refactor/",
  research: "research/",
}

const KNOWN_STACK = [
  "react",
  "next",
  "vue",
  "svelte",
  "@tauri-apps/api",
  "fastify",
  "express",
  "hono",
  "@nestjs/core",
  "drizzle-orm",
  "prisma",
  "vite",
  "nx",
  "zod",
]

/** Lo que se detecta de un repo; con fallos de lectura, lo que se pudo. */
export async function detectProfile(root: string): Promise<ProjectProfile> {
  const has = (p: string) => existsSync(join(root, p))
  const pkg = readJson(join(root, "package.json")) as {
    scripts?: Record<string, string>
    dependencies?: Record<string, string>
    devDependencies?: Record<string, string>
  } | null
  const pm =
    has("bun.lock") || has("bun.lockb")
      ? "bun"
      : has("pnpm-lock.yaml")
        ? "pnpm"
        : has("yarn.lock")
          ? "yarn"
          : "npm"
  const verify: ProjectProfile["verify"] = []
  const stack: string[] = []
  if (pkg) {
    stack.push(has("tsconfig.json") ? "typescript" : "javascript", pm)
    const deps = { ...pkg.dependencies, ...pkg.devDependencies }
    for (const d of KNOWN_STACK) if (deps[d]) stack.push(d.replace(/^@[^/]+\//, ""))
    const scripts = pkg.scripts ?? {}
    const nx = has("nx.json")
    for (const [name, aliases] of [
      ["lint", ["lint"]],
      ["typecheck", ["typecheck", "type-check", "check-types", "tsc"]],
      ["test", ["test"]],
      ["build", ["build"]],
    ] as const) {
      const script = aliases.find((a) => scripts[a])
      if (script) verify.push({ name, command: `${pm} run ${script}` })
      // Nx: sólo lo afectado frente a la rama base, como el gate de Casa Matte.
      else if (nx) verify.push({ name, command: `${pm} nx affected -t ${name}` })
    }
  }
  if (has("Cargo.toml")) {
    stack.push("rust")
    verify.push(
      { name: "clippy", command: "cargo clippy --all-targets -- -D warnings" },
      { name: "test", command: "cargo test" },
    )
  }
  if (has("go.mod")) {
    stack.push("go")
    verify.push(
      { name: "vet", command: "go vet ./..." },
      { name: "test", command: "go test ./..." },
    )
  }
  if (has("pyproject.toml")) {
    stack.push("python")
    const py = readText(join(root, "pyproject.toml"))
    if (/\[tool\.ruff/.test(py)) verify.push({ name: "lint", command: "ruff check ." })
    if (/pytest/.test(py) || has("tests")) verify.push({ name: "test", command: "pytest -q" })
  }
  if (verify.length === 0 && has("Makefile")) {
    const make = readText(join(root, "Makefile"))
    for (const t of ["lint", "test", "build"])
      if (new RegExp(`^${t}:`, "m").test(make)) verify.push({ name: t, command: `make ${t}` })
  }
  const dirs = findDirs(root, 4)
  const adrDirs = dirs.filter((d) => /(^|\/)adr$/i.test(d))
  const sddDirs = dirs.filter((d) => /(^|\/)sdd$/i.test(d))
  const roadmap = findFile(root, [
    "docs/global/roadmap.md",
    "docs/roadmap.md",
    "ROADMAP.md",
    "roadmap.md",
  ])
  // ADR-0043 §2: el flujo de ramas; sus ramas de integración son protegidas para el agente.
  const { flow, co_authored_by } = await detectFlow(root)
  const flowBranches = flow ? [flow.work_base, ...flow.promotions.map((p) => p.to)] : []
  return {
    stack: [...new Set(stack)],
    verify,
    protected_branches: [...new Set([...(await protectedBranches(root)), ...flowBranches])],
    branch_prefixes: { ...DEFAULT_BRANCH_PREFIXES },
    generated_paths: dirs.filter((d) => /(^|\/)generated$/i.test(d)).map((d) => `${d}/**`),
    canon: { adr_dirs: adrDirs, sdd_dirs: sddDirs, roadmap },
    invariants: [],
    adr_pattern: adrPattern(root, adrDirs),
    harness: {
      claude_dir: has(".claude"),
      agents_md: has("AGENTS.md"),
      claude_md: has("CLAUDE.md"),
    },
    flow,
    conventions: { co_authored_by },
  }
}

/** La rama por defecto del remoto (o main/master) y `develop` si existe. */
async function protectedBranches(root: string): Promise<string[]> {
  const out = new Set<string>()
  try {
    const head = (
      await git(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], { cwd: root })
    ).stdout.trim()
    if (head) out.add(head.replace(/^origin\//, ""))
  } catch {
    // Sin remoto o sin HEAD del remoto: se mira lo local.
  }
  try {
    const local = (await git(["branch", "--format=%(refname:short)"], { cwd: root })).stdout
      .split("\n")
      .map((b) => b.trim())
    for (const b of ["main", "master", "develop"]) if (local.includes(b)) out.add(b)
  } catch {
    // No es un repo git: no hay ramas que proteger.
  }
  return [...out]
}

/** El patrón de los ADR del proyecto a partir de sus nombres de archivo. */
function adrPattern(root: string, adrDirs: string[]): string | null {
  const names = adrDirs.flatMap((d) => safeList(join(root, d)))
  if (names.some((n) => /^ADR-[A-Z]+\d+/i.test(n))) return "ADR-[A-Z]+\\d+"
  if (names.some((n) => /^ADR-\d+/i.test(n))) return "ADR-\\d+"
  if (names.some((n) => /^\d{4}-/.test(n))) return "ADR-\\d{4}"
  return null
}

/** Directorios del repo hasta `depth` niveles, relativos y con `/`. */
function findDirs(root: string, depth: number): string[] {
  const out: string[] = []
  const walk = (dir: string, level: number) => {
    if (level > depth) return
    for (const name of safeList(dir)) {
      if (SKIP.has(name) || name.startsWith(".")) continue
      const full = join(dir, name)
      try {
        if (!statSync(full).isDirectory()) continue
      } catch {
        continue
      }
      out.push(relative(root, full).split("\\").join("/"))
      walk(full, level + 1)
    }
  }
  walk(root, 1)
  return out.sort()
}

function findFile(root: string, candidates: string[]): string | null {
  return candidates.find((c) => existsSync(join(root, c))) ?? null
}

function safeList(dir: string): string[] {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

function readText(path: string): string {
  try {
    return readFileSync(path, "utf8")
  } catch {
    return ""
  }
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"))
  } catch {
    return null
  }
}
