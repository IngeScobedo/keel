/**
 * Daemon real para las pruebas end-to-end de los clientes (GUI): SQLite, git y
 * socket reales; los proveedores son dobles (la corrida grabada de Claude y el
 * app-server falso de Codex), así que ningún run gasta suscripción.
 *
 *   bun packages/daemon/test/fixtures/e2e-daemon.ts
 *
 * Escribe una línea JSON con `socket` y `project_id` y vive hasta que se cierra
 * su stdin. Borra su directorio al salir.
 */
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Daemon } from "../../src/index.ts"
import { initRepo } from "../git-fixture.ts"
import { chatQuery, firstPrompt, replayQuery } from "../replay.ts"

const dir = mkdtempSync(join(tmpdir(), "keel-e2e-"))
initRepo(join(dir, "repo"))
// Un segundo repo para abrirlo desde la GUI (ADR-0019 §2).
const otherRepo = initRepo(join(dir, "otro"))
const daemon = new Daemon({
  dbPath: join(dir, "keel.sqlite"),
  socketPath: join(dir, "keel.sock"),
  rootPath: join(dir, "repo"),
  worktreesDir: join(dir, "worktrees"),
  // «chat…» corre el guion del chat de foco (ADR-0020); lo demás, la corrida grabada.
  adapterDeps: {
    queryFn: (a) =>
      firstPrompt(a.prompt).startsWith("chat") ? chatQuery()(a) : replayQuery()(a),
    binary: "/fake/claude",
  },
  mcpBridge: false,
  // Con KEEL_E2E_CODEX_OFF=1 arranca sin el flag: la suscripción se enciende desde la GUI.
  codex: { subscription_enabled: process.env.KEEL_E2E_CODEX_OFF !== "1" },
  codexDeps: {
    appServerLaunch: (args) => ({
      command: process.execPath,
      args: [join(import.meta.dir, "fake-codex-app-server.ts"), ...args],
      env: { ...(process.env as Record<string, string>), FAKE_LOG: join(dir, "fake.ndjson") },
    }),
  },
})
daemon.start()
process.stdout.write(
  `${JSON.stringify({ socket: daemon.server.path, project_id: daemon.project.project_id, other_repo: otherRepo })}\n`,
)

let stopping = false
async function stop() {
  if (stopping) return
  stopping = true
  await daemon.idle()
  daemon.stop()
  rmSync(dir, { recursive: true, force: true })
  process.exit(0)
}
process.stdin.on("end", () => void stop())
process.stdin.on("close", () => void stop())
process.on("SIGTERM", () => void stop())
process.stdin.resume()
