/**
 * ADR-0013: intermediario de recursos. SQLite real por Bun.SQL (la lectura la
 * garantiza la base, no el texto), Terraform real (`terraform_data`, sin red) y
 * un `ssh` doble. El secreto centinela no aparece en ningún evento, artefacto,
 * evidencia ni resultado.
 */
import { afterEach, describe, expect, test } from "bun:test"
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SQL } from "bun"
import { Daemon, IpcClient } from "../src/index.ts"
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
  delete process.env.KEEL_TEST_TOKEN
})
const meta = () => ({ request_id: "r", idempotency_key: crypto.randomUUID() })
const SENTINEL = "CENTINELA-9f3a7c21"

async function boot() {
  const dir = mkdtempSync(join(tmpdir(), "keel-res-"))
  dirs.push(dir)
  initRepo(join(dir, "repo"))
  const daemon = new Daemon({
    dbPath: join(dir, "keel.sqlite"),
    socketPath: join(dir, "keel.sock"),
    rootPath: join(dir, "repo"),
    worktreesDir: join(dir, "worktrees"),
    adapterDeps: { queryFn: replayQuery(), binary: "/fake/claude" },
    mcpBridge: false,
    profile: { approval_timeout_ms: 5_000 },
  })
  daemon.start()
  daemons.push(daemon)
  const human = await IpcClient.connect(daemon.server.path)
  clients.push(human)
  const pid = daemon.project.project_id
  const w = daemon.repo.createWorkItem({ project_id: pid, title: "auditoría", kind: "research" })
  const run = daemon.repo.createRun({ project_id: pid, work_item_id: w.id, purpose: "plan" })
  daemon.repo.updateRun(run.id, { status: "running" })
  const { file } = daemon.agentTokens.issue({ run_id: run.id, project_id: pid, work_item_id: w.id })
  const agent = await IpcClient.connect(daemon.agentServer.path)
  clients.push(agent)
  await agent.call("session.bind_agent", { token: readFileSync(file, "utf8") })
  const ledger = join(dir, "contabilidad.db")
  const db = new SQL(`sqlite://${ledger}`)
  await db`create table movimientos(id integer primary key, concepto text, monto integer)`
  await db`insert into movimientos(concepto, monto) values ('caja', 30000), ('banco', -30000)`
  await db.close()
  const exec = (
    who: IpcClient,
    connection: string,
    operation: string,
    input: Record<string, unknown>,
  ) =>
    who.call("resources.execute", { ...meta(), connection, operation, input }) as Promise<{
      rows?: unknown[][]
      row_count?: number
      evidence_id: string | null
      output?: string
      plan_sha256?: string
      exit_code?: number | null
    }>
  return { dir, daemon, human, agent, ledger, exec, w, run }
}

async function addConn(human: IpcClient, p: Record<string, unknown>) {
  return (await human.call("connections.add", { ...meta(), ...p })) as {
    id: string
    operations: { operation: string; effective: string }[]
  }
}

describe("ADR-0013: intermediario de recursos", () => {
  test("query.read con grant auto en dev: el agente ve filas, no la credencial; queda evidencia y evento instrumentado", async () => {
    const { human, agent, ledger, exec, w } = await boot()
    const c = await addConn(human, {
      name: "contabilidad",
      type: "sqlite",
      environment: "dev",
      config: { path: ledger },
    })
    await human.call("grants.set", {
      ...meta(),
      connection_id: c.id,
      operation: "query.read",
      policy: "auto",
    })
    const list = (await agent.call("resources.list", {})) as {
      connections: { name: string; operations: { operation: string; effective: string }[] }[]
    }
    expect(
      list.connections[0]?.operations.find((o) => o.operation === "query.read")?.effective,
    ).toBe("auto")
    const r = await exec(agent, "contabilidad", "query.read", {
      sql: "select concepto, monto from movimientos order by id",
    })
    expect(r.rows).toEqual([
      ["caja", 30000],
      ["banco", -30000],
    ])
    const ev = (await human.call("evidence.list", { work_item_id: w.id })) as {
      evidence: { kind: string; provenance: { role: string; connection: { name: string } } }[]
    }
    expect(ev.evidence[0]).toMatchObject({
      kind: "sql_result",
      provenance: { connection: { name: "contabilidad" } },
    })
    const sem = (await human.call("semantic.list", { kinds: ["database.query.completed"] })) as {
      events: {
        coverage: string
        sensitivity: string
        payload: { row_count: number; server: string }
      }[]
    }
    expect(sem.events[0]).toMatchObject({
      coverage: "instrumented",
      sensitivity: "internal",
      payload: { row_count: 2, server: "contabilidad" },
    })
  })

  test("query.read que intenta escribir falla en la base, aunque el texto engañe", async () => {
    const { human, agent, ledger, exec } = await boot()
    const c = await addConn(human, {
      name: "conta",
      type: "sqlite",
      environment: "dev",
      config: { path: ledger },
    })
    await human.call("grants.set", {
      ...meta(),
      connection_id: c.id,
      operation: "query.read",
      policy: "auto",
    })
    await expect(
      exec(agent, "conta", "query.read", { sql: "/* select */ delete from movimientos" }),
    ).rejects.toThrow("readonly")
    const db = new SQL(`sqlite://${ledger}`)
    expect((await db`select count(*) n from movimientos`)[0].n).toBe(2)
    await db.close()
  })

  // En Windows, dentro de bun test, las dos respuestas del mismo tick (al humano y al
  // agente) se escriben pero no llegan a los clientes del mismo proceso; fuera de bun test
  // el mismo flujo funciona (docs/reviews/2026-10-23-observabilidad-y-artefactos.md).
  test.skipIf(process.platform === "win32")(
    "sin grant vigente se pregunta: denegado no corre; aprobado corre una vez",
    async () => {
      const { human, agent, ledger, exec } = await boot()
      await addConn(human, {
        name: "conta",
        type: "sqlite",
        environment: "dev",
        config: { path: ledger },
      })
      const answer = async (decision: string) => {
        for (let i = 0; i < 200; i++) {
          const { approvals } = (await human.call("approvals.list", {})) as {
            approvals: { id: string; operation_hash: string; operation: { tool: string } }[]
          }
          const a = approvals.find((x) => x.operation.tool === "resource.query.write")
          if (a) {
            await human.call("approvals.resolve", {
              ...meta(),
              approval_id: a.id,
              operation_hash: a.operation_hash,
              decision,
            })
            return
          }
          await Bun.sleep(20)
        }
      }
      const denied = exec(agent, "conta", "query.write", {
        sql: "insert into movimientos(concepto, monto) values ('x', 1)",
      })
      await answer("deny")
      await expect(denied).rejects.toThrow("no aprobó")
      const ok = exec(agent, "conta", "query.write", {
        sql: "insert into movimientos(concepto, monto) values ('y', 2)",
      })
      await answer("approve_once")
      expect(await ok).toMatchObject({ evidence_id: expect.any(String) })
      const db = new SQL(`sqlite://${ledger}`)
      expect(
        (await db`select concepto from movimientos where id > 2`).map(
          (r: { concepto: string }) => r.concepto,
        ),
      ).toEqual(["y"])
      await db.close()
    },
  )

  test("en prod las escrituras nunca son auto y lo producido es restricted, fuera de la búsqueda", async () => {
    const { human, agent, ledger, exec } = await boot()
    const c = await addConn(human, {
      name: "prod-db",
      type: "sqlite",
      environment: "prod",
      config: { path: ledger },
    })
    await expect(
      human.call("grants.set", {
        ...meta(),
        connection_id: c.id,
        operation: "query.write",
        policy: "auto",
      }),
    ).rejects.toThrow("nunca es auto")
    await human.call("grants.set", {
      ...meta(),
      connection_id: c.id,
      operation: "query.read",
      policy: "auto",
    })
    await exec(agent, "prod-db", "query.read", { sql: "select * from movimientos" })
    const sem = (await human.call("semantic.list", {})) as { events: { sensitivity: string }[] }
    expect(sem.events.map((e) => e.sensitivity)).toEqual(["restricted"])
    const found = (await human.call("context.search", { query: "prod" })) as { results: unknown[] }
    expect(found.results).toHaveLength(0)
    // Una configuración con forma de secreto se rechaza: va por referencia.
    await expect(
      addConn(human, {
        name: "mal",
        type: "sqlite",
        environment: "dev",
        config: { path: ledger, password: "x" },
      }),
    ).rejects.toThrow("secret_ref")
  })

  // El ssh doble es un script sh: en Windows no se ejecuta.
  test.skipIf(process.platform === "win32")(
    "ssh: sólo comandos de la lista; la salida queda como evidencia",
    async () => {
      const { dir, human, agent, exec } = await boot()
      const fake = join(dir, "fake-ssh")
      writeFileSync(fake, '#!/bin/sh\nshift 2\necho "ssh args: $@"\n')
      chmodSync(fake, 0o755)
      const c = await addConn(human, {
        name: "web",
        type: "ssh",
        environment: "staging",
        config: {
          host: "web-1",
          user: "deploy",
          ssh_path: fake,
          allowed_commands: ["uptime", "systemctl status"],
        },
        server_guarantee: "usuario deploy con comando forzado",
      })
      await human.call("grants.set", {
        ...meta(),
        connection_id: c.id,
        operation: "command.run",
        policy: "auto",
      })
      const r = await exec(agent, "web", "command.run", { command: "systemctl status nginx" })
      expect(r.output).toContain("deploy@web-1 -- systemctl status nginx")
      await expect(exec(agent, "web", "command.run", { command: "rm -rf /" })).rejects.toThrow(
        "lista permitida",
      )
      await expect(
        exec(agent, "web", "command.run", { command: "uptime; rm -rf /" }),
      ).rejects.toThrow("lista permitida")
    },
  )

  // Terraform real (sin red: terraform_data). Donde no está instalado, se salta.
  test.skipIf(!Bun.which("terraform"))(
    "terraform: el apply sólo corre el plan aprobado; el secreto centinela no sale en nada",
    async () => {
      const { dir, daemon, human, agent, exec } = await boot()
      process.env.KEEL_TEST_TOKEN = SENTINEL
      const tf = join(dir, "infra")
      mkdirSync(tf)
      writeFileSync(
        join(tf, "main.tf"),
        'variable "token" {\n  type = string\n}\nresource "terraform_data" "demo" {\n  input = "hola-${var.token}"\n}\noutput "valor" {\n  value = terraform_data.demo.output\n}\n',
      )
      const c = await addConn(human, {
        name: "infra",
        type: "terraform",
        environment: "dev",
        config: { dir: tf, var_secrets: { token: "env:KEEL_TEST_TOKEN" } },
      })
      await human.call("grants.set", {
        ...meta(),
        connection_id: c.id,
        operation: "iac.plan",
        policy: "auto",
      })
      await human.call("grants.set", {
        ...meta(),
        connection_id: c.id,
        operation: "iac.apply",
        policy: "auto",
      })
      const plan = await exec(agent, "infra", "iac.plan", {})
      expect(plan.plan_sha256).toMatch(/^[0-9a-f]{64}$/)
      expect(plan.output).toContain("[secreto]")

      // Un plan alterado después de planear no se aplica.
      const planFile = join(dir, "plans", `${plan.plan_sha256}.tfplan`)
      const original = readFileSync(planFile)
      writeFileSync(planFile, Buffer.concat([original, Buffer.from("x")]))
      await expect(
        exec(agent, "infra", "iac.apply", { plan_sha256: plan.plan_sha256 }),
      ).rejects.toThrow("el plan cambió")
      writeFileSync(planFile, original)
      const applied = await exec(agent, "infra", "iac.apply", { plan_sha256: plan.plan_sha256 })
      expect(applied.exit_code).toBe(0)
      expect(applied.output).toContain('valor = "hola-[secreto]"')

      // El centinela no está en la base de Keel ni en sus artefactos, ni en lo devuelto.
      const tables = daemon.store.db
        .query<{ name: string }, []>(
          "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE '%fts%'",
        )
        .all()
      for (const { name } of tables) {
        const rows = daemon.store.db.query(`SELECT * FROM "${name}"`).all()
        expect(JSON.stringify(rows)).not.toContain(SENTINEL)
      }
      const art = join(dir, "artifacts")
      const files = existsSync(art)
        ? readdirSync(art, { recursive: true, withFileTypes: true }).filter((d) => d.isFile())
        : []
      expect(files.length).toBeGreaterThan(0)
      for (const f of files)
        expect(readFileSync(join(f.parentPath, f.name), "utf8")).not.toContain(SENTINEL)
      expect(JSON.stringify([plan, applied])).not.toContain(SENTINEL)
    },
    120_000,
  )
})
