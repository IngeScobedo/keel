/**
 * Los tokens de la GUI (ADR-0034 §1). Genera `packages/gui/src/tokens.css` desde
 * `docs/design/tokens.json`, el export del canvas, y vigila que ningún otro CSS de la
 * GUI use un color literal: los componentes sólo usan variables.
 *
 *   bun scripts/design-tokens.ts           escribe tokens.css
 *   bun scripts/design-tokens.ts --check   falla si tokens.css no coincide o hay literales
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs"
import { join, relative } from "node:path"

type Themed = { value: string; ref?: string; alpha?: number; theme: { mode: string } }
type Variable = { type: "color" | "number" | "string"; value: string | number | Themed[] }

const root = join(import.meta.dir, "..")
const source = join(root, "docs/design/tokens.json")
const target = join(root, "packages/gui/src/tokens.css")
const gui = join(root, "packages/gui/src")

const vars = (JSON.parse(readFileSync(source, "utf8")) as { variables: Record<string, Variable> })
  .variables
const name = (k: string) => `--${k.replaceAll("/", "-").replaceAll("_", "-")}`
const PX = /^(text\/.*\/size|space\/|radius\/|row\/|icon\/size)/

function literal(k: string, v: string | number): string {
  if (typeof v === "number") return PX.test(k) ? `${v}px` : String(v)
  return /^#/.test(v) ? v.toLowerCase() : `"${v}"`
}

/** Un valor semántico por tema: el primitivo del que sale, con su opacidad si la tiene. */
function themed(t: Themed): string {
  if (!t.ref) return t.value.toLowerCase()
  if (t.alpha === undefined) return `var(${name(t.ref)})`
  return `color-mix(in srgb, var(${name(t.ref)}) ${Math.round(t.alpha * 100)}%, transparent)`
}

function render(): string {
  const dark: string[] = []
  const light: string[] = []
  for (const [k, v] of Object.entries(vars)) {
    if (!Array.isArray(v.value)) {
      dark.push(`    ${name(k)}: ${literal(k, v.value)};`)
      continue
    }
    const d = v.value.find((t) => t.theme.mode === "dark")
    const l = v.value.find((t) => t.theme.mode === "light")
    if (d) dark.push(`    ${name(k)}: ${themed(d)};`)
    if (l) light.push(`    ${name(k)}: ${themed(l)};`)
  }
  return [
    "/* Generado por scripts/design-tokens.ts desde docs/design/tokens.json (ADR-0034 §1). No editar a mano. */",
    "@layer tokens {",
    "  :root {",
    ...dark,
    "  }",
    '  :root[data-theme="light"] {',
    ...light,
    "  }",
    "}",
    "",
  ].join("\n")
}

/** Colores escritos a mano fuera de los tokens: `#abc`, `rgb(…)`, `hsl(…)`. */
function literals(): string[] {
  const out: string[] = []
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.name.endsWith(".css") && p !== target)
        readFileSync(p, "utf8")
          .split("\n")
          .forEach((line, i) => {
            const code = line.replace(/\/\*.*?\*\//g, "")
            if (/#[0-9a-fA-F]{3,8}\b|\b(rgba?|hsla?)\(/.test(code))
              out.push(`${relative(root, p)}:${i + 1}: ${line.trim()}`)
          })
    }
  }
  walk(gui)
  return out
}

const css = render()
if (process.argv.includes("--check")) {
  const problems: string[] = []
  if (readFileSync(target, "utf8") !== css)
    problems.push("tokens.css no coincide con tokens.json: corre bun scripts/design-tokens.ts")
  for (const l of literals()) problems.push(`color literal (usa un token): ${l}`)
  if (problems.length) {
    console.error(problems.join("\n"))
    process.exit(1)
  }
  console.log("tokens al día y sin colores literales")
} else {
  writeFileSync(target, css)
  console.log(`escrito ${relative(root, target)}`)
}
