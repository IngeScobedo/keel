/**
 * Patrones de permiso (ADR-0019 §4, SDD 01 §08 y §10): qué cubre «aprobar para
 * esta sesión» o «permitir siempre en este proyecto». Puro y compartido: el
 * daemon decide con esto y la GUI lo muestra antes de que el humano lo elija.
 *
 * La regla es conservadora. Un comando con encadenamiento, redirección o
 * sustitución (`;`, `&&`, `|`, `>`, `$(…)`, comillas invertidas, saltos de
 * línea) nunca casa con un prefijo, sólo consigo mismo: así «permitir
 * `git status`» no deja pasar `git status; rm -rf ~`.
 */

export type PermissionPattern = {
  tool: string
  /** null = toda la herramienta. */
  prefix: string | null
  /** true = sólo ese comando exacto. */
  exact: boolean
}

const SHELL_META = /[;&|`<>\n\r]|\$\(/
// `codex` envuelve los comandos: `/bin/bash -lc 'ls -la'`.
const WRAPPED = /^(?:\S*\/)?(?:ba|z)?sh\s+-l?c\s+(['"])([\s\S]*)\1$/

const SHELL_TOOLS = new Set(["Bash", "shell", "local_shell", "exec_command"])

/** El comando que de verdad corre, sin el envoltorio `sh -c '…'`. */
export function shellCommand(input: unknown): string | null {
  const raw = (input as { command?: unknown } | null)?.command
  const cmd = Array.isArray(raw) ? raw.map(String).join(" ") : typeof raw === "string" ? raw : null
  if (cmd === null) return null
  const trimmed = cmd.trim()
  const m = WRAPPED.exec(trimmed)
  return m ? (m[2] as string).trim() : trimmed
}

/** El patrón que se propone al humano para esta operación. */
export function patternFor(tool: string, input: unknown): PermissionPattern {
  if (!SHELL_TOOLS.has(tool)) return { tool, prefix: null, exact: false }
  const cmd = shellCommand(input) ?? ""
  if (!cmd || SHELL_META.test(cmd)) return { tool, prefix: cmd, exact: true }
  const words = cmd.split(/\s+/)
  const second = words[1]
  const take = second !== undefined && !second.startsWith("-") ? 2 : 1
  return { tool, prefix: words.slice(0, take).join(" "), exact: false }
}

/** ¿Cubre el patrón esta operación? */
export function matchesPattern(p: PermissionPattern, tool: string, input: unknown): boolean {
  if (p.tool !== tool) return false
  if (p.prefix === null) return true
  const cmd = shellCommand(input)
  if (cmd === null) return false
  if (p.exact) return cmd === p.prefix
  if (SHELL_META.test(cmd)) return false
  return cmd === p.prefix || cmd.startsWith(`${p.prefix} `)
}

/** Texto corto para la UI: `Bash(git status:*)`, `Bash(rm -rf build)`, `Write`. */
export function describePattern(p: PermissionPattern): string {
  if (p.prefix === null) return p.tool
  return p.exact ? `${p.tool}(${p.prefix})` : `${p.tool}(${p.prefix}:*)`
}

/** Ruta de archivo de la operación, si la tiene (Write, Edit, Read…). */
export function filePathOf(input: unknown): string | null {
  const i = input as { file_path?: unknown; path?: unknown; notebook_path?: unknown } | null
  const v = i?.file_path ?? i?.notebook_path ?? i?.path
  return typeof v === "string" ? v : null
}

/**
 * El patrón como lo edita el humano (ADR-0020 §2): `cd *` cubre `cd` y lo que
 * siga; sin `*` final es la orden exacta. Fuera del shell, `*` es toda la
 * herramienta.
 */
export function patternText(p: PermissionPattern): string {
  if (p.prefix === null) return "*"
  return p.exact ? p.prefix : `${p.prefix} *`
}

/**
 * Lee lo que escribió el humano. Devuelve null si no es un patrón aceptable:
 * todo el shell es el modo `bypass`, no un patrón, y un prefijo con
 * metacaracteres no se admite porque lo que siga podría encadenar otra orden.
 */
export function parsePattern(tool: string, text: string): PermissionPattern | null {
  const t = text.trim()
  if (!SHELL_TOOLS.has(tool))
    return t === "*" || t === "" || t === tool ? { tool, prefix: null, exact: false } : null
  if (t === "" || t === "*") return null
  if (t.endsWith("*")) {
    if (!t.endsWith(" *")) return null
    const prefix = t.slice(0, -2).trim()
    if (!prefix || SHELL_META.test(prefix)) return null
    return { tool, prefix, exact: false }
  }
  return { tool, prefix: t, exact: true }
}
