/**
 * Latencias de la Fase 0 (SDD 04: «registrar latencia y entorno de Windows y
 * POSIX sin presuponer resultados submilisegundo»).
 *
 *   bun scripts/bench-phase0.ts            # imprime entorno y percentiles
 *   bun scripts/bench-phase0.ts --write    # además guarda docs/benchmarks/<fecha>-<plataforma>.json
 *
 * El daemon corre como proceso aparte (`packages/daemon/src/main.ts`) y el
 * cliente mide desde este proceso por el socket real. No lanza agentes: no
 * consume la cuenta del proveedor. Todo va a un directorio temporal que se
 * borra al final.
 */
import { execFileSync, spawn } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { cpus, platform, release, tmpdir, totalmem } from "node:os"
import { join } from "node:path"
import type { EventNotification } from "../packages/core/src/index.ts"
import { backupStore, IpcClient, openStore, Repo } from "../packages/daemon/src/index.ts"
import { createWorktree, openRepo, removeWorktree } from "../packages/git/src/index.ts"

const ITER = { health: 500, create: 300, worktree: 30 }
const SEEDED_EVENTS = 20_000
const REPO_FILES = 500

type Stat = { n: number; p50: number; p95: number; p99: number; max: number }

function stats(samples: number[]): Stat {
  const s = [...samples].sort((a, b) => a - b)
  const at = (q: number) => s[Math.min(s.length - 1, Math.floor(q * s.length))] ?? Number.NaN
  const round = (x: number) => Math.round(x * 1000) / 1000
  return {
    n: s.length,
    p50: round(at(0.5)),
    p95: round(at(0.95)),
    p99: round(at(0.99)),
    max: round(s.at(-1) ?? Number.NaN),
  }
}

function zeros(n: number): number[] {
  return Array.from({ length: n }, () => 0)
}

function sh(cmd: string, args: string[], cwd?: string): string {
  try {
    return execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: "pipe" }).trim()
  } catch {
    return "unknown"
  }
}

function environment(dir: string) {
  const procVersion = existsSync("/proc/version") ? readFileSync("/proc/version", "utf8") : ""
  return {
    measured_at: new Date().toISOString(),
    platform: platform(),
    release: release(),
    wsl: /microsoft/i.test(procVersion),
    cpu: cpus()[0]?.model ?? "unknown",
    cpus: cpus().length,
    memory_gib: Math.round((totalmem() / 2 ** 30) * 10) / 10,
    bun: Bun.version,
    sqlite: (() => {
      const s = openStore(join(dir, "probe.sqlite"), { loadVector: false })
      const v = s.db.query<{ v: string }, []>("SELECT sqlite_version() v").get()?.v ?? "unknown"
      s.db.close()
      return v
    })(),
    git: sh("git", ["--version"]),
    // `stat -f` no distingue ext2/3/4 (mismo número mágico); findmnt da el tipo montado.
    tmp_filesystem: sh("findmnt", ["-no", "FSTYPE", "-T", dir]),
    commit: sh("git", ["rev-parse", "--short", "HEAD"]),
  }
}

function seedRepo(root: string): void {
  mkdirSync(join(root, "src"), { recursive: true })
  for (let i = 0; i < REPO_FILES; i++)
    writeFileSync(join(root, "src", `f${i}.ts`), `export const v${i} = ${i}\n`)
  sh("git", ["init", "-q", "-b", "main"], root)
  sh("git", ["-c", "user.name=bench", "-c", "user.email=b@b", "add", "."], root)
  sh("git", ["-c", "user.name=bench", "-c", "user.email=b@b", "commit", "-q", "-m", "seed"], root)
}

function seedEvents(dbPath: string, rootPath: string): void {
  const store = openStore(dbPath)
  const repo = new Repo(store.db)
  const { project_id } = repo.ensureDefaultProject(rootPath)
  store.db.transaction(() => {
    for (let i = 0; i < SEEDED_EVENTS; i++)
      repo.appendEvent({
        project_id,
        run_id: null,
        source: "bench",
        source_event_key: `seed:${i}`,
        fidelity: "full",
        adapter_version: "bench/0",
        kind: "bench.seed",
        occurred_at: null,
        payload_json: JSON.stringify({ i, text: "x".repeat(200) }),
      })
  })()
  store.db.close()
}

async function waitFor(path: string, ms = 10_000): Promise<void> {
  const until = Date.now() + ms
  while (!existsSync(path)) {
    if (Date.now() > until) throw new Error(`no apareció ${path}`)
    await new Promise((r) => setTimeout(r, 20))
  }
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "keel-bench-"))
  const root = join(dir, "repo")
  const dbPath = join(dir, "keel.sqlite")
  const socket = join(dir, "keel.sock")
  mkdirSync(root)
  seedRepo(root)
  seedEvents(dbPath, root)
  const env = environment(dir)

  const daemon = spawn(
    "bun",
    ["packages/daemon/src/main.ts", "--db", dbPath, "--socket", socket, "--root", root],
    { stdio: "ignore", env: { ...process.env, XDG_STATE_HOME: join(dir, "state") } },
  )
  const results: Record<string, Stat> = {}
  try {
    await waitFor(socket)
    const c = await IpcClient.connect(socket)

    // 1. ida y vuelta IPC sin trabajo de dominio
    const health = zeros(ITER.health)
    for (let i = 0; i < ITER.health; i++) {
      const t = performance.now()
      await c.call("daemon.health", {})
      health[i] = performance.now() - t
    }
    results.ipc_roundtrip_health_ms = stats(health)

    // 2. mutación (transacción + evento + recibo) y 3. entrega del evento a un suscriptor
    const sub = await IpcClient.connect(socket)
    const arrivals = new Map<string, number>()
    sub.onEvent((e: EventNotification) => {
      const title = (e.payload as { title?: string } | null)?.title
      if (e.kind === "work_item.created" && title) arrivals.set(title, performance.now())
    })
    await sub.call("events.subscribe", { after_event_seq: Number.MAX_SAFE_INTEGER - 1 })
    const create = zeros(ITER.create)
    const deliver = zeros(ITER.create)
    for (let i = 0; i < ITER.create; i++) {
      const title = `bench-${i}`
      const t = performance.now()
      await c.call("work_items.create", {
        request_id: `r${i}`,
        idempotency_key: `k${i}`,
        title,
        kind: "chore",
      })
      create[i] = performance.now() - t
      while (!arrivals.has(title)) await new Promise((r) => setTimeout(r, 0))
      deliver[i] = (arrivals.get(title) as number) - t
    }
    results.mutation_work_items_create_ms = stats(create)
    results.event_delivery_after_create_ms = stats(deliver)
    sub.close()

    // 4. replay completo de la historia a un cliente nuevo
    const replayer = await IpcClient.connect(socket)
    let replayed = 0
    replayer.onEvent(() => replayed++)
    const t0 = performance.now()
    await replayer.call("events.subscribe", { after_event_seq: 0 })
    results[`subscribe_replay_${SEEDED_EVENTS + ITER.create}_events_ms`] = stats([
      performance.now() - t0,
    ])
    if (replayed < SEEDED_EVENTS) throw new Error(`replay incompleto: ${replayed}`)
    replayer.close()
    c.close()

    // 5. backup consistente con el daemon vivo
    const store = openStore(dbPath)
    const tb = performance.now()
    const { manifest } = backupStore(store, join(dir, "backups"))
    results[`backup_vacuum_into_${Math.round(manifest.bytes / 2 ** 20)}mib_ms`] = stats([
      performance.now() - tb,
    ])
    store.db.close()
  } finally {
    daemon.kill("SIGTERM")
  }

  // 6. worktree: crear y liberar sobre un repo de REPO_FILES archivos
  const repo = await openRepo(root)
  const add = zeros(ITER.worktree)
  const remove = zeros(ITER.worktree)
  for (let i = 0; i < ITER.worktree; i++) {
    let t = performance.now()
    await createWorktree(repo, { runId: `bench/${i}/root`, path: join(dir, "wt", String(i)) })
    add[i] = performance.now() - t
    t = performance.now()
    await removeWorktree(repo, `bench/${i}/root`)
    remove[i] = performance.now() - t
  }
  results[`worktree_create_${REPO_FILES}_files_ms`] = stats(add)
  results.worktree_release_clean_ms = stats(remove)

  rmSync(dir, { recursive: true, force: true })
  const report = { script: "scripts/bench-phase0.ts", env, results }
  console.log(JSON.stringify(report, null, 2))
  if (process.argv.includes("--write")) {
    const out = join(
      "docs",
      "benchmarks",
      `${env.measured_at.slice(0, 10)}-${env.platform}${env.wsl ? "-wsl" : ""}.json`,
    )
    mkdirSync(join("docs", "benchmarks"), { recursive: true })
    writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`)
    console.error(`escrito ${out}`)
  }
}

await main()
