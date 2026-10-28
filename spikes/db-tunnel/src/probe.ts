// Spike ADR-0033: túnel ssh -L a Postgres de prod y SSLRequest (sin credenciales).
import { spawn } from "node:child_process"
import { connect, createServer } from "node:net"

const freePort = () =>
  new Promise<number>((r) => {
    const s = createServer()
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as { port: number }).port
      s.close(() => r(p))
    })
  })
const port = await freePort()
const t0 = performance.now()
const ssh = spawn(
  "ssh",
  [
    "-F",
    "none",
    "-o",
    "ControlMaster=no",
    "-o",
    "ControlPath=none",
    "-N",
    "-o",
    "BatchMode=yes",
    "-o",
    "ExitOnForwardFailure=yes",
    "-o",
    "StrictHostKeyChecking=yes",
    "-L",
    `127.0.0.1:${port}:${process.env.TUNNEL_TARGET ?? "127.0.0.1:5432"}`,
    process.env.TUNNEL_DEST ?? "user@host",
  ],
  { stdio: ["ignore", "ignore", "pipe"] },
)
let err = ""
ssh.stderr.on("data", (d) => (err += d))
const ready = async () => {
  for (let i = 0; i < 100; i++) {
    const ok = await new Promise<boolean>((r) => {
      const c = connect(port, "127.0.0.1")
      c.once("connect", () => {
        c.destroy()
        r(true)
      })
      c.once("error", () => r(false))
    })
    if (ok) return true
    await Bun.sleep(100)
  }
  return false
}
const up = await ready()
const tUp = performance.now() - t0
const probe = () =>
  new Promise<{ ans: string; ms: number }>((r, j) => {
    const s = performance.now()
    const c = connect(port, "127.0.0.1", () => {
      const b = Buffer.alloc(8)
      b.writeInt32BE(8, 0)
      b.writeInt32BE(80877103, 4)
      c.write(b)
    })
    c.once("data", (d) => {
      r({ ans: String.fromCharCode(d[0] as number), ms: Math.round(performance.now() - s) })
      c.destroy()
    })
    c.once("error", j)
    setTimeout(() => j(new Error("timeout")), 10000)
  })
const results = []
for (let i = 0; i < 5; i++) results.push(await probe().catch((e) => ({ ans: String(e), ms: -1 })))
console.log(JSON.stringify({ tunnel_up: up, tunnel_ms: Math.round(tUp), sslrequest: results }))
const tk = performance.now()
ssh.kill("SIGTERM")
const exited = await Promise.race([
  new Promise((r) => ssh.once("exit", () => r(true))),
  Bun.sleep(5000).then(() => false),
])
console.log(JSON.stringify({ exited, close_ms: Math.round(performance.now() - tk) }))
const still = await new Promise<boolean>((r) => {
  const c = connect(port, "127.0.0.1")
  c.once("connect", () => {
    c.destroy()
    r(true)
  })
  c.once("error", () => r(false))
})
console.log(JSON.stringify({ port_open_after_close: still, ssh_stderr: err.trim().slice(0, 200) }))
process.exit(0)
