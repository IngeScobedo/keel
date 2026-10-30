/**
 * El flujo de ramas del proyecto (ADR-0043 §2 y §4): cómo entra el código a cada rama,
 * detectado sin ejecutar nada (los disparadores de `.github/workflows` y la historia de
 * merges), y la promoción entre ramas.
 *
 * Una promoción no hace checkout ni abre worktree: `git merge-tree --write-tree` calcula
 * el árbol del merge, `git commit-tree` crea el commit con los dos padres y se empuja ese
 * sha a la rama destino, sin force. Es lo que hace GitHub del lado del servidor: el
 * checkout del humano no se toca y no corren hooks locales.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import type { GitFlow } from "@keel/core"
import { git } from "./base-sync.js"

type Env = "prod" | "staging" | "dev"

/** Qué workflows corren al empujar a qué rama, y si corren en las PR. */
export function workflowTriggers(root: string): { name: string; push: string[]; pr: boolean }[] {
  const dir = join(root, ".github", "workflows")
  if (!existsSync(dir)) return []
  const out: { name: string; push: string[]; pr: boolean }[] = []
  for (const f of readdirSync(dir).filter((x) => /\.ya?ml$/.test(x))) {
    let doc: Record<string, unknown>
    try {
      doc = Bun.YAML.parse(readFileSync(join(dir, f), "utf8")) as Record<string, unknown>
    } catch {
      continue
    }
    // En YAML 1.1 la llave `on` se lee como `true`.
    const on = (doc.on ?? (doc as Record<string, unknown>).true) as unknown
    const events: Record<string, unknown> =
      typeof on === "string"
        ? { [on]: null }
        : Array.isArray(on)
          ? Object.fromEntries(on.map((e) => [String(e), null]))
          : ((on ?? {}) as Record<string, unknown>)
    const push = events.push as { branches?: unknown } | null | undefined
    out.push({
      name: typeof doc.name === "string" ? doc.name : f.replace(/\.ya?ml$/, ""),
      push: Array.isArray(push?.branches) ? push.branches.map(String) : [],
      pr: "pull_request" in events || "pull_request_target" in events,
    })
  }
  return out
}

function environmentOf(branch: string, workflows: string[]): Env | null {
  const words = `${branch} ${workflows.join(" ")}`.toLowerCase()
  if (/\b(prod|production|main|master)\b/.test(branch.toLowerCase())) return "prod"
  if (/\b(stage|staging|stg)\b/.test(words)) return "staging"
  if (/\b(prod|production)\b/.test(words)) return "prod"
  if (/\b(dev|develop|development)\b/.test(words)) return "dev"
  return null
}

const PROMOTION = [
  /promueve (\S+) a (\S+)/i,
  /promote (\S+) (?:to|into|→|->) (\S+)/i,
  /^Merge (?:remote-tracking )?branch '(?:origin\/)?([^']+)' into ([\w./-]+)/,
]

/**
 * El flujo, desde lo que el repo ya dice: las ramas que reciben PRs, las promociones de
 * la historia (con su mensaje más reciente) y qué workflow despliega cada destino.
 */
export async function detectFlow(root: string): Promise<{
  flow: GitFlow | null
  co_authored_by: boolean
}> {
  const co_authored_by = !forbidsCoAuthor(root)
  const refs = (
    await git(root, ["for-each-ref", "--format=%(refname:short)", "refs/remotes/origin"], {})
  ).out
    .split("\n")
    .map((r) => r.replace(/^origin\//, ""))
    .filter((r) => r && r !== "HEAD" && r !== "origin")
  const candidates = refs.filter((r) =>
    /^(development|develop|dev|staging|stage|main|master|production|prod|release)$/.test(r),
  )
  if (candidates.length === 0) return { flow: null, co_authored_by }
  const triggers = workflowTriggers(root)
  const evidence: string[] = []
  const pairs = new Map<string, { from: string; to: string; n: number; message: string }>()
  const prMerges = new Map<string, number>()
  const squashed = new Map<string, number>()
  for (const b of candidates) {
    const subjects = (
      await git(root, ["log", "--first-parent", "--format=%s", "-300", `origin/${b}`], {})
    ).out
      .split("\n")
      .filter(Boolean)
    prMerges.set(b, subjects.filter((s) => /^Merge pull request #\d+/.test(s)).length)
    squashed.set(b, subjects.filter((s) => /\(#\d+\)$/.test(s) && !/^Merge /.test(s)).length)
    for (const s of subjects)
      for (const re of PROMOTION) {
        const m = re.exec(s)
        if (!m) continue
        const [from, to] = [m[1] as string, (m[2] as string).replace(/^origin\//, "")]
        if (to !== b || !candidates.includes(from)) break
        const key = `${from}→${to}`
        const cur = pairs.get(key)
        // El log viene del más nuevo al más viejo: el primer mensaje es el actual.
        pairs.set(key, { from, to, n: (cur?.n ?? 0) + 1, message: cur?.message ?? s })
        break
      }
  }
  const promotions = [...pairs.values()].filter((p) => p.n >= 2)
  // La base de trabajo: la que más PRs recibe y que no es destino de una promoción.
  const targets = new Set(promotions.map((p) => p.to))
  const workBase =
    [...prMerges.entries()].filter(([b]) => !targets.has(b)).sort((a, b) => b[1] - a[1])[0]?.[0] ??
    promotions.find((p) => !targets.has(p.from))?.from ??
    null
  if (!workBase || ((prMerges.get(workBase) ?? 0) === 0 && promotions.length === 0))
    return { flow: null, co_authored_by }
  evidence.push(`${prMerges.get(workBase) ?? 0} PRs mergeadas en ${workBase}`)
  // En cadena desde la base: development → stage → main.
  const chain: typeof promotions = []
  let at = workBase
  for (let i = 0; i < promotions.length; i++) {
    const next = promotions.find((p) => p.from === at && !chain.includes(p))
    if (!next) break
    chain.push(next)
    at = next.to
  }
  const pushedBy = (b: string) => triggers.filter((t) => t.push.includes(b)).map((t) => t.name)
  const flow: GitFlow = {
    work_base: workBase,
    pr_merge_method:
      (squashed.get(workBase) ?? 0) > (prMerges.get(workBase) ?? 0) ? "squash" : "merge",
    promotions: chain.map((p) => {
      const workflows = pushedBy(p.to)
      const environment = environmentOf(p.to, workflows)
      evidence.push(`${p.n} promociones ${p.from} → ${p.to} («${p.message}»)`)
      for (const w of workflows) evidence.push(`${w}: push a ${p.to}`)
      return {
        from: p.from,
        to: p.to,
        message: p.message,
        environment,
        workflows,
        // A producción sólo con verde lo que desplegó la rama de la que viene.
        requires: environment === "prod" ? pushedBy(p.from) : [],
      }
    }),
    evidence,
  }
  return { flow, co_authored_by }
}

/** El repo prohíbe `Co-Authored-By` de agentes (en su CLAUDE.md, AGENTS.md o reglas). */
function forbidsCoAuthor(root: string): boolean {
  const files = ["CLAUDE.md", "AGENTS.md", ".claude/rules/git-workflow.md", "CONTRIBUTING.md"]
  for (const f of files) {
    const p = join(root, f)
    if (!existsSync(p)) continue
    const text = readFileSync(p, "utf8")
    if (/(nunca|never|no|sin|prohib)[^\n]{0,40}Co-Authored-By/i.test(text)) return true
  }
  return false
}

// --- estado y promoción ------------------------------------------------------------------

export type Commit = { sha: string; subject: string; pr: number | null; title: string }

/**
 * Lo que está en `from` y no en `to`. Si trae PRs (aunque vengan dentro de otra
 * promoción), son ellas; si no, los commits del primer padre.
 */
export async function pendingCommits(root: string, from: string, to: string): Promise<Commit[]> {
  const list = async (firstParent: boolean) =>
    (
      await git(
        root,
        [
          "log",
          ...(firstParent ? ["--first-parent"] : []),
          "--format=%H%x1f%s%x1f%b%x1e",
          `origin/${to}..origin/${from}`,
        ],
        {},
      )
    ).out
      .split("\x1e")
      .map((x) => x.trim())
      .filter(Boolean)
      .map((x) => {
        const [sha = "", subject = "", body = ""] = x.split("\x1f")
        const merged = /^Merge pull request #(\d+)/.exec(subject)
        const squashed = /\(#(\d+)\)$/.exec(subject)
        const pr = merged ? Number(merged[1]) : squashed ? Number(squashed[1]) : null
        return {
          sha,
          subject,
          pr,
          title: merged
            ? body.split("\n")[0]?.trim() || subject
            : subject.replace(/\s*\(#\d+\)$/, ""),
        }
      })
  const prs = (await list(false)).filter((c) => c.pr !== null)
  return prs.length ? prs : list(true)
}

export async function headOf(root: string, branch: string): Promise<string | null> {
  const r = await git(root, ["rev-parse", "--verify", "--quiet", `origin/${branch}^{commit}`], {})
  return r.code === 0 ? r.out : null
}

export async function fetchOrigin(
  root: string,
  env: Record<string, string>,
): Promise<string | null> {
  const r = await git(root, ["fetch", "--quiet", "--prune", "origin"], env, 90_000)
  return r.code === 0 ? null : r.err.split("\n").slice(-2).join(" · ") || "git fetch falló"
}

export class PromotionError extends Error {
  readonly conflicts: string[]
  constructor(message: string, conflicts: string[] = []) {
    super(message)
    this.name = "PromotionError"
    this.conflicts = conflicts
  }
}

/**
 * Promueve `from` a `to` atado a las cabezas que vio el humano. Revalida, calcula el
 * merge sin checkout, crea el commit y lo empuja (nunca force). Devuelve el sha nuevo.
 */
export async function promote(
  root: string,
  env: Record<string, string>,
  p: { from: string; to: string; fromSha: string; toSha: string; message: string },
): Promise<{ sha: string }> {
  const fetchError = await fetchOrigin(root, env)
  if (fetchError) throw new PromotionError(`no pude traer el remoto: ${fetchError}`)
  const [fromNow, toNow] = [await headOf(root, p.from), await headOf(root, p.to)]
  if (fromNow !== p.fromSha || toNow !== p.toSha)
    throw new PromotionError(
      `el plan caducó: ${fromNow !== p.fromSha ? p.from : p.to} se movió desde que lo viste`,
    )
  const tree = await git(
    root,
    ["merge-tree", "--write-tree", "--name-only", p.toSha, p.fromSha],
    {},
  )
  if (tree.code !== 0) {
    const files = tree.out
      .split("\n")
      .slice(1)
      .map((l) => l.trim())
      .filter((l) => l && !/^(Auto-merging|CONFLICT)/.test(l))
    throw new PromotionError(
      `el merge de ${p.from} en ${p.to} tiene conflictos: hay que resolverlos en una tarea`,
      [...new Set(files)],
    )
  }
  const treeSha = tree.out.split("\n")[0]?.trim() ?? ""
  const commit = await git(
    root,
    ["commit-tree", treeSha, "-p", p.toSha, "-p", p.fromSha, "-m", p.message],
    {},
  )
  if (commit.code !== 0) throw new PromotionError(`git commit-tree falló: ${commit.err}`)
  const sha = commit.out.trim()
  // Sin force: si `to` se movió en el remoto entre tanto, el push se rechaza solo.
  const push = await git(root, ["push", "origin", `${sha}:refs/heads/${p.to}`], env, 120_000)
  if (push.code !== 0)
    throw new PromotionError(
      `el push a ${p.to} falló: ${push.err.split("\n").slice(-2).join(" · ")}`,
    )
  await git(root, ["fetch", "--quiet", "origin", p.to], env)
  return { sha }
}
