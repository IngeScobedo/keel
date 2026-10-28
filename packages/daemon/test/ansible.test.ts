/**
 * ADR-0031 contra un daemon real: un destino `ansible` sobre una conexión SSH del vault.
 * `ansible-playbook` y `ansible-vault` son dobles que se portan como los de verdad con el
 * callback de Keel (escriben los eventos en KEEL_ANSIBLE_EVENTS); askpass es el de verdad.
 * Ni la contraseña de ansible-vault ni lo que guarda su vault salen en eventos,
 * artefactos o resultados.
 */
import { afterEach, describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Daemon, IpcClient } from "../src/index.ts"
import { memoryKeyStore } from "../src/vault/keystore.ts"
import { VAULT_PASS, VAULT_VALUE, writeFakeAnsible } from "./fixtures/fake-ansible.ts"
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
const sh = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, stdio: "pipe" }).toString().trim()

async function boot() {
  const dir = mkdtempSync(join(tmpdir(), "keel-ansible-"))
  dirs.push(dir)
  const repo = initRepo(join(dir, "repo"))
  const infra = join(repo, "infra", "ansible")
  mkdirSync(infra, { recursive: true })
  writeFileSync(join(infra, "site.yml"), "- hosts: all\n  roles: [app]\n")
  writeFileSync(join(infra, ".gitignore"), "vault.yml\n")
  sh(repo, "add", ".")
  sh(repo, "commit", "-q", "-m", "playbook")
  // Fuera de git, como el vault.yml de Casa Matte.
  writeFileSync(join(infra, "vault.yml"), "$ANSIBLE_VAULT;1.1;AES256\n6162\n")
  const playbook = writeFakeAnsible(join(dir, "bin"))
  const daemon = new Daemon({
    dbPath: join(dir, "keel.sqlite"),
    socketPath: join(dir, "keel.sock"),
    rootPath: repo,
    worktreesDir: join(dir, "worktrees"),
    adapterDeps: { queryFn: replayQuery(), binary: "/fake/claude" },
    mcpBridge: false,
    keystore: memoryKeyStore(),
  })
  daemon.start()
  daemons.push(daemon)
  await daemon.idle()
  const human = await IpcClient.connect(daemon.server.path)
  clients.push(human)
  await human.call("connections.add", {
    ...meta(),
    name: "prod-web",
    type: "ssh",
    environment: "prod",
    config: { host: "203.0.113.20", user: "root" },
    auth_method: "agent",
  })
  const target = (environment: string) =>
    human.call("connections.add", {
      ...meta(),
      name: "despliegue",
      type: "ansible",
      environment,
      config: {
        dir: "infra/ansible",
        playbook: "site.yml",
        hosts: { web: "prod-web" },
        tags: ["deploy"],
        ansible_path: playbook,
      },
      auth_method: "password",
      secret_value: VAULT_PASS,
    })
  const exec = (operation: string, input: Record<string, unknown> = {}) =>
    human.call("resources.execute", {
      ...meta(),
      connection: "despliegue",
      operation,
      input,
    }) as Promise<{
      summary: string
      plan_sha256?: string
      output?: string
      details: {
        mode: string
        hosts: Record<string, { changed: number }>
        unpreviewed_commands: number
        tags: string[]
      }
    }>
  return { dir, repo, infra, daemon, target, exec }
}

describe("ADR-0031: Ansible sobre las conexiones SSH del vault", () => {
  test("un destino que despliega a prod no puede declararse dev", async () => {
    const { target } = await boot()
    await expect(target("dev")).rejects.toThrow("prod")
  })

  test("check, despliegue atado al check, eventos en vivo y nada del vault en claro", async () => {
    const { dir, daemon, infra, target, exec } = await boot()
    await target("prod")
    const check = await exec("iac.plan")
    expect(check.details).toMatchObject({
      mode: "check",
      tags: ["deploy"],
      unpreviewed_commands: 1,
    })
    expect(check.details.hosts.web?.changed).toBe(1)
    expect(check.summary).toContain("1 comando(s) sin previsualizar")
    // Al agente no vuelve la salida entera, sólo el resumen.
    expect(check.output).toBeUndefined()

    const done = await exec("iac.apply", { plan_sha256: check.plan_sha256 })
    expect(done.details).toMatchObject({ mode: "apply" })
    expect(done.details.hosts.web?.changed).toBe(2)

    const events = daemon.repo.eventsAfter(0, null, 10_000)
    const kinds = events.map((e) => e.kind)
    expect(kinds.filter((k) => k === "iac.run.started")).toHaveLength(2)
    expect(kinds.filter((k) => k === "ansible.task.started")).toHaveLength(4)
    expect(kinds.filter((k) => k === "ansible.host.result")).toHaveLength(4)
    expect(kinds).toContain("iac.plan.created")
    expect(kinds).toContain("iac.apply.completed")

    // La salida guardada: Keel puso sus garantías y redactó lo del vault de Ansible.
    const artifacts = join(dir, "artifacts")
    const stored = readdirSync(artifacts, { recursive: true })
      .map((f) => join(artifacts, String(f)))
      .filter((f) => !f.endsWith("/"))
      .map((f) => {
        try {
          return readFileSync(f, "utf8")
        } catch {
          return ""
        }
      })
      .join("\n")
    expect(stored).toContain("hkc=True transfer=piped")
    expect(stored).toContain("estricta=1")
    const everything = `${stored}\n${JSON.stringify(events)}\n${JSON.stringify([check, done])}`
    expect(everything).not.toContain(VAULT_PASS)
    expect(everything).not.toContain(VAULT_VALUE)

    // Cambia lo que no está en git (el vault): el check ya no vale.
    writeFileSync(join(infra, "vault.yml"), "$ANSIBLE_VAULT;1.1;AES256\n6163\n")
    await expect(exec("iac.apply", { plan_sha256: check.plan_sha256 })).rejects.toThrow(
      "cambiaron desde el check",
    )
  })

  test("con cambios sin commit en el playbook no despliega", async () => {
    const { infra, target, exec } = await boot()
    await target("prod")
    writeFileSync(join(infra, "site.yml"), "- hosts: all\n  roles: [app, otra]\n")
    await expect(exec("iac.plan")).rejects.toThrow("sin commit")
  })
})
