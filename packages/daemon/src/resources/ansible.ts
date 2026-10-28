/**
 * Ansible por el broker (ADR-0031): un playbook del proyecto contra conexiones SSH del
 * vault. Keel arma el inventario, entra por el `ssh` de cada conexión (envoltorio con las
 * opciones de Keel primero: en `ssh` gana la primera) y lee cada tarea en vivo con su
 * callback `keel_events`. Lo medido está en `spikes/ansible`.
 *
 * - `iac.plan` corre `--check --diff`; su hash ata la aprobación de `iac.apply` al commit,
 *   a los archivos de `dir` (también los que no están en git) y a lo elegido.
 * - La salida y los eventos se redactan con los valores del vault de Ansible.
 */
import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { join, relative, resolve } from "node:path"

export type AnsibleSpec = {
  dir: string
  playbook: string
  /** Host del playbook → nombre de la conexión SSH del vault. */
  hosts: Record<string, string>
  tags: string[]
  limit: string | null
  extra_vars: Record<string, string | number | boolean>
  ansible_path: string
}

export type AnsibleHost = {
  name: string
  connection: string
  host: string
  user: string | null
  port: number
  /** Ejecutable `ssh` de Keel para este host (opciones y askpass de su conexión). */
  ssh: string
  fingerprint: string | null
}

/** Un evento del callback, tal como lo escribe `keel_events`. */
export type AnsibleEvent =
  | { kind: "play"; name: string }
  | { kind: "task"; name: string; action: string }
  | {
      kind: "result"
      status: "ok" | "changed" | "failed" | "ignored" | "skipped" | "unreachable"
      host: string
      task: string
      changed: boolean
      msg: string | null
    }
  | { kind: "recap"; hosts: Record<string, Record<string, number>> }

export type AnsibleOutcome = {
  mode: "check" | "apply"
  exit_code: number | null
  output: string
  events: AnsibleEvent[]
  duration_ms: number
}

/** Lo que el agente recibe: corto, sin la salida entera (ADR-0031 §5). */
export type AnsibleDetails = {
  tool: "ansible"
  mode: "check" | "apply"
  playbook: string
  commit: string | null
  tags: string[]
  hosts: Record<string, { ok: number; changed: number; failed: number; unreachable: number }>
  changed: { host: string; task: string }[]
  failed: { host: string; task: string; msg: string | null }[]
  /** Tareas de comando que `--check` no corre: sólo se verán al desplegar. */
  unpreviewed_commands: number
  tasks: number
  duration_ms: number
}

const COMMAND_ACTIONS = new Set([
  "command",
  "shell",
  "raw",
  "script",
  "ansible.builtin.command",
  "ansible.builtin.shell",
  "ansible.builtin.raw",
  "ansible.builtin.script",
])

export class AnsibleError extends Error {}

export function ansibleSpec(config: Record<string, unknown>): AnsibleSpec {
  const dir = String(config.dir ?? "")
  const playbook = String(config.playbook ?? "")
  const hosts = (config.hosts ?? {}) as Record<string, unknown>
  if (!dir)
    throw new AnsibleError("la conexión ansible necesita config.dir (la carpeta del playbook)")
  if (!playbook) throw new AnsibleError("la conexión ansible necesita config.playbook")
  if (typeof hosts !== "object" || Object.keys(hosts).length === 0)
    throw new AnsibleError(
      "la conexión ansible necesita config.hosts: cada host del playbook con su conexión SSH",
    )
  const tags = Array.isArray(config.tags) ? config.tags.map(String) : []
  return {
    dir,
    playbook,
    hosts: Object.fromEntries(Object.entries(hosts).map(([k, v]) => [k, String(v)])),
    tags,
    limit: config.limit ? String(config.limit) : null,
    extra_vars: (config.extra_vars ?? {}) as AnsibleSpec["extra_vars"],
    ansible_path: String(config.ansible_path ?? "ansible-playbook"),
  }
}

/** La carpeta del playbook, siempre dentro del checkout del proyecto. */
export function playbookDir(root: string, spec: AnsibleSpec): string {
  const dir = resolve(root, spec.dir)
  const rel = relative(root, dir)
  if (rel.startsWith("..")) throw new AnsibleError("config.dir sale del proyecto")
  if (!existsSync(join(dir, spec.playbook)))
    throw new AnsibleError(`no existe ${join(spec.dir, spec.playbook)} en el proyecto`)
  return dir
}

const SKIP = new Set([".git", "__pycache__", "node_modules", ".retry"])

/** Todos los archivos de `dir`, también los que no están en git (`vault.yml`, inventario). */
function walk(dir: string, out: string[] = [], base = dir): string[] {
  for (const name of readdirSync(dir).sort()) {
    if (SKIP.has(name) || name.endsWith(".retry")) continue
    const p = join(dir, name)
    const st = statSync(p)
    if (st.isDirectory()) walk(p, out, base)
    else if (st.isFile()) out.push(relative(base, p))
  }
  return out
}

/**
 * El hash del despliegue: commit, archivos de `dir`, hosts con su huella y lo elegido.
 * Si cambia algo entre el check y la aprobación, el hash no coincide y se vuelve a planear.
 */
export function deployDigest(
  dir: string,
  commit: string | null,
  spec: AnsibleSpec,
  hosts: AnsibleHost[],
  choice: { tags: string[]; limit: string | null },
): string {
  const h = createHash("sha256")
  h.update(JSON.stringify({ commit, playbook: spec.playbook, extra: spec.extra_vars, choice }))
  for (const x of hosts)
    h.update(JSON.stringify([x.name, x.connection, x.host, x.user, x.port, x.fingerprint]))
  for (const f of walk(dir)) {
    h.update(f)
    h.update(readFileSync(join(dir, f)))
  }
  return h.digest("hex")
}

/** Archivos cifrados con `ansible-vault` en `dir`: lo que se descifra para redactar. */
export function vaultFiles(dir: string): string[] {
  return walk(dir).filter((f) => {
    try {
      return readFileSync(join(dir, f), "utf8").startsWith("$ANSIBLE_VAULT;")
    } catch {
      return false
    }
  })
}

/** Cada valor de texto de un YAML descifrado: los patrones literales de redacción. */
export function secretLeaves(yaml: string): string[] {
  const out: string[] = []
  const visit = (v: unknown) => {
    if (typeof v === "string") {
      if (v.length >= 4) out.push(v)
    } else if (typeof v === "number" && String(v).length >= 6) out.push(String(v))
    else if (Array.isArray(v)) v.forEach(visit)
    else if (v && typeof v === "object") Object.values(v).forEach(visit)
  }
  try {
    visit(Bun.YAML.parse(yaml))
  } catch {
    // Un vault que no es YAML se redacta entero, línea por línea.
    for (const l of yaml.split("\n")) if (l.trim().length >= 4) out.push(l.trim())
  }
  return out
}

/** El inventario de Keel: cada host con su conexión y su `ssh`; nunca una llave. */
export function inventory(hosts: AnsibleHost[]): string {
  const lines = ["all:", "  hosts:"]
  for (const h of hosts) {
    lines.push(`    ${JSON.stringify(h.name)}:`)
    lines.push(`      ansible_host: ${JSON.stringify(h.host)}`)
    if (h.user) lines.push(`      ansible_user: ${JSON.stringify(h.user)}`)
    lines.push(`      ansible_port: ${h.port}`)
    lines.push(`      ansible_ssh_executable: ${JSON.stringify(h.ssh)}`)
  }
  return `${lines.join("\n")}\n`
}

/** `sh` sin sorpresas: cada argumento entre comillas simples. */
export function shQuote(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`
}

/** El envoltorio de `ssh` de un host: el entorno de su conexión y sus opciones primero. */
export function sshWrapper(
  path: string,
  sshBin: string,
  args: string[],
  env: Record<string, string>,
): void {
  const exports = Object.entries(env)
    .filter(([k]) => !["PATH", "HOME", "LANG"].includes(k))
    .map(([k, v]) => `export ${k}=${shQuote(v)}`)
  // `-T` y el tope de conexión los decide Ansible; el resto (huella, llave, askpass) es de Keel.
  const keep: string[] = []
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string
    if (a === "-T") continue
    if (a === "-o" && /^ConnectTimeout=/.test(args[i + 1] ?? "")) {
      i++
      continue
    }
    keep.push(a)
  }
  writeFileSync(
    path,
    `#!/bin/sh\n${exports.join("\n")}\nexec ${shQuote(sshBin)} ${keep.map(shQuote).join(" ")} "$@"\n`,
    { mode: 0o700 },
  )
  chmodSync(path, 0o700)
}

/** El callback de Keel (de `spikes/ansible`): NDJSON por tarea y host, sin `result` entero. */
export const KEEL_EVENTS_CALLBACK = `# Callback de Keel para Ansible (ADR-0031). Un JSON por línea al archivo de
# KEEL_ANSIBLE_EVENTS; nunca el resultado entero (puede traer secretos).
import json
import os

from ansible.plugins.callback import CallbackBase

DOCUMENTATION = """
name: keel_events
type: aggregate
short_description: eventos de Ansible para Keel, NDJSON
"""


class CallbackModule(CallbackBase):
    CALLBACK_VERSION = 2.0
    CALLBACK_TYPE = "aggregate"
    CALLBACK_NAME = "keel_events"
    CALLBACK_NEEDS_ENABLED = True

    def __init__(self):
        super().__init__()
        self._out = open(os.environ["KEEL_ANSIBLE_EVENTS"], "a", buffering=1)

    def _emit(self, kind, **kw):
        kw["kind"] = kind
        self._out.write(json.dumps(kw, ensure_ascii=False) + "\\n")

    def v2_playbook_on_play_start(self, play):
        self._emit("play", name=play.get_name())

    def v2_playbook_on_task_start(self, task, is_conditional):
        self._emit("task", name=task.get_name(), action=task.action)

    def _result(self, status, result):
        msg = result._result.get("msg") if status in ("failed", "unreachable") else None
        self._emit(
            "result",
            status=status,
            host=result._host.get_name(),
            task=result._task.get_name(),
            changed=bool(result._result.get("changed")),
            msg=str(msg)[:500] if msg else None,
        )

    def v2_runner_on_ok(self, result):
        self._result("changed" if result._result.get("changed") else "ok", result)

    def v2_runner_on_failed(self, result, ignore_errors=False):
        self._result("ignored" if ignore_errors else "failed", result)

    def v2_runner_on_skipped(self, result):
        self._result("skipped", result)

    def v2_runner_on_unreachable(self, result):
        self._result("unreachable", result)

    def v2_playbook_on_stats(self, stats):
        hosts = {h: stats.summarize(h) for h in sorted(stats.processed.keys())}
        self._emit("recap", hosts=hosts)
`

/** Prepara la carpeta privada de una ejecución: callback, inventario y control de ssh. */
export function prepareRunDir(runDir: string, hosts: AnsibleHost[]): void {
  mkdirSync(join(runDir, "callback"), { recursive: true, mode: 0o700 })
  mkdirSync(join(runDir, "cp"), { recursive: true, mode: 0o700 })
  writeFileSync(join(runDir, "callback", "keel_events.py"), KEEL_EVENTS_CALLBACK, { mode: 0o600 })
  writeFileSync(join(runDir, "inventory.yml"), inventory(hosts), { mode: 0o600 })
}

/** El entorno de `ansible-playbook`: lo de Keel por encima del `ansible.cfg` del proyecto. */
export function ansibleEnv(runDir: string, base: Record<string, string>): Record<string, string> {
  return {
    ...base,
    // La huella se valida siempre, aunque el proyecto la apague (también en el envoltorio).
    ANSIBLE_HOST_KEY_CHECKING: "True",
    // Sockets de control propios: con los de ~/.ansible/cp, un intento reusa la conexión
    // de otro y no vuelve a verificar la huella (medido, spikes/ansible).
    ANSIBLE_SSH_CONTROL_PATH_DIR: join(runDir, "cp"),
    // Copiar módulos por el mismo `ssh`, no por un `sftp` que leería la config del humano.
    ANSIBLE_SSH_TRANSFER_METHOD: "piped",
    ANSIBLE_CALLBACK_PLUGINS: join(runDir, "callback"),
    ANSIBLE_CALLBACKS_ENABLED: "keel_events",
    KEEL_ANSIBLE_EVENTS: join(runDir, "events.ndjson"),
    ANSIBLE_NOCOLOR: "1",
    ANSIBLE_FORCE_COLOR: "0",
    ANSIBLE_RETRY_FILES_ENABLED: "False",
    PYTHONUNBUFFERED: "1",
  }
}

/** Los argumentos de `ansible-playbook` para el check o el despliegue. */
export function playbookArgs(
  runDir: string,
  spec: AnsibleSpec,
  mode: "check" | "apply",
  choice: { tags: string[]; limit: string | null },
  vaultPass: string | null,
): string[] {
  const args = [spec.playbook, "-i", join(runDir, "inventory.yml")]
  if (choice.tags.length) args.push("--tags", choice.tags.join(","))
  if (choice.limit) args.push("--limit", choice.limit)
  if (Object.keys(spec.extra_vars).length) args.push("-e", JSON.stringify(spec.extra_vars))
  if (vaultPass) args.push("--vault-password-file", vaultPass)
  if (mode === "check") args.push("--check", "--diff")
  return args
}

/**
 * Corre el playbook sin bloquear el daemon y entrega cada evento según llega: el
 * callback escribe en un archivo y Keel lo lee mientras crece.
 */
export async function runPlaybook(
  o: {
    bin: string
    args: string[]
    cwd: string
    env: Record<string, string>
    eventsFile: string
    mode: "check" | "apply"
    timeoutMs: number
  },
  onEvent: (e: AnsibleEvent) => void,
  signal?: AbortSignal,
): Promise<AnsibleOutcome> {
  const started = performance.now()
  const events: AnsibleEvent[] = []
  let offset = 0
  let rest = ""
  const drain = () => {
    if (!existsSync(o.eventsFile)) return
    const buf = readFileSync(o.eventsFile)
    if (buf.length <= offset) return
    const chunk = buf.subarray(offset).toString("utf8")
    offset = buf.length
    const lines = (rest + chunk).split("\n")
    rest = lines.pop() ?? ""
    for (const l of lines) {
      if (!l.trim()) continue
      try {
        const e = JSON.parse(l) as AnsibleEvent
        events.push(e)
        onEvent(e)
      } catch {
        // Una línea a medias o rota no tumba el despliegue.
      }
    }
  }
  const { code, out } = await new Promise<{ code: number | null; out: string }>((done, fail) => {
    // Su propio grupo de procesos: al cancelar se mata también el `ssh` que lanzó, que si
    // no se queda colgado con la salida abierta (VPS que no abría sesiones, 2026-10-28).
    const child = spawn(o.bin, o.args, {
      cwd: o.cwd,
      env: o.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    })
    const killAll = () => {
      try {
        if (child.pid && process.platform !== "win32") process.kill(-child.pid, "SIGTERM")
        else child.kill("SIGTERM")
      } catch {
        // El grupo ya no existe: no queda nada que matar.
      }
    }
    let buf = ""
    const take = (d: Buffer) => {
      if (buf.length < 8_000_000) buf += d.toString("utf8")
    }
    child.stdout.on("data", take)
    child.stderr.on("data", take)
    const poll = setInterval(drain, 250)
    const timer = setTimeout(killAll, o.timeoutMs)
    const abort = killAll
    signal?.addEventListener("abort", abort)
    child.on("error", (e) => {
      clearInterval(poll)
      clearTimeout(timer)
      fail(new AnsibleError(`ansible-playbook no disponible: ${e.message}`))
    })
    // `exit`, no `close`: un nieto vivo puede tener la salida abierta mucho tiempo.
    child.on("exit", (c) => {
      clearInterval(poll)
      clearTimeout(timer)
      signal?.removeEventListener("abort", abort)
      killAll()
      done({ code: c, out: buf })
    })
  })
  drain()
  return {
    mode: o.mode,
    exit_code: code,
    output: out,
    events,
    duration_ms: Math.round(performance.now() - started),
  }
}

/** El resumen para el agente y la tarjeta, a partir de los eventos. */
export function summarize(
  r: AnsibleOutcome,
  spec: AnsibleSpec,
  commit: string | null,
  tags: string[],
): { summary: string; details: AnsibleDetails } {
  const actionOf = new Map<string, string>()
  let tasks = 0
  for (const e of r.events)
    if (e.kind === "task") {
      actionOf.set(e.name, e.action)
      tasks++
    }
  const results = r.events.filter((e): e is Extract<AnsibleEvent, { kind: "result" }> => {
    return e.kind === "result"
  })
  const recap = r.events.find((e): e is Extract<AnsibleEvent, { kind: "recap" }> => {
    return e.kind === "recap"
  })
  const hosts: AnsibleDetails["hosts"] = {}
  for (const [h, s] of Object.entries(recap?.hosts ?? {}))
    hosts[h] = {
      ok: s.ok ?? 0,
      changed: s.changed ?? 0,
      failed: s.failures ?? 0,
      unreachable: s.unreachable ?? 0,
    }
  const changed = results
    .filter((x) => x.status === "changed")
    .map((x) => ({ host: x.host, task: x.task }))
  const failed = results
    .filter((x) => x.status === "failed" || x.status === "unreachable")
    .map((x) => ({ host: x.host, task: x.task, msg: x.msg }))
  const unpreviewed =
    r.mode === "check"
      ? results.filter(
          (x) => x.status === "skipped" && COMMAND_ACTIONS.has(actionOf.get(x.task) ?? ""),
        ).length
      : 0
  const n = Object.keys(hosts).length
  const summary =
    failed.length > 0
      ? `${r.mode === "check" ? "check" : "despliegue"} con ${failed.length} fallo(s) en ${n} host(s)`
      : r.mode === "check"
        ? `check: ${changed.length} cambio(s) en ${n} host(s)${unpreviewed ? ` · ${unpreviewed} comando(s) sin previsualizar` : ""}`
        : `desplegado: ${changed.length} cambio(s) en ${n} host(s)`
  return {
    summary,
    details: {
      tool: "ansible",
      mode: r.mode,
      playbook: spec.playbook,
      commit,
      tags,
      hosts,
      changed: changed.slice(0, 40),
      failed: failed.slice(0, 20),
      unpreviewed_commands: unpreviewed,
      tasks,
      duration_ms: r.duration_ms,
    },
  }
}
