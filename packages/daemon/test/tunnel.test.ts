/**
 * ADR-0033: el túnel SSH hacia una base. `ssh` es un doble que reenvía de verdad el
 * puerto (-L) hacia un servidor TCP local; lo que se prueba es la vida del túnel: abre,
 * pasa datos, se reusa, se cierra sin dejar el puerto abierto y falla claro.
 */
import { afterEach, describe, expect, test } from "bun:test"
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { connect, createServer, type Server } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { TunnelError, TunnelPool, tunnelArgs } from "../src/resources/tunnel.ts"

const dirs: string[] = []
const servers: Server[] = []
const pools: TunnelPool[] = []
afterEach(() => {
  for (const p of pools.splice(0)) p.closeWhere(() => true)
  for (const s of servers.splice(0)) s.close()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

/** Un `ssh -N -L l:h:p` doble: escucha en l y reenvía a h:p. Con FAKE_SSH_FAIL, falla. */
const FAKE_SSH = `#!/usr/bin/env bun
import { connect, createServer } from "node:net"
if (process.env.FAKE_SSH_FAIL) { console.error("Host key verification failed."); process.exit(255) }
const spec = process.argv[process.argv.indexOf("-L") + 1].split(":")
const [lh, lp, th, tp] = spec
await Bun.sleep(150)
createServer((c) => { const t = connect(Number(tp), th); c.pipe(t); t.pipe(c); t.on("error", () => c.destroy()); c.on("error", () => t.destroy()) }).listen(Number(lp), lh)
`

async function echo(): Promise<number> {
  const s = createServer((c) => c.on("data", (d) => c.write(`eco:${d}`)))
  servers.push(s)
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", () => r()))
  return (s.address() as { port: number }).port
}

function ask(port: number, text: string): Promise<string> {
  return new Promise((done, fail) => {
    const c = connect(port, "127.0.0.1", () => c.write(text))
    c.once("data", (d) => {
      done(String(d))
      c.destroy()
    })
    c.once("error", fail)
  })
}

function setup(env: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "keel-tunnel-"))
  dirs.push(dir)
  const ssh = join(dir, "ssh")
  writeFileSync(ssh, FAKE_SSH)
  chmodSync(ssh, 0o755)
  const pool = new TunnelPool()
  pools.push(pool)
  let prepared = 0
  let done = 0
  const prepare = async () => {
    prepared++
    return {
      ssh,
      args: ["-F", "none", "-o", "StrictHostKeyChecking=yes", "-T"],
      env: { ...(process.env as Record<string, string>), ...env },
      redact: [],
      done: () => {
        done++
      },
    }
  }
  return { pool, prepare, counts: () => ({ prepared, done }) }
}

describe.skipIf(process.platform === "win32")("ADR-0033: túnel SSH hacia una base", () => {
  test("abre, pasa datos, se reusa en el mismo run y se cierra sin dejar el puerto abierto", async () => {
    const target = await echo()
    const { pool, prepare, counts } = setup()
    const a = await pool.acquire(
      "run1:db",
      "servidor",
      { host: "127.0.0.1", port: target },
      prepare,
    )
    expect(a.opened_ms).toBeGreaterThan(0)
    expect(await ask(a.port, "hola")).toBe("eco:hola")
    a.release()
    // Otra consulta del mismo run: el mismo túnel, sin volver a entrar.
    const b = await pool.acquire(
      "run1:db",
      "servidor",
      { host: "127.0.0.1", port: target },
      prepare,
    )
    expect(b.port).toBe(a.port)
    expect(b.opened_ms).toBe(0)
    b.release()
    expect(counts()).toEqual({ prepared: 1, done: 1 })
    // Al terminar el run, se cierra y el puerto deja de escuchar.
    pool.closeWhere((k) => k.startsWith("run1:"))
    await Bun.sleep(200)
    await expect(ask(a.port, "x")).rejects.toThrow()
    expect(pool.size()).toBe(0)
  })

  test("una huella rechazada falla claro y no deja nada abierto", async () => {
    const { pool, prepare } = setup({ FAKE_SSH_FAIL: "1" })
    await expect(
      pool.acquire("run2:db", "servidor", { host: "127.0.0.1", port: 1 }, prepare),
    ).rejects.toThrow(TunnelError)
    await expect(
      pool.acquire("run2:db", "servidor", { host: "127.0.0.1", port: 1 }, prepare),
    ).rejects.toThrow("huella")
    expect(pool.size()).toBe(0)
  })

  test("las opciones del túnel: sin conexión compartida, -L sólo en 127.0.0.1, sin -T", () => {
    const args = tunnelArgs(["-F", "none", "-T", "-l", "root"], 40000, {
      host: "127.0.0.1",
      port: 5432,
    })
    expect(args).not.toContain("-T")
    expect(args).toContain("ControlMaster=no")
    expect(args).toContain("ControlPath=none")
    expect(args).toContain("ExitOnForwardFailure=yes")
    expect(args.slice(-2)).toEqual(["-L", "127.0.0.1:40000:127.0.0.1:5432"])
  })
})
