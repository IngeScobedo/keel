// Spike ADR-0043: sólo lectura. Lo que el `gh` del humano da para un repo: ajustes de
// merge, protección de ramas, latencia de PRs y runs, detalle por paso de un run, cómo
// se disparan los workflows y cómo se promueve entre ramas según la historia.
// Uso: bun spikes/github-flow/src/probe.ts /ruta/al/repo
import { spawnSync } from "node:child_process"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

const repo = process.argv[2] ?? process.cwd()
const run = (cmd: string, args: string[]) => {
  const t = performance.now()
  const r = spawnSync(cmd, args, { cwd: repo, encoding: "utf8", timeout: 60_000 })
  return { ms: performance.now() - t, out: r.stdout ?? "", err: r.stderr ?? "", code: r.status }
}
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0
const timed = (args: string[], n = 3) => {
  const xs: number[] = []
  let out = ""
  for (let i = 0; i < n; i++) {
    const r = run("gh", args)
    xs.push(r.ms)
    out = r.out
  }
  return { ms: Math.round(median(xs)), out }
}

console.log(`# Repo: ${repo}\n`)
console.log(`gh: ${run("gh", ["--version"]).out.split("\n")[0]}`)
const auth = run("gh", ["auth", "status"])
console.log(`sesión de gh: ${auth.code === 0 ? "sí" : "no"} (el token no se imprime)`)

const settings = JSON.parse(
  run("gh", [
    "repo",
    "view",
    "--json",
    "nameWithOwner,defaultBranchRef,squashMergeAllowed,mergeCommitAllowed,rebaseMergeAllowed,deleteBranchOnMerge",
  ]).out,
)
console.log(`\n## Ajustes\n\n${JSON.stringify(settings)}`)

console.log("\n## Protección de ramas (API)\n")
for (const b of ["development", "stage", "main"]) {
  const r = run("gh", ["api", `repos/{owner}/{repo}/branches/${b}/protection`, "--silent"])
  const status = /HTTP (\d+)/.exec(r.err)?.[1] ?? (r.code === 0 ? "200" : "?")
  console.log(`${b}: HTTP ${status}`)
}

console.log("\n## Latencia (mediana de 3)\n")
const prs = timed([
  "pr",
  "list",
  "--state",
  "all",
  "--limit",
  "20",
  "--json",
  "number,state,baseRefName,headRefName,mergedAt,mergeStateStatus,reviewDecision,statusCheckRollup",
])
console.log(`gh pr list (20, con checks): ${prs.ms} ms`)
const runs = timed([
  "run",
  "list",
  "--limit",
  "30",
  "--json",
  "databaseId,workflowName,headBranch,headSha,event,status,conclusion,createdAt,updatedAt",
])
console.log(`gh run list (30): ${runs.ms} ms`)
const list = JSON.parse(runs.out) as {
  databaseId: number
  workflowName: string
  headBranch: string
  event: string
  conclusion: string
  createdAt: string
  updatedAt: string
}[]
const deploy = list.find((r) => /deploy/i.test(r.workflowName) && r.conclusion)
if (deploy) {
  const view = timed(["run", "view", String(deploy.databaseId), "--json", "jobs"])
  console.log(`gh run view (jobs y pasos): ${view.ms} ms`)
  const jobs = JSON.parse(view.out).jobs as {
    name: string
    steps: { name: string; startedAt: string; completedAt: string }[]
  }[]
  console.log(`\n## Pasos de «${deploy.workflowName}» (${deploy.headBranch})\n`)
  for (const j of jobs)
    for (const s of j.steps) {
      const secs = (Date.parse(s.completedAt) - Date.parse(s.startedAt)) / 1000
      if (secs >= 1) console.log(`- ${j.name} › ${s.name}: ${secs} s`)
    }
}

console.log("\n## Runs por workflow y evento (últimos 30)\n")
const byKind = new Map<string, number[]>()
for (const r of list) {
  const k = `${r.workflowName} · ${r.event} · ${r.headBranch.includes("/") ? "<rama corta>" : r.headBranch}`
  const secs = (Date.parse(r.updatedAt) - Date.parse(r.createdAt)) / 1000
  byKind.set(k, [...(byKind.get(k) ?? []), secs])
}
for (const [k, xs] of byKind)
  console.log(`- ${k}: ${xs.length} runs, mediana ${Math.round(median(xs))} s`)

console.log("\n## Disparadores de los workflows\n")
const wf = join(repo, ".github", "workflows")
for (const f of readdirSync(wf).filter((x) => /\.ya?ml$/.test(x))) {
  const doc = Bun.YAML.parse(readFileSync(join(wf, f), "utf8")) as {
    name?: string
    on?: Record<string, { branches?: string[] } | null>
  }
  const on = Object.entries(doc.on ?? {}).map(
    ([ev, v]) => `${ev}${v?.branches ? ` [${v.branches.join(", ")}]` : ""}`,
  )
  console.log(`- ${doc.name ?? f}: ${on.join(" · ")}`)
}

// Con las refs remotas que ya hay: el spike no hace fetch ni toca el checkout.
console.log("\n## Cómo entra el código a cada rama (merges de la historia)\n")
for (const b of ["development", "stage", "main"]) {
  const subjects = run("git", ["log", "--merges", "--format=%s", "-200", `origin/${b}`])
    .out.split("\n")
    .filter(Boolean)
  const pr = subjects.filter((s) => /^Merge pull request #\d+/.test(s)).length
  const promos = new Map<string, number>()
  for (const s of subjects) {
    const m = /promueve (\S+) a (\S+)/.exec(s)
    if (m) promos.set(`${m[1]}→${m[2]}`, (promos.get(`${m[1]}→${m[2]}`) ?? 0) + 1)
  }
  console.log(
    `- ${b}: ${subjects.length} merges · ${pr} de PR · promociones ${[...promos].map(([k, n]) => `${k} ×${n}`).join(", ") || "ninguna"}`,
  )
}
