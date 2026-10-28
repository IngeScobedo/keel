/**
 * Las ejecuciones de infraestructura como tarjetas en vivo (ADR-0031 §5, ADR-0011):
 * Terraform (árbol de recursos), Ansible (matriz host × tarea) y SSH (comando con su
 * salida). Puro: de los eventos del broker a un estado por `run_key`.
 */

type Loose = Record<string, unknown>

export type TfRow = {
  address: string
  action: "create" | "update" | "delete" | "replace" | "read" | "no-op"
  status: "planned" | "started" | "progress" | "complete" | "errored"
  elapsed: number | null
  message: string | null
  attrs: { key: string; before: string | null; after: string | null }[]
  sensitive_changed: number
}

export type HostRow = {
  name: string
  connection: string | null
  ok: number
  changed: number
  failed: number
  unreachable: number
  skipped: number
  /** La tarea en la que va o la última que corrió. */
  task: string | null
  last: "ok" | "changed" | "failed" | "ignored" | "skipped" | "unreachable" | null
  error: { task: string; msg: string | null } | null
}

export type SshRiskView = {
  class: "read" | "service" | "destructive"
  segment: string
  reason: string
}

/** La clase de un comando, si viene bien formada. */
export function riskOf(v: unknown): SshRiskView | null {
  const r = v as Partial<SshRiskView> | null | undefined
  if (!r || (r.class !== "read" && r.class !== "service" && r.class !== "destructive")) return null
  return { class: r.class, segment: String(r.segment ?? ""), reason: String(r.reason ?? "") }
}

export type InfraRun = {
  kind: "infra"
  key: string
  run_key: string
  tool: "terraform" | "ansible" | "ssh"
  mode: "check" | "plan" | "apply" | "run"
  connection: string
  environment: string
  /** Playbook, carpeta o comando. */
  title: string
  server: string | null
  /** ADR-0032: la clase del comando SSH y el segmento que la decidió. */
  risk: SshRiskView | null
  commit: string | null
  tags: string[]
  state: "running" | "done" | "failed"
  started_at: string
  /** El último evento: si pasa mucho sin otro, el servidor quizá no responde. */
  last_at: string
  finished_at: string | null
  summary: string | null
  plan_sha256: string | null
  output_ref: string | null
  exit_code: number | null
  duration_ms: number | null
  /** Terraform: un renglón por recurso, en el orden en que llegó. */
  resources: TfRow[]
  counts: { add: number; change: number; remove: number; replace: number } | null
  destructive: string[]
  outputs: Record<string, string>
  errors: string[]
  /** Ansible: un renglón por host, la tarea en curso y cuántas van. */
  hosts: HostRow[]
  task: string | null
  tasks: number
  unpreviewed: number
}

const num = (v: unknown) => (typeof v === "number" ? v : 0)

function host(r: InfraRun, name: string): HostRow {
  let h = r.hosts.find((x) => x.name === name)
  if (!h) {
    h = {
      name,
      connection: null,
      ok: 0,
      changed: 0,
      failed: 0,
      unreachable: 0,
      skipped: 0,
      task: null,
      last: null,
      error: null,
    }
    r.hosts.push(h)
  }
  return h
}

/** Abre la tarjeta con el evento de inicio de Terraform, Ansible o SSH. */
export function startInfra(kind: string, p: Loose, key: string, at: string): InfraRun | null {
  if (kind !== "iac.run.started" && kind !== "ssh.command.started") return null
  const ssh = kind === "ssh.command.started"
  const tool = ssh ? "ssh" : (String(p.tool) as InfraRun["tool"])
  const r: InfraRun = {
    kind: "infra",
    key: `infra:${key}`,
    run_key: String(p.run_key),
    tool,
    mode: ssh ? "run" : (String(p.mode) as InfraRun["mode"]),
    connection: String(p.connection ?? ""),
    environment: String(p.environment ?? ""),
    title: ssh ? String(p.command ?? "") : String(p.playbook ?? p.connection ?? ""),
    server: ssh ? String(p.server ?? "") : null,
    risk: ssh ? riskOf(p.risk) : null,
    commit: typeof p.commit === "string" ? p.commit : null,
    tags: Array.isArray(p.tags) ? p.tags.map(String) : [],
    state: "running",
    started_at: at,
    last_at: at,
    finished_at: null,
    summary: null,
    plan_sha256: null,
    output_ref: null,
    exit_code: null,
    duration_ms: null,
    resources: [],
    counts: null,
    destructive: [],
    outputs: {},
    errors: [],
    hosts: [],
    task: null,
    tasks: 0,
    unpreviewed: 0,
  }
  if (Array.isArray(p.hosts))
    for (const x of p.hosts as Loose[]) host(r, String(x.name)).connection = String(x.connection)
  return r
}

/** Aplica un evento a la tarjeta de su `run_key`. Devuelve si lo reconoció. */
export function stepInfra(r: InfraRun, kind: string, p: Loose, at: string): boolean {
  r.last_at = at
  switch (kind) {
    case "ansible.task.started":
      r.task = String(p.task)
      r.tasks = num(p.index) || r.tasks + 1
      return true
    case "ansible.host.result": {
      const h = host(r, String(p.host))
      const status = String(p.status) as NonNullable<HostRow["last"]>
      h.task = String(p.task)
      h.last = status
      if (status === "ok" || status === "ignored") h.ok++
      if (status === "changed") {
        h.ok++
        h.changed++
      }
      if (status === "skipped") h.skipped++
      if (status === "failed") h.failed++
      if (status === "unreachable") h.unreachable++
      if (status === "failed" || status === "unreachable")
        h.error = { task: String(p.task), msg: typeof p.msg === "string" ? p.msg : null }
      return true
    }
    case "terraform.resource.progress": {
      const address = String(p.address)
      let row = r.resources.find((x) => x.address === address)
      if (!row) {
        row = {
          address,
          action: String(p.action) as TfRow["action"],
          status: "planned",
          elapsed: null,
          message: null,
          attrs: [],
          sensitive_changed: 0,
        }
        r.resources.push(row)
      }
      row.status = String(p.status) as TfRow["status"]
      if (p.action && p.action !== "no-op") row.action = String(p.action) as TfRow["action"]
      row.elapsed = typeof p.elapsed === "number" ? p.elapsed : row.elapsed
      row.message = typeof p.message === "string" ? p.message : row.message
      return true
    }
    case "iac.plan.created":
    case "iac.apply.completed":
      finish(r, p, at)
      return true
    case "ssh.command.completed":
      r.exit_code = typeof p.exit_code === "number" ? p.exit_code : null
      r.output_ref = typeof p.output_ref === "string" ? p.output_ref : null
      r.duration_ms = typeof p.duration_ms === "number" ? p.duration_ms : null
      r.state = r.exit_code === 0 ? "done" : "failed"
      r.summary = `exit ${r.exit_code ?? "?"}`
      r.finished_at = at
      return true
    default:
      return false
  }
}

function finish(r: InfraRun, p: Loose, at: string): void {
  const d = (p.details ?? {}) as Loose
  r.finished_at = at
  r.summary = typeof p.summary === "string" ? p.summary : r.summary
  r.plan_sha256 = typeof p.plan_sha256 === "string" ? p.plan_sha256 : null
  r.output_ref =
    typeof p.plan_ref === "string"
      ? p.plan_ref
      : typeof p.output_ref === "string"
        ? p.output_ref
        : null
  r.exit_code = typeof p.exit_code === "number" ? p.exit_code : null
  r.duration_ms = typeof d.duration_ms === "number" ? d.duration_ms : null
  if (r.tool === "terraform") {
    const c = d.counts as InfraRun["counts"] | undefined
    if (c) r.counts = c
    r.destructive = Array.isArray(d.destructive) ? d.destructive.map(String) : r.destructive
    r.outputs = (d.outputs as Record<string, string> | undefined) ?? r.outputs
    r.errors = Array.isArray(d.errors) ? d.errors.map(String) : r.errors
    // El plan trae el detalle de atributos; el stream sólo trajo la acción.
    for (const x of (d.resources ?? []) as Loose[]) {
      const address = String(x.address)
      let row = r.resources.find((y) => y.address === address)
      if (!row) {
        row = {
          address,
          action: String(x.action) as TfRow["action"],
          status: "planned",
          elapsed: null,
          message: null,
          attrs: [],
          sensitive_changed: 0,
        }
        r.resources.push(row)
      }
      row.action = String(x.action) as TfRow["action"]
      row.attrs = (x.attrs ?? []) as TfRow["attrs"]
      row.sensitive_changed = num(x.sensitive_changed)
    }
  }
  if (r.tool === "ansible") {
    r.unpreviewed = num(d.unpreviewed_commands)
    for (const [name, s] of Object.entries((d.hosts ?? {}) as Record<string, Loose>)) {
      const h = host(r, name)
      // El recap manda: es lo que contó Ansible.
      h.ok = num(s.ok)
      h.changed = num(s.changed)
      h.failed = num(s.failed)
      h.unreachable = num(s.unreachable)
    }
    r.task = null
  }
  const failed =
    d.interrupted === true ||
    (r.exit_code !== null && r.exit_code !== 0) ||
    r.errors.length > 0 ||
    r.hosts.some((h) => h.failed > 0 || h.unreachable > 0) ||
    r.resources.some((x) => x.status === "errored")
  r.state = failed ? "failed" : "done"
}

/** El nombre de la tool del agente que abre cada tipo de tarjeta. */
export function ownerTool(r: InfraRun): string[] {
  if (r.tool === "ssh") return ["mcp__keel__ssh_run"]
  return r.mode === "apply" ? ["mcp__keel__iac_apply"] : ["mcp__keel__iac_plan"]
}

/** Lo que dice la cabecera, como contadores de GitHub pero de infraestructura. */
export function headCounts(r: InfraRun): { label: string; tone: "add" | "change" | "remove" }[] {
  if (r.tool === "terraform") {
    const c = r.counts ?? {
      add: r.resources.filter((x) => x.action === "create").length,
      change: r.resources.filter((x) => x.action === "update").length,
      remove: r.resources.filter((x) => x.action === "delete").length,
      replace: r.resources.filter((x) => x.action === "replace").length,
    }
    return [
      { label: `+${c.add}`, tone: "add" as const },
      { label: `~${c.change}`, tone: "change" as const },
      ...(c.replace ? [{ label: `±${c.replace}`, tone: "remove" as const }] : []),
      { label: `-${c.remove}`, tone: "remove" as const },
    ]
  }
  if (r.tool === "ansible") {
    const changed = r.hosts.reduce((n, h) => n + h.changed, 0)
    const failed = r.hosts.reduce((n, h) => n + h.failed + h.unreachable, 0)
    return [
      { label: `${r.hosts.length} host${r.hosts.length === 1 ? "" : "s"}`, tone: "change" },
      { label: `${changed} cambio${changed === 1 ? "" : "s"}`, tone: "add" },
      ...(failed
        ? [{ label: `${failed} fallo${failed === 1 ? "" : "s"}`, tone: "remove" as const }]
        : []),
    ]
  }
  return []
}
