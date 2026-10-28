/**
 * ADR-0031 §5: Terraform, Ansible y SSH como tarjetas en vivo. Las secuencias son las que
 * emite el broker (ansible.test.ts y resources.test.ts del daemon).
 */
import { describe, expect, test } from "bun:test"
import { type Approval, buildChat, type ToolCall } from "../src/chat-model.js"
import { headCounts, type InfraRun } from "../src/infra-model.js"

let seq = 0
const at = (kind: string, payload: unknown) => ({
  event_seq: ++seq,
  kind,
  payload,
  project_id: "p",
  run_id: "r",
  received_at: "2026-10-28T00:00:00Z",
})
const tool = (name: string, id: string) =>
  at("hook.PreToolUse", { tool_name: name, tool_use_id: id, tool_input: {} })

describe("tarjetas de infraestructura", () => {
  test("Ansible: matriz host × tarea en vivo, colgada de iac_plan, y el recap manda al final", () => {
    const events = [
      tool("mcp__keel__iac_plan", "t1"),
      at("iac.run.started", {
        tool: "ansible",
        run_key: "k1",
        connection: "casamatte",
        environment: "prod",
        mode: "check",
        playbook: "site.yml",
        tags: ["deploy"],
        hosts: [{ name: "web", connection: "prod-casamatte", host: "203.0.113.20" }],
        commit: "abc1234def",
      }),
      at("ansible.task.started", { run_key: "k1", index: 1, task: "Instala", action: "apt" }),
      at("ansible.host.result", {
        run_key: "k1",
        host: "web",
        task: "Instala",
        status: "changed",
        changed: true,
        msg: null,
      }),
    ]
    const live = buildChat(events)[0] as ToolCall
    expect(live.infra).toMatchObject({ state: "running", task: "Instala", tasks: 1 })
    expect(live.infra?.hosts[0]).toMatchObject({ name: "web", changed: 1, last: "changed" })

    const done = buildChat([
      ...events,
      at("ansible.host.result", {
        run_key: "k1",
        host: "web",
        task: "Construye",
        status: "skipped",
        changed: false,
        msg: null,
      }),
      at("iac.plan.created", {
        run_key: "k1",
        tool: "ansible",
        plan_sha256: "f".repeat(64),
        summary: "check: 1 cambio(s) en 1 host(s) · 1 comando(s) sin previsualizar",
        details: {
          unpreviewed_commands: 1,
          hosts: { web: { ok: 1, changed: 1, failed: 0, unreachable: 0 } },
          duration_ms: 4200,
        },
      }),
    ])
    const card = (done[0] as ToolCall).infra as InfraRun
    expect(card).toMatchObject({ state: "done", unpreviewed: 1, plan_sha256: "f".repeat(64) })
    expect(headCounts(card).map((c) => c.label)).toEqual(["1 host", "1 cambio"])
    // La tool de Keel no aparece aparte: es la tarjeta.
    expect(done).toHaveLength(1)
  })

  test("Ansible: un host que falla marca la tarjeta y guarda la tarea y el mensaje", () => {
    const [card] = buildChat([
      at("iac.run.started", {
        tool: "ansible",
        run_key: "k2",
        connection: "flota",
        environment: "prod",
        mode: "apply",
        hosts: [
          { name: "web-01", connection: "a", host: "h1" },
          { name: "gpu", connection: "b", host: "h2" },
        ],
      }),
      at("ansible.host.result", {
        run_key: "k2",
        host: "gpu",
        task: "Instala CUDA",
        status: "failed",
        changed: false,
        msg: "E: Unable to locate package nvidia-driver-550",
      }),
      at("iac.apply.completed", { run_key: "k2", tool: "ansible", exit_code: 2, details: {} }),
    ]) as InfraRun[]
    expect(card?.state).toBe("failed")
    expect(card?.hosts.find((h) => h.name === "gpu")?.error).toEqual({
      task: "Instala CUDA",
      msg: "E: Unable to locate package nvidia-driver-550",
    })
  })

  test("Terraform: el árbol con lo destructivo, y el apply anima cada recurso", () => {
    const plan = buildChat([
      tool("mcp__keel__iac_plan", "t1"),
      at("iac.run.started", {
        tool: "terraform",
        run_key: "p1",
        connection: "core",
        environment: "prod",
        mode: "plan",
      }),
      at("terraform.resource.progress", {
        run_key: "p1",
        address: "aws_instance.worker",
        action: "update",
        status: "planned",
        elapsed: null,
        message: null,
      }),
      at("iac.plan.created", {
        run_key: "p1",
        tool: "terraform",
        plan_sha256: "a".repeat(64),
        summary: "Plan: ~1 cambiar, -1 destruir",
        details: {
          counts: { add: 0, change: 1, remove: 1, replace: 0 },
          destructive: ["digitalocean_droplet.legacy"],
          resources: [
            {
              address: "aws_instance.worker",
              action: "update",
              attrs: [{ key: "instance_type", before: "t3.medium", after: "t3.large" }],
              sensitive_changed: 1,
            },
            { address: "digitalocean_droplet.legacy", action: "delete", attrs: [] },
          ],
        },
      }),
      tool("mcp__keel__iac_apply", "t2"),
      at("approval.requested", {
        approval_id: "ap1",
        operation_hash: "h",
        tool: "resource.iac.apply",
        input: { connection: "core", environment: "prod", plan_sha256: "a".repeat(64) },
      }),
    ])
    const card = (plan[0] as ToolCall).infra as InfraRun
    expect(card.destructive).toEqual(["digitalocean_droplet.legacy"])
    expect(card.resources[0]).toMatchObject({
      attrs: [{ key: "instance_type", before: "t3.medium", after: "t3.large" }],
      sensitive_changed: 1,
    })
    expect(headCounts(card).map((c) => c.label)).toEqual(["+0", "~1", "-1"])
    // Aprobar el apply muestra el plan que se aprueba.
    const approval = plan.find((i) => i.kind === "approval") as Approval
    expect(approval.plan?.run_key).toBe("p1")

    const applied = buildChat([
      at("iac.run.started", {
        tool: "terraform",
        run_key: "a1",
        connection: "core",
        environment: "prod",
        mode: "apply",
      }),
      at("terraform.resource.progress", {
        run_key: "a1",
        address: "aws_instance.worker",
        action: "update",
        status: "started",
        elapsed: null,
        message: null,
      }),
    ])[0] as InfraRun
    expect(applied.resources[0]?.status).toBe("started")
  })

  test("SSH: la tarjeta abre con el comando y cierra con exit y duración", () => {
    const [card] = buildChat([
      tool("mcp__keel__ssh_run", "s1"),
      at("ssh.command.started", {
        run_key: "s",
        connection: "prod-casamatte",
        environment: "prod",
        server: "root@203.0.113.20",
        command: "docker ps",
        risk: { class: "read", segment: "docker ps", reason: "sólo lectura" },
      }),
      at("ssh.command.completed", {
        run_key: "s",
        server: "root@203.0.113.20",
        command: "docker ps",
        exit_code: 0,
        output_ref: "artifact:sha256:x",
        duration_ms: 812,
      }),
    ]) as ToolCall[]
    expect(card?.infra).toMatchObject({
      tool: "ssh",
      title: "docker ps",
      state: "done",
      exit_code: 0,
      duration_ms: 812,
      output_ref: "artifact:sha256:x",
      // ADR-0032: la clase viaja con el inicio y se queda en la tarjeta.
      risk: { class: "read", segment: "docker ps" },
    })
  })
})
