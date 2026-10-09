/**
 * Entrada del daemon:  bun packages/daemon/src/main.ts [--db ruta] [--socket ruta] [--root dir]
 * Defaults: ~/.keel/keel.sqlite y $XDG_RUNTIME_DIR/keel/keel.sock (fallback ~/.keel/keel.sock).
 */
import { mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { Daemon } from "./daemon.js"

export function defaultPaths(): { dbPath: string; socketPath: string } {
  const home = join(homedir(), ".keel")
  mkdirSync(home, { recursive: true, mode: 0o700 })
  const runtime = process.env.XDG_RUNTIME_DIR ? join(process.env.XDG_RUNTIME_DIR, "keel") : home
  return { dbPath: join(home, "keel.sqlite"), socketPath: join(runtime, "keel.sock") }
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : undefined
}

if (import.meta.main) {
  const d = defaultPaths()
  const daemon = new Daemon({
    dbPath: arg("--db") ?? d.dbPath,
    socketPath: arg("--socket") ?? d.socketPath,
    rootPath: arg("--root") ?? process.cwd(),
  })
  const rec = daemon.reconcile()
  daemon.start()
  console.log(
    `keel daemon · db ${daemon.opts.dbPath} · socket ${daemon.server.path} · proyecto ${daemon.project.project_id}`,
  )
  if (rec.interrupted.length)
    console.log(
      `reconciliación: ${rec.interrupted.length} runs marcados interrupted, ${rec.killed.length} procesos terminados`,
    )
  const bye = () => {
    daemon.stop()
    process.exit(0)
  }
  process.on("SIGINT", bye)
  process.on("SIGTERM", bye)
}
