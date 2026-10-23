/**
 * Entrada del daemon:  bun packages/daemon/src/main.ts [--db ruta] [--socket ruta] [--root dir]
 * Defaults: ~/.keel/keel.sqlite y el endpoint de ADR-0005 §1 (ipc/endpoint.ts): socket Unix
 * en $XDG_RUNTIME_DIR/keel/keel.sock (fallback ~/.keel/keel.sock), Named Pipe en Windows.
 *
 * Límites (ADR-0002 regla 3; defaults bajos en limits.ts). Subirlos es explícito:
 *   --max-concurrent-runs N   --run-budget-usd X   --daily-budget-usd Y
 *
 * Mantenimiento del store (SDD 03 §7), seguro con el daemon en marcha:
 *   main.ts backup  [--db ruta] --out dir             → manifest con sha256
 *   main.ts restore --manifest ruta --db ruta-nueva   → nunca pisa una base existente
 */
import { mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { Daemon } from "./daemon.js"
import { defaultEndpoint } from "./ipc/endpoint.js"
import type { Limits } from "./limits.js"
import { backupStore, restoreStore } from "./store/backup.js"
import { openStore } from "./store/db.js"

export function defaultPaths(): { dbPath: string; socketPath: string } {
  const home = join(homedir(), ".keel")
  mkdirSync(home, { recursive: true, mode: 0o700 })
  return { dbPath: join(home, "keel.sqlite"), socketPath: defaultEndpoint() }
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : undefined
}

function limitsFromArgs(): Partial<Limits> {
  const num = (name: string) => {
    const v = arg(name)
    if (v === undefined) return undefined
    const n = Number(v)
    if (!Number.isFinite(n) || n <= 0) throw new Error(`${name} necesita un número positivo`)
    return n
  }
  const out: Partial<Limits> = {}
  const runs = num("--max-concurrent-runs")
  const run = num("--run-budget-usd")
  const day = num("--daily-budget-usd")
  if (runs !== undefined) out.max_concurrent_runs = Math.floor(runs)
  if (run !== undefined) out.run_budget_micro_usd = Math.round(run * 1e6)
  if (day !== undefined) out.daily_budget_micro_usd = Math.round(day * 1e6)
  return out
}

function maintenance(command: string): void {
  const d = defaultPaths()
  if (command === "backup") {
    const out = arg("--out")
    if (!out) throw new Error("backup necesita --out <dir>")
    const store = openStore(arg("--db") ?? d.dbPath)
    try {
      const { manifestPath, manifest } = backupStore(store, out)
      console.log(`backup ${manifest.bytes} bytes · sha256 ${manifest.sha256} · ${manifestPath}`)
    } finally {
      store.db.close()
    }
  } else {
    const manifest = arg("--manifest")
    const db = arg("--db")
    if (!manifest || !db) throw new Error("restore necesita --manifest <ruta> y --db <ruta nueva>")
    console.log(JSON.stringify(restoreStore(manifest, db), null, 2))
  }
}

if (import.meta.main && (process.argv[2] === "backup" || process.argv[2] === "restore")) {
  maintenance(process.argv[2])
} else if (import.meta.main) {
  const d = defaultPaths()
  const daemon = new Daemon({
    dbPath: arg("--db") ?? d.dbPath,
    socketPath: arg("--socket") ?? d.socketPath,
    rootPath: arg("--root") ?? process.cwd(),
    limits: limitsFromArgs(),
  })
  // start() reconcilia una sola vez y libera los worktrees de lo interrumpido.
  const rec = daemon.start()
  const l = daemon.limits
  console.log(
    `límites · ${l.max_concurrent_runs} run(s) a la vez · $${l.run_budget_micro_usd / 1e6} estimado por run · $${l.daily_budget_micro_usd / 1e6} estimado por día`,
  )
  console.log(
    `keel daemon · db ${daemon.opts.dbPath} · socket ${daemon.server.path} · proyecto ${daemon.project.project_id}`,
  )
  if (rec.interrupted.length)
    console.log(
      `reconciliación: ${rec.interrupted.length} runs marcados interrupted; ${rec.orphans.length} procesos registrados por comprobar`,
    )
  const bye = () => {
    // Apagado ordenado: los runs y liberaciones en curso terminan antes de cerrar la base.
    void daemon.idle().finally(() => {
      daemon.stop()
      process.exit(0)
    })
  }
  process.on("SIGINT", bye)
  process.on("SIGTERM", bye)
}
