/**
 * Keel encuentra las carpetas de Terraform del proyecto para que el humano no escriba
 * rutas (como ADR-0031 §1 con los playbooks). Determinista: lee los `.tf` sin ejecutar
 * nada; proveedores, backend y variables salen del texto, no de `terraform init`.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"
import { MAX_DEPTH, MAX_DIRS, SKIP } from "./ansible-discover.js"

type Env = "prod" | "staging" | "dev"
const ENV_RANK: Record<Env, number> = { dev: 0, staging: 1, prod: 2 }

export type DiscoveredVariable = { name: string; sensitive: boolean; has_default: boolean }

export type DiscoveredTerraform = {
  /** Relativa al proyecto, como la guarda la conexión. */
  dir: string
  files: number
  providers: string[]
  /** `s3`, `gcs`, `local`, `cloud`…; null si el estado queda local sin declararlo. */
  backend: string | null
  variables: DiscoveredVariable[]
  /** Un archivo de variables por entorno (`stage.tfvars`, `production.tfvars`…). */
  tfvars: { file: string; environment: Env | null }[]
  /** Workspaces con estado local (`terraform.tfstate.d/`); los remotos no se ven sin init. */
  workspaces: string[]
  /** Ya corrió `terraform init` (hay `.terraform/`). */
  initialized: boolean
  /** No se aplica sola: un módulo que otros llaman, o configuración compartida sin recursos. */
  module: boolean
  /** Bloques `resource`, `module` y `data`: cero en un `versions.tf` compartido. */
  resources: number
  /** Lo que dice la ruta: `prod`, `staging` o `dev`. */
  suggested_environment: Env | null
  /** La carpeta, o `padre-carpeta` si se llama `terraform`, `infra`… */
  suggested_name: string
}

/** Quita comentarios de HCL (`#`, `//` y de bloque) sin tocar lo que va entre comillas. */
function stripComments(src: string): string {
  return src.replace(/"(?:\\.|[^"\\])*"|\/\*[\s\S]*?\*\/|(?:#|\/\/)[^\n]*/g, (m) =>
    m.startsWith('"') ? m : "",
  )
}

/** El cuerpo entre llaves que abre en `from` (la posición de `{`). */
function blockBody(src: string, from: number): string {
  let depth = 0
  for (let i = from; i < src.length; i++) {
    if (src[i] === "{") depth++
    else if (src[i] === "}" && --depth === 0) return src.slice(from + 1, i)
  }
  return src.slice(from + 1)
}

function environmentOf(parts: string[]): Env | null {
  const words = parts.join("/").toLowerCase()
  if (/(^|[^a-z])(prod|production|prd)([^a-z]|$)/.test(words)) return "prod"
  if (/(^|[^a-z])(staging|stage|stg)([^a-z]|$)/.test(words)) return "staging"
  if (/(^|[^a-z])(dev|development|sandbox)([^a-z]|$)/.test(words)) return "dev"
  return null
}

/** Una carpeta con `.tf`, o null si no tiene. */
export function describeTerraform(root: string, dir: string): DiscoveredTerraform | null {
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return null
  }
  const tf = names.filter((n) => n.endsWith(".tf")).sort()
  if (!tf.length) return null
  const providers = new Set<string>()
  const variables: DiscoveredVariable[] = []
  let backend: string | null = null
  let declaresRoot = false
  let resources = 0
  for (const f of tf) {
    let src: string
    try {
      src = stripComments(readFileSync(join(dir, f), "utf8"))
    } catch {
      continue
    }
    for (const m of src.matchAll(/(^|\n)\s*provider\s+"([^"]+)"\s*\{/g)) {
      providers.add(m[2] as string)
      declaresRoot = true
    }
    for (const m of src.matchAll(/required_providers\s*\{/g))
      for (const p of blockBody(src, (m.index ?? 0) + m[0].length - 1).matchAll(
        /(^|\n)\s*([A-Za-z0-9_-]+)\s*=\s*\{/g,
      ))
        providers.add(p[2] as string)
    const b = /\bbackend\s+"([^"]+)"\s*\{/.exec(src) ?? (/\bcloud\s*\{/.exec(src) && ["", "cloud"])
    if (b) {
      backend = b[1] as string
      declaresRoot = true
    }
    resources += [...src.matchAll(/(^|\n)\s*(resource|data)\s+"[^"]+"\s+"[^"]+"\s*\{/g)].length
    resources += [...src.matchAll(/(^|\n)\s*module\s+"[^"]+"\s*\{/g)].length
    for (const m of src.matchAll(/(^|\n)\s*variable\s+"([^"]+)"\s*\{/g)) {
      const body = blockBody(src, (m.index ?? 0) + m[0].length - 1)
      variables.push({
        name: m[2] as string,
        sensitive: /(^|\n)\s*sensitive\s*=\s*true/.test(body),
        has_default: /(^|\n)\s*default\s*=/.test(body),
      })
    }
  }
  const rel = relative(root, dir) || "."
  const tfvars = names
    .filter((n) => /\.tfvars(\.json)?$/.test(n))
    .sort()
    .map((file) => ({ file, environment: environmentOf([file.replace(/\.tfvars(\.json)?$/, "")]) }))
  let workspaces: string[] = []
  try {
    workspaces = readdirSync(join(dir, "terraform.tfstate.d")).sort()
  } catch {
    // Sin workspaces locales.
  }
  return {
    dir: rel,
    files: tf.length,
    providers: [...providers].sort(),
    backend,
    variables,
    tfvars,
    workspaces,
    initialized: existsSync(join(dir, ".terraform")),
    module: !declaresRoot && (resources === 0 || rel.split("/").includes("modules")),
    resources,
    suggested_environment: environmentOf([rel]),
    suggested_name: suggestedName(rel),
  }
}

/** Las carpetas con `.tf` del proyecto: entornos, otras raíces y al final lo que no se aplica. */
export function discoverTerraform(root: string): DiscoveredTerraform[] {
  const out: DiscoveredTerraform[] = []
  let seen = 0
  const walk = (dir: string, depth: number) => {
    if (depth > MAX_DEPTH || seen++ > MAX_DIRS) return
    const found = describeTerraform(root, dir)
    if (found) out.push(found)
    let names: string[]
    try {
      names = readdirSync(dir)
    } catch {
      return
    }
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
  // Primero los entornos, de menos a más sensible: lo que queda elegido de entrada no es prod.
  const rank = (d: DiscoveredTerraform) =>
    d.module ? 4 : d.suggested_environment ? ENV_RANK[d.suggested_environment] : 3
  return out.sort((a, b) => rank(a) - rank(b) || a.dir.localeCompare(b.dir))
}

const GENERIC = /^(terraform|tf|infra|infrastructure|iac|environments?|envs?|stacks?|live)$/i

/**
 * El nombre propuesto: el entorno con el proyecto de arriba (`terraform/environments/stage`
 * → `terraform-stage`), o la carpeta si no es genérica.
 */
function suggestedName(dir: string): string {
  const parts = dir.split("/").filter((p) => p && p !== ".")
  const last = parts.at(-1) ?? "terraform"
  const base =
    [...parts.slice(0, -1)].reverse().find((p) => !GENERIC.test(p) && !environmentOf([p])) ??
    parts.find((p) => GENERIC.test(p)) ??
    "terraform"
  if (environmentOf([last])) return `${base}-${last}`
  return GENERIC.test(last) && parts.length > 1 ? `${parts.at(-2)}-${last}` : last
}
