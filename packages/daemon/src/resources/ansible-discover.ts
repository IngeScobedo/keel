/**
 * ADR-0031 §1: Keel encuentra los playbooks del proyecto para que el humano no escriba
 * rutas, hosts ni tags. Determinista y sin la contraseña de ansible-vault: lee el YAML
 * de los playbooks, de sus roles y de los inventarios; lo cifrado no se abre.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { basename, dirname, join, relative, resolve } from "node:path"

export type DiscoveredHost = {
  name: string
  /** `ansible_host` del inventario; null si sólo aparece el nombre. */
  address: string | null
  user: string | null
  port: number | null
}

export type DiscoveredPlaybook = {
  /** Relativa al proyecto, como la guarda la conexión. */
  dir: string
  playbook: string
  /** Lo que dicen los `hosts:` de sus plays (`all`, un grupo…). */
  targets: string[]
  hosts: DiscoveredHost[]
  /** Los tags del playbook y de sus roles, en el orden en que aparecen. */
  tags: string[]
  /** Archivos cifrados con ansible-vault: piden contraseña. */
  vault_files: string[]
  inventories: string[]
}

const SKIP = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  ".venv",
  "venv",
  "vendor",
  ".terraform",
  "__pycache__",
  ".next",
  ".turbo",
  "coverage",
])
const MAX_DEPTH = 6
const MAX_DIRS = 4000

type Loose = Record<string, unknown>

function readYaml(path: string): unknown {
  try {
    const text = readFileSync(path, "utf8")
    if (text.startsWith("$ANSIBLE_VAULT;")) return null
    return Bun.YAML.parse(text)
  } catch {
    return null
  }
}

/** ¿Es un playbook? Una lista de plays con `hosts` (o `import_playbook`). */
function isPlaybook(doc: unknown): doc is Loose[] {
  return (
    Array.isArray(doc) &&
    doc.length > 0 &&
    doc.every((p) => p && typeof p === "object") &&
    doc.some((p) => "hosts" in (p as Loose) || "import_playbook" in (p as Loose))
  )
}

/** Carpetas que parecen de Ansible: `ansible.cfg`, `roles/` o `inventory/`. */
function candidates(root: string): string[] {
  const out: string[] = []
  let seen = 0
  const walk = (dir: string, depth: number) => {
    if (depth > MAX_DEPTH || seen++ > MAX_DIRS) return
    let names: string[]
    try {
      names = readdirSync(dir)
    } catch {
      return
    }
    if (
      names.includes("ansible.cfg") ||
      ((names.includes("roles") || names.includes("inventory")) &&
        names.some((n) => /\.ya?ml$/.test(n)))
    )
      out.push(dir)
    for (const n of names) {
      if (SKIP.has(n) || n.startsWith(".")) continue
      const p = join(dir, n)
      try {
        if (statSync(p).isDirectory()) walk(p, depth + 1)
      } catch {
        // Un enlace roto o sin permiso no detiene la búsqueda.
      }
    }
  }
  walk(root, 0)
  return out
}

function tagList(v: unknown): string[] {
  if (typeof v === "string")
    return v
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean)
  if (Array.isArray(v)) return v.map(String)
  return []
}

/** Tags de una lista de tareas, entrando a los `block`. */
function taskTags(tasks: unknown, add: (t: string[]) => void): void {
  if (!Array.isArray(tasks)) return
  for (const t of tasks as Loose[]) {
    if (!t || typeof t !== "object") continue
    add(tagList(t.tags))
    for (const k of ["block", "rescue", "always"]) taskTags(t[k], add)
  }
}

function roleTags(dir: string, role: string, add: (t: string[]) => void): void {
  const tasks = join(dir, "roles", role, "tasks")
  if (!existsSync(tasks)) return
  for (const f of readdirSync(tasks).sort())
    if (/\.ya?ml$/.test(f)) taskTags(readYaml(join(tasks, f)), add)
}

/** Inventarios del playbook: el de `ansible.cfg` y los YAML de `inventory/`. */
function inventoryFiles(dir: string): string[] {
  const out = new Set<string>()
  const cfg = join(dir, "ansible.cfg")
  if (existsSync(cfg)) {
    const m = /^\s*inventory\s*=\s*(\S+)/m.exec(readFileSync(cfg, "utf8"))
    if (m?.[1]) {
      const p = resolve(dir, m[1])
      if (existsSync(p) && statSync(p).isFile()) out.add(p)
    }
  }
  const inv = join(dir, "inventory")
  if (existsSync(inv) && statSync(inv).isDirectory())
    for (const f of readdirSync(inv).sort()) if (/\.ya?ml$/.test(f)) out.add(join(inv, f))
  // El real antes que la plantilla: sus valores ganan.
  return [...out].sort((a, b) => Number(/example/.test(a)) - Number(/example/.test(b)))
}

function inventoryHosts(files: string[]): DiscoveredHost[] {
  const hosts = new Map<string, DiscoveredHost>()
  const visit = (group: unknown) => {
    if (!group || typeof group !== "object") return
    const g = group as Loose
    for (const [name, vars] of Object.entries((g.hosts ?? {}) as Record<string, unknown>)) {
      const v = (vars ?? {}) as Loose
      const known = hosts.get(name)
      const address = typeof v.ansible_host === "string" ? v.ansible_host : null
      // Una plantilla con «REEMPLAZA…» no es una dirección.
      const real = address && !/[A-Z_]{6,}/.test(address) ? address : null
      hosts.set(name, {
        name,
        address: known?.address ?? real,
        user: known?.user ?? (typeof v.ansible_user === "string" ? v.ansible_user : null),
        port: known?.port ?? (typeof v.ansible_port === "number" ? v.ansible_port : null),
      })
    }
    for (const child of Object.values((g.children ?? {}) as Record<string, unknown>)) visit(child)
  }
  for (const f of files) {
    const doc = readYaml(f) as Loose | null
    if (doc && typeof doc === "object") for (const top of Object.values(doc)) visit(top)
  }
  return [...hosts.values()]
}

/** Lo que Keel sabe de un playbook, para llenar el destino. */
export function describePlaybook(root: string, file: string): DiscoveredPlaybook | null {
  const doc = readYaml(file)
  if (!isPlaybook(doc)) return null
  const dir = dirname(file)
  const tags: string[] = []
  const add = (t: string[]) => {
    for (const x of t) if (x !== "always" && x !== "never" && !tags.includes(x)) tags.push(x)
  }
  const targets: string[] = []
  for (const play of doc) {
    if (typeof play.hosts === "string" && !targets.includes(play.hosts)) targets.push(play.hosts)
    add(tagList(play.tags))
    for (const k of ["pre_tasks", "tasks", "post_tasks", "handlers"]) taskTags(play[k], add)
    for (const r of (play.roles ?? []) as unknown[]) {
      const role = typeof r === "string" ? r : String((r as Loose).role ?? (r as Loose).name ?? "")
      if (typeof r === "object" && r) add(tagList((r as Loose).tags))
      if (role) roleTags(dir, role, add)
    }
  }
  const inventories = inventoryFiles(dir)
  const vault: string[] = []
  const walk = (d: string, depth: number) => {
    if (depth > 4) return
    for (const n of readdirSync(d)) {
      if (SKIP.has(n)) continue
      const p = join(d, n)
      const st = statSync(p)
      if (st.isDirectory()) walk(p, depth + 1)
      else if (st.isFile() && st.size < 2_000_000)
        try {
          if (readFileSync(p, "utf8").startsWith("$ANSIBLE_VAULT;")) vault.push(relative(dir, p))
        } catch {
          // Binario o ilegible: no es un vault.
        }
    }
  }
  walk(dir, 0)
  return {
    dir: relative(root, dir) || ".",
    playbook: basename(file),
    targets,
    hosts: inventoryHosts(inventories),
    tags,
    vault_files: vault,
    inventories: inventories.map((f) => relative(dir, f)),
  }
}

/** Todos los playbooks del proyecto, los de `site.yml` primero. */
export function discoverPlaybooks(root: string): DiscoveredPlaybook[] {
  const out: DiscoveredPlaybook[] = []
  for (const dir of candidates(root))
    for (const f of readdirSync(dir).sort()) {
      if (!/\.ya?ml$/.test(f)) continue
      const d = describePlaybook(root, join(dir, f))
      if (d) out.push(d)
    }
  return out.sort(
    (a, b) => Number(b.playbook.startsWith("site")) - Number(a.playbook.startsWith("site")),
  )
}
