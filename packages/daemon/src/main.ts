/**
 * Entrada del daemon:  bun packages/daemon/src/main.ts [--db ruta] [--socket ruta] [--root dir]
 * Sin --root abre el último proyecto; los demás se abren desde la GUI (projects.open).
 * Defaults: ~/.keel/keel.sqlite y el endpoint de ADR-0005 §1 (ipc/endpoint.ts): socket Unix
 * en $XDG_RUNTIME_DIR/keel/keel.sock (fallback ~/.keel/keel.sock), Named Pipe en Windows.
 *
 * Límites (ADR-0002 regla 3; defaults bajos en limits.ts). Subirlos es explícito:
 *   --max-concurrent-runs N   --run-budget-usd X   --daily-budget-usd Y
 *
 * Codex (ADR-0008): los runs con `profile: "codex"` usan la sesión de `codex`
 * del usuario sólo si se habilita aquí, explícitamente:
 *   --codex-subscription      [--codex-model nombre]  [--codex-transport app_server|sdk]
 *
 * Mantenimiento del store (SDD 03 §7), seguro con el daemon en marcha:
 *   main.ts backup  [--db ruta] --out dir             → manifest con sha256
 *   main.ts restore --manifest ruta --db ruta-nueva   → nunca pisa una base existente
 *
 * Puente MCP para agentes (ADR-0009); lo lanza el proveedor de cada run:
 *   main.ts mcp    (lee KEEL_RUN_TOKEN_FILE y KEEL_SOCKET del entorno)
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { Daemon } from "./daemon.js"
import { IpcClient } from "./ipc/client.js"
import { defaultEndpoint } from "./ipc/endpoint.js"
import type { Limits } from "./limits.js"
import { runBridge } from "./mcp/bridge.js"
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

if (import.meta.main && process.argv[2] === "mcp") {
  await runBridge()
} else if (import.meta.main && (process.argv[2] === "backup" || process.argv[2] === "restore")) {
  maintenance(process.argv[2])
} else if (import.meta.main) {
  const d = defaultPaths()
  const socketPath = arg("--socket") ?? d.socketPath
  // Un daemon por usuario (ADR-0019 §1): si ya hay uno vivo en el endpoint, éste se
  // retira en vez de pisar su socket. Lo que quedó de una caída sí se reemplaza.
  if (await daemonAlive(socketPath)) {
    console.log(`keel daemon ya está corriendo en ${socketPath}`)
    process.exit(0)
  }
  const dbPath = arg("--db") ?? d.dbPath
  // Y una base por daemon: dos daemons con sockets distintos sobre la misma base serían
  // dos escritores con dos outbox.
  const holder = readLock(dbPath)
  if (holder && holder.socket !== socketPath && (await daemonAlive(holder.socket))) {
    console.error(`otro daemon usa ${dbPath} (socket ${holder.socket}); no arranco`)
    process.exit(1)
  }
  writeFileSync(`${dbPath}.lock`, JSON.stringify({ pid: process.pid, socket: socketPath }), {
    mode: 0o600,
  })
  const daemon = new Daemon({
    dbPath,
    socketPath,
    // Sin --root: el último proyecto abierto (la GUI arranca el daemon así, ADR-0019 §1).
    ...(arg("--root") ? { rootPath: arg("--root") as string } : {}),
    limits: limitsFromArgs(),
    codex: {
      subscription_enabled: process.argv.includes("--codex-subscription"),
      ...(arg("--codex-model") ? { model: arg("--codex-model") as string } : {}),
      ...(arg("--codex-transport") === "sdk" ? { transport: "sdk" as const } : {}),
    },
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
      if (readLock(dbPath)?.pid === process.pid) rmSync(`${dbPath}.lock`, { force: true })
      process.exit(0)
    })
  }
  process.on("SIGINT", bye)
  process.on("SIGTERM", bye)
}

/** ¿Responde un daemon en ese endpoint? Un socket huérfano no responde. */
async function daemonAlive(path: string): Promise<boolean> {
  let c: IpcClient | null = null
  try {
    c = await IpcClient.connect(path)
    await Promise.race([
      c.call("daemon.health", {}),
      new Promise((_, reject) => setTimeout(() => reject(new Error("sin respuesta")), 2000)),
    ])
    return true
  } catch {
    return false
  } finally {
    c?.close()
  }
}

function readLock(dbPath: string): { pid: number; socket: string } | null {
  try {
    return JSON.parse(readFileSync(`${dbPath}.lock`, "utf8")) as { pid: number; socket: string }
  } catch {
    return null
  }
}
