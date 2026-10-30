/**
 * ADR-0044 §3: la pantalla de una sesión de tmux (`capture-pane -e`) viene con
 * secuencias SGR. Se parten en tramos con su estilo; los 16 colores base usan la paleta
 * de la GUI y los de 256 y 24 bits van tal cual, porque son datos de la terminal.
 */

export type AnsiStyle = {
  fg?: string
  bg?: string
  bold?: boolean
  dim?: boolean
  italic?: boolean
  underline?: boolean
  inverse?: boolean
}
export type AnsiSpan = { text: string; style: AnsiStyle }

const BASE = [
  "var(--gray-0)",
  "var(--color-status-failed)",
  "var(--color-status-succeeded)",
  "var(--color-status-waiting-human)",
  "var(--blue-4)",
  "var(--color-provider-codex)",
  "var(--color-status-running)",
  "var(--color-text-secondary)",
]
const BRIGHT = [
  "var(--color-text-tertiary)",
  "var(--color-status-failed)",
  "var(--color-status-succeeded)",
  "var(--color-status-waiting-human)",
  "var(--blue-3)",
  "var(--color-provider-codex)",
  "var(--color-status-running)",
  "var(--color-text-primary)",
]

function color256(n: number): string {
  if (n < 8) return BASE[n] as string
  if (n < 16) return BRIGHT[n - 8] as string
  if (n >= 232) {
    const v = 8 + (n - 232) * 10
    return `rgb(${v} ${v} ${v})`
  }
  const i = n - 16
  const c = (x: number) => (x === 0 ? 0 : 55 + x * 40)
  return `rgb(${c(Math.floor(i / 36))} ${c(Math.floor(i / 6) % 6)} ${c(i % 6)})`
}

function apply(style: AnsiStyle, params: number[]): AnsiStyle {
  const s = { ...style }
  for (let i = 0; i < params.length; i++) {
    const p = params[i] ?? 0
    if (p === 0) for (const k of Object.keys(s)) delete s[k as keyof AnsiStyle]
    else if (p === 1) s.bold = true
    else if (p === 2) s.dim = true
    else if (p === 3) s.italic = true
    else if (p === 4) s.underline = true
    else if (p === 7) s.inverse = true
    else if (p === 22) {
      delete s.bold
      delete s.dim
    } else if (p === 23) delete s.italic
    else if (p === 24) delete s.underline
    else if (p === 27) delete s.inverse
    else if (p >= 30 && p <= 37) s.fg = BASE[p - 30] as string
    else if (p === 39) delete s.fg
    else if (p >= 40 && p <= 47) s.bg = BASE[p - 40] as string
    else if (p === 49) delete s.bg
    else if (p >= 90 && p <= 97) s.fg = BRIGHT[p - 90] as string
    else if (p >= 100 && p <= 107) s.bg = BRIGHT[p - 100] as string
    else if (p === 38 || p === 48) {
      const key = p === 38 ? "fg" : "bg"
      if (params[i + 1] === 5 && params[i + 2] !== undefined) {
        s[key] = color256(params[i + 2] as number)
        i += 2
      } else if (params[i + 1] === 2 && params[i + 4] !== undefined) {
        s[key] = `rgb(${params[i + 2]} ${params[i + 3]} ${params[i + 4]})`
        i += 4
      }
    }
  }
  return s
}

/** Tramos con estilo; las secuencias que no son SGR se descartan. */
export function parseAnsi(text: string): AnsiSpan[] {
  const out: AnsiSpan[] = []
  let style: AnsiStyle = {}
  // biome-ignore lint/suspicious/noControlCharactersInRegex: ESC es justo lo que se busca.
  const re = /\x1b\[([0-9;:]*)([A-Za-z])|\x1b[()][A-Za-z0-9]|\x1b[=>]/g
  let last = 0
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > last) out.push({ text: text.slice(last, m.index), style })
    if (m[2] === "m")
      style = apply(
        style,
        (m[1] || "0").split(/[;:]/).map((x) => (x === "" ? 0 : Number(x))),
      )
    last = re.lastIndex
  }
  if (last < text.length) out.push({ text: text.slice(last), style })
  return out.filter((s) => s.text.length > 0)
}
