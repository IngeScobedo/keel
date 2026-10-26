/**
 * ADR-0025 y ADR-0026 contra un daemon real: conexiones con método de entrada, el vault,
 * askpass de verdad (`main.ts askpass` por la puerta humana) y un `ssh` doble que lo usa
 * como lo haría OpenSSH. Ningún secreto aparece en eventos, artefactos ni en la base.
 */
import { afterEach, describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, normalize } from "node:path"
import { Daemon, IpcClient } from "../src/index.ts"
import { memoryKeyStore } from "../src/vault/keystore.ts"
import { envFromAlias, generateEd25519, hostAliases, importSshConfig } from "../src/vault/ssh.ts"
import { initRepo } from "./git-fixture.ts"
import { replayQuery } from "./replay.ts"

const dirs: string[] = []
const daemons: Daemon[] = []
const clients: IpcClient[] = []
afterEach(async () => {
  for (const c of clients.splice(0)) c.close()
  for (const d of daemons.splice(0)) {
    await d.idle()
    d.stop()
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
const meta = () => ({ request_id: "r", idempotency_key: crypto.randomUUID() })
const SENTINEL = "centinela-vault-5d1e"

type View = {
  id: string
  name: string
  auth_method: string | null
  secret: { kind: string; public_key: string | null } | null
  operations: {
    operation: string
    policy: string
    effective: string
    risk_accepted_at?: string | null
  }[]
}

/** Un `ssh` doble: pide la contraseña por askpass como OpenSSH, y dice qué agente usaría. */
const FAKE_SSH = `#!/bin/bash
for a in "$@"; do case "$a" in IdentityAgent=*) agent="\${a#IdentityAgent=}";; esac; done
if [ -n "$SSH_ASKPASS" ]; then pw=$("$SSH_ASKPASS" "deploy@203.0.113.10's password: ") || exit 255; echo "entró con: $pw"; fi
if [ -n "$agent" ] && [ "$agent" != "none" ]; then echo "llaves: $(SSH_AUTH_SOCK=$agent ssh-add -L)"; fi
echo "corrió: \${@: -1}"
`

async function boot() {
  const dir = mkdtempSync(join(tmpdir(), "keel-vc-"))
  dirs.push(dir)
  initRepo(join(dir, "repo"))
  const fake = join(dir, "fake-ssh")
  writeFileSync(fake, FAKE_SSH)
  chmodSync(fake, 0o755)
  const daemon = new Daemon({
    dbPath: join(dir, "keel.sqlite"),
    socketPath: join(dir, "keel.sock"),
    rootPath: join(dir, "repo"),
    worktreesDir: join(dir, "worktrees"),
    adapterDeps: { queryFn: replayQuery(), binary: "/fake/claude" },
    mcpBridge: false,
    keystore: memoryKeyStore(),
    profile: { approval_timeout_ms: 10_000 },
  })
  daemon.start()
  daemons.push(daemon)
  await daemon.idle()
  const human = await IpcClient.connect(daemon.server.path)
  clients.push(human)
  const pid = daemon.project.project_id
  const w = daemon.repo.createWorkItem({ project_id: pid, title: "desplegar", kind: "chore" })
  const run = daemon.repo.createRun({ project_id: pid, work_item_id: w.id, purpose: "plan" })
  daemon.repo.updateRun(run.id, { status: "running" })
  const { file } = daemon.agentTokens.issue({ run_id: run.id, project_id: pid, work_item_id: w.id })
  const agent = await IpcClient.connect(daemon.agentServer.path)
  clients.push(agent)
  await agent.call("session.bind_agent", { token: readFileSync(file, "utf8") })
  const add = (p: Record<string, unknown>) =>
    human.call("connections.add", {
      ...meta(),
      type: "ssh",
      environment: "dev",
      config: { host: "203.0.113.10", user: "deploy", ssh_path: fake },
      ...p,
    }) as Promise<View>
  const run_ = (connection: string, command: string) =>
    agent.call("resources.execute", {
      ...meta(),
      connection,
      operation: "command.run",
      input: { command },
    }) as Promise<{ output: string; exit_code: number }>
  const allow = (connection_id: string, extra: Record<string, unknown> = {}) =>
    human.call("grants.set", {
      ...meta(),
      connection_id,
      operation: "command.run",
      policy: "auto",
      ...extra,
    }) as Promise<View>
  const events = () => daemon.repo.eventsAfter(0, null, 100_000)
  return {
    dir,
    daemon,
    human,
    agent,
    add,
    run: run_,
    allow,
    events,
    runId: run.id,
    workItemId: w.id,
  }
}

/** Nada de la base, eventos ni artefactos contiene el secreto. */
function assertNoLeak(dir: string, daemon: Daemon, secret: string) {
  daemon.store.db.exec("PRAGMA wal_checkpoint(TRUNCATE)")
  expect(readFileSync(join(dir, "keel.sqlite")).includes(Buffer.from(secret))).toBe(false)
  const walk = (d: string): string[] =>
    readdirSync(d, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)],
    )
  for (const f of walk(join(dir, "artifacts")))
    expect(readFileSync(f).includes(Buffer.from(secret))).toBe(false)
}

// El ssh doble es un script de bash y el ssh-agent de Keel es POSIX: en Windows no corren.
describe.skipIf(process.platform === "win32")("ADR-0025: conexiones con el vault", () => {
  test("password: el vault entrega la contraseña por askpass y la salida sale redactada", async () => {
    const { dir, daemon, add, run, allow } = await boot()
    expect(await daemon.vault.open()).toBe("unlocked")
    const c = await add({ name: "staging-api", auth_method: "password", secret_value: SENTINEL })
    expect(c.auth_method).toBe("password")
    expect(c.secret?.kind).toBe("password")
    await allow(c.id)
    const r = await run("staging-api", "docker compose ps")
    expect(r.output).toContain("entró con: [secreto]")
    expect(r.output).toContain("corrió: docker compose ps")
    expect(r.output).not.toContain(SENTINEL)
    assertNoLeak(dir, daemon, SENTINEL)
  }, 30_000)

  test("ask: se le pregunta al humano en la GUI y, si lo pide, queda en el vault", async () => {
    const { dir, daemon, human, add, run, allow, events } = await boot()
    const c = await add({ name: "dev-box", auth_method: "ask" })
    await allow(c.id)
    const pending = run("dev-box", "uptime")
    const end = Date.now() + 10_000
    let prompt: { prompt_id: string; what: string; connection_name: string } | undefined
    while (!prompt && Date.now() < end) {
      prompt = events()
        .filter((e) => e.kind === "secret.prompt_requested")
        .map((e) => JSON.parse(e.payload_json))[0]
      await Bun.sleep(20)
    }
    expect(prompt?.connection_name).toBe("dev-box")
    expect(prompt?.what).toBe("password")
    await human.call("secrets.prompt_answer", {
      ...meta(),
      prompt_id: prompt?.prompt_id,
      value: SENTINEL,
      remember: "vault",
    })
    const r = await pending
    expect(r.output).toContain("entró con: [secreto]")
    const after = (await human.call("connections.list", {})) as { connections: View[] }
    const saved = after.connections.find((x) => x.name === "dev-box")
    expect(saved?.auth_method).toBe("password")
    expect(saved?.secret?.kind).toBe("password")
    // La segunda vez ya no pregunta.
    const before = events().filter((e) => e.kind === "secret.prompt_requested").length
    await run("dev-box", "uptime")
    expect(events().filter((e) => e.kind === "secret.prompt_requested").length).toBe(before)
    assertNoLeak(dir, daemon, SENTINEL)
  }, 30_000)

  test("key: Keel genera la llave, la pública sirve para authorized_keys y la privada no toca el disco", async () => {
    const { dir, human, add, run, allow } = await boot()
    const c = await add({ name: "deploy-staging", auth_method: "agent" })
    const k = (await human.call("connections.generate_key", {
      ...meta(),
      connection_id: c.id,
      command: "/opt/deploy/deploy.sh",
      from: "198.51.100.7",
    })) as { connection: View; public_key: string; authorized_keys: string }
    expect(k.connection.auth_method).toBe("key")
    expect(k.public_key).toMatch(/^ssh-ed25519 AAAA\S+ keel\//)
    expect(k.authorized_keys).toContain('command="/opt/deploy/deploy.sh"')
    expect(k.authorized_keys).toContain('from="198.51.100.7"')
    await allow(c.id)
    const r = await run("deploy-staging", "./deploy.sh")
    expect(r.output).toContain(k.public_key.split(" ")[1] as string)
    const walk = (d: string): string[] =>
      readdirSync(d, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? walk(join(d, e.name)) : e.isSocket() ? [] : [join(d, e.name)],
      )
    for (const f of walk(dir))
      expect(readFileSync(f).includes(Buffer.from("BEGIN OPENSSH PRIVATE KEY"))).toBe(false)
  }, 30_000)

  test("el vault bloqueado no entrega nada y lo dice", async () => {
    const { dir, daemon, human, add } = await boot()
    const c = await add({ name: "pg", auth_method: "password", secret_value: "x".repeat(12) })
    expect(c.secret?.kind).toBe("password")
    // Otro daemon sobre la misma base, sin la llave maestra en su llavero.
    await human
      .call("vault.status", {})
      .then((s) => expect((s as { state: string }).state).toBe("unlocked"))
    daemon.stop()
    daemons.splice(daemons.indexOf(daemon), 1)
    const other = new Daemon({
      dbPath: join(dir, "keel.sqlite"),
      socketPath: join(dir, "keel2.sock"),
      rootPath: join(dir, "repo"),
      worktreesDir: join(dir, "worktrees"),
      adapterDeps: { queryFn: replayQuery(), binary: "/fake/claude" },
      mcpBridge: false,
      keystore: memoryKeyStore(),
    })
    other.start()
    daemons.push(other)
    await other.idle()
    const h2 = await IpcClient.connect(other.server.path)
    clients.push(h2)
    expect(((await h2.call("vault.status", {})) as { state: string }).state).toBe("locked")
  }, 30_000)

  test("setup_request: rechaza secretos; el humano da de alta y el agente recibe una línea", async () => {
    const { human, agent, add, daemon, runId } = await boot()
    const bad = await agent
      .call("setup.request", {
        ...meta(),
        kind: "connection",
        why: "desplegar",
        proposal: { type: "ssh", host: "203.0.113.10", password: "x" },
      })
      .catch((e: Error) => e.message)
    expect(String(bad)).toContain("parece un secreto")
    const asked = agent.call("setup.request", {
      ...meta(),
      kind: "connection",
      why: "deploy.sh hace ssh deploy@203.0.113.10",
      proposal: {
        type: "ssh",
        name: "prod-ssh",
        environment: "prod",
        host: "203.0.113.10",
        user: "deploy",
      },
      evidence: "infrastructure/scripts/deploy.sh:12",
    }) as Promise<{ state: string; message: string }>
    let approval: { id: string } | undefined
    const end = Date.now() + 10_000
    while (!approval && Date.now() < end) {
      approval = daemon.repo
        .listApprovals(daemon.project.project_id)
        .find((a) => JSON.parse(a.operation_json).tool === "setup.request")
      await Bun.sleep(20)
    }
    expect(approval).toBeDefined()
    await add({
      name: "prod-ssh",
      environment: "prod",
      auth_method: "agent",
      setup_request_id: approval?.id,
    })
    const r = await asked
    expect(r.state).toBe("approved")
    expect(r.message).toBe("conexión prod-ssh lista (prod): command.run (ask)")
    expect(runId).toBeTruthy()
    void human
  }, 30_000)
})

// El ssh doble es un script de bash y el ssh-agent de Keel es POSIX: en Windows no corren.
describe.skipIf(process.platform === "win32")("ADR-0025 §7: el alcance de una aprobación", () => {
  test("«esta tarea» deja de preguntar en esa tarea; «este proyecto» en prod se rechaza", async () => {
    const { daemon, human, add, run } = await boot()
    await add({ name: "staging-x", environment: "staging", auth_method: "agent" })
    await add({ name: "prod-x", environment: "prod", auth_method: "agent" })
    const pid = daemon.project.project_id
    const pendingFor = async (conn: string) => {
      const end = Date.now() + 10_000
      while (Date.now() < end) {
        const a = daemon.repo
          .listApprovals(pid)
          .find((x) => JSON.parse(x.operation_json).input?.connection === conn)
        if (a) return a
        await Bun.sleep(20)
      }
      throw new Error("no llegó la aprobación")
    }
    const first = run("staging-x", "uptime")
    const a = await pendingFor("staging-x")
    await human.call("approvals.resolve", {
      ...meta(),
      approval_id: a.id,
      operation_hash: a.operation_hash,
      decision: "approve_session",
    })
    expect((await first).output).toContain("corrió: uptime")
    // La segunda vez, en la misma tarea, ya no pregunta.
    expect((await run("staging-x", "df -h")).output).toContain("corrió: df -h")
    const third = run("prod-x", "uptime").catch((e: Error) => e.message)
    const b = await pendingFor("prod-x")
    const always = await human
      .call("approvals.resolve", {
        ...meta(),
        approval_id: b.id,
        operation_hash: b.operation_hash,
        decision: "approve_always",
      })
      .catch((e: Error) => e.message)
    expect(String(always)).toContain("escribiendo su nombre")
    await human.call("approvals.resolve", {
      ...meta(),
      approval_id: b.id,
      operation_hash: b.operation_hash,
      decision: "deny",
    })
    expect(String(await third)).toContain("no aprobó")
  }, 30_000)
})

// El ssh doble es un script de bash y el ssh-agent de Keel es POSIX: en Windows no corren.
describe.skipIf(process.platform === "win32")(
  "ADR-0026: en producción se pregunta y se puede quitar asumiendo el riesgo",
  () => {
    test("sin escribir el nombre no se quita; con el nombre, corre sin preguntar y queda registrado", async () => {
      const { add, allow, run, events } = await boot()
      const c = await add({ name: "prod-casamatte", environment: "prod", auth_method: "agent" })
      expect(c.operations[0]?.effective).toBe("ask")
      const noName = await allow(c.id).catch((e: Error) => e.message)
      expect(String(noName)).toContain("escribe el nombre de la conexión")
      const wrong = await allow(c.id, { risk_confirm: "prod-casamat" }).catch(
        (e: Error) => e.message,
      )
      expect(String(wrong)).toContain("escribe el nombre")
      const ok = await allow(c.id, { risk_confirm: "prod-casamatte" })
      expect(ok.operations[0]?.effective).toBe("auto")
      expect(ok.operations[0]?.risk_accepted_at).toBeTruthy()
      const r = await run("prod-casamatte", "docker compose up -d")
      expect(r.output).toContain("corrió: docker compose up -d")
      const accepted = events().filter((e) => e.kind === "grant.risk_accepted")
      expect(accepted).toHaveLength(1)
      expect(JSON.parse(accepted[0]?.payload_json ?? "{}").actor.kind).toBe("human")
    }, 30_000)

    test("el agente no puede pedir quitar la pregunta en prod", async () => {
      const { agent, add } = await boot()
      await add({ name: "prod-db", environment: "prod", auth_method: "agent" })
      const r = await agent
        .call("setup.request", {
          ...meta(),
          kind: "grant",
          why: "para no preguntar",
          proposal: { connection: "prod-db", operation: "command.run", policy: "auto" },
        })
        .catch((e: Error) => e.message)
      expect(String(r)).toContain("decisión del humano")
    })
  },
)

describe("ADR-0025: importar y llaves", () => {
  test("importa los Host de ~/.ssh/config con el entorno por prefijo, sin leer llaves", async () => {
    const home = mkdtempSync(join(tmpdir(), "keel-home-"))
    dirs.push(home)
    execFileSync("mkdir", ["-p", join(home, ".ssh")])
    writeFileSync(join(home, ".ssh", "id_ed25519"), "no la lee Keel")
    writeFileSync(
      join(home, ".ssh", "config"),
      "Host prod-casamatte\n  HostName 203.0.113.21\n  User root\nHost staging-x dev-y\n  HostName 10.0.0.2\n  Port 2222\nHost *\n  IdentityFile ~/.ssh/id_ed25519\n",
    )
    expect(hostAliases(readFileSync(join(home, ".ssh", "config"), "utf8"))).toEqual([
      "prod-casamatte",
      "staging-x",
      "dev-y",
    ])
    const hosts = await importSshConfig({ home })
    expect(hosts.map((h) => [h.alias, h.host, h.user, h.port, h.environment])).toEqual([
      ["prod-casamatte", "203.0.113.21", "root", 22, "prod"],
      ["staging-x", "10.0.0.2", expect.any(String), 2222, "staging"],
      ["dev-y", "10.0.0.2", expect.any(String), 2222, "dev"],
    ])
    expect(hosts[0]?.identity_file).toBe(normalize(join(home, ".ssh", "id_ed25519")))
    expect(envFromAlias("rifas").environment).toBeNull()
  })

  test("la llave generada la acepta OpenSSH y su pública coincide", () => {
    const dir = mkdtempSync(join(tmpdir(), "keel-key-"))
    dirs.push(dir)
    const k = generateEd25519("keel/test")
    writeFileSync(join(dir, "k"), k.privatePem, { mode: 0o600 })
    const pub = execFileSync("ssh-keygen", ["-y", "-f", join(dir, "k")], {
      encoding: "utf8",
    }).trim()
    expect(pub.split(" ").slice(0, 2)).toEqual(k.publicLine.split(" ").slice(0, 2))
  })
})
