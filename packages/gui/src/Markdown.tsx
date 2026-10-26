import type { ReactNode } from "react"

/**
 * Markdown mínimo para lo que escribe el agente: párrafos, títulos, listas,
 * bloques de código, `código`, **negritas** y *cursivas*. Construye nodos de
 * React; nunca inyecta HTML, así que el texto del agente no puede ejecutar nada.
 */
export function Markdown({ text, className }: { text: string; className?: string }) {
  const blocks: ReactNode[] = []
  const lines = text.replace(/\r\n/g, "\n").split("\n")
  let i = 0
  while (i < lines.length) {
    const line = lines[i] as string
    const fence = /^\s*```(\S*)/.exec(line)
    if (fence) {
      const body: string[] = []
      i++
      while (i < lines.length && !/^\s*```/.test(lines[i] as string))
        body.push(lines[i++] as string)
      i++
      blocks.push(
        <pre key={blocks.length} className="md-code" data-lang={fence[1] || undefined}>
          {body.join("\n")}
        </pre>,
      )
      continue
    }
    const heading = /^(#{1,4})\s+(.*)$/.exec(line)
    if (heading) {
      blocks.push(
        <p key={blocks.length} className={`md-h md-h${(heading[1] as string).length}`}>
          {inline(heading[2] as string)}
        </p>,
      )
      i++
      continue
    }
    if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) {
      const ordered = /^\s*\d/.test(line)
      const items: string[] = []
      while (i < lines.length && /^\s*([-*+]|\d+[.)])\s+/.test(lines[i] as string)) {
        let item = (lines[i] as string).replace(/^\s*([-*+]|\d+[.)])\s+/, "")
        i++
        // Las líneas sangradas siguen siendo del mismo punto.
        while (i < lines.length && /^\s{2,}\S/.test(lines[i] as string))
          item += ` ${(lines[i++] as string).trim()}`
        items.push(item)
      }
      const List = ordered ? "ol" : "ul"
      blocks.push(
        <List key={blocks.length} className="md-list">
          {items.map((it, n) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: el texto no cambia de orden
            <li key={n}>{inline(it)}</li>
          ))}
        </List>,
      )
      continue
    }
    if (!line.trim()) {
      i++
      continue
    }
    const para: string[] = []
    while (
      i < lines.length &&
      (lines[i] as string).trim() &&
      !/^\s*(```|#{1,4}\s|([-*+]|\d+[.)])\s+)/.test(lines[i] as string)
    )
      para.push(lines[i++] as string)
    blocks.push(
      <p key={blocks.length} className="md-p">
        {inline(para.join("\n"))}
      </p>,
    )
  }
  return <div className={`md ${className ?? ""}`}>{blocks}</div>
}

/** `código`, **negrita** y *cursiva*, en ese orden de prioridad. */
function inline(text: string): ReactNode[] {
  const out: ReactNode[] = []
  const re = /`([^`]+)`|\*\*([^*]+)\*\*|(?<![\w*])\*([^*\s][^*]*)\*(?![\w*])/g
  let last = 0
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > last) out.push(text.slice(last, m.index))
    if (m[1] !== undefined) out.push(<code key={m.index}>{m[1]}</code>)
    else if (m[2] !== undefined) out.push(<strong key={m.index}>{m[2]}</strong>)
    else out.push(<em key={m.index}>{m[3]}</em>)
    last = m.index + m[0].length
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}
