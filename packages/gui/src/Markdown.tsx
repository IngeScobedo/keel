import { createContext, type ReactNode, useContext, useLayoutEffect, useRef, useState } from "react"
import { useOpenDetail } from "./useNav.js"

/**
 * Las referencias a tareas (`KEEL-12`) en el texto del agente: si la tarea existe, la
 * referencia la abre y apila el lugar (ADR-0034 §4).
 */
type Refs = { has: (key: string) => boolean; open: (key: string) => void }
const RefContext = createContext<Refs | null>(null)
export const MarkdownRefs = RefContext.Provider

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
    // Tabla: una fila de encabezado, la línea de guiones y las filas.
    if (/^\s*\|.*\|\s*$/.test(line) && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1] ?? "")) {
      const cells = (l: string) =>
        l
          .trim()
          .replace(/^\||\|$/g, "")
          .split("|")
          .map((c) => c.trim())
      const head = cells(line)
      const rows: string[][] = []
      i += 2
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i] as string))
        rows.push(cells(lines[i++] as string))
      blocks.push(
        <table key={blocks.length} className="md-table">
          <thead>
            <tr>
              {head.map((h, n) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: columnas fijas de la tabla
                <th key={n}>{inline(h)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, rn) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: filas de un texto estático
              <tr key={rn}>
                {r.map((c, n) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: columnas fijas de la tabla
                  <td key={n}>{inline(c)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>,
      )
      continue
    }
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      blocks.push(<hr key={blocks.length} className="md-hr" />)
      i++
      continue
    }
    if (/^\s*>/.test(line)) {
      const body: string[] = []
      while (i < lines.length && /^\s*>/.test(lines[i] as string))
        body.push((lines[i++] as string).replace(/^\s*>\s?/, ""))
      blocks.push(<Markdown key={blocks.length} className="md-quote" text={body.join("\n")} />)
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
            <ListItem key={n} text={it} />
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

/** Un punto de lista; `[ ]` y `[x]` se dibujan como casilla, sin poder marcarla. */
function ListItem({ text }: { text: string }) {
  const task = /^\[([ xX])\]\s+/.exec(text)
  if (!task) return <li>{inline(text)}</li>
  const done = task[1] !== " "
  return (
    <li className="md-task" data-done={done || undefined}>
      <span className="md-box" role="img" aria-label={done ? "hecho" : "pendiente"} />
      <span>{inline(text.slice(task[0].length))}</span>
    </li>
  )
}

function Ref({ id }: { id: string }) {
  const refs = useContext(RefContext)
  if (!refs?.has(id)) return <>{id}</>
  return (
    <button type="button" className="md-ref mono" onClick={() => refs.open(id)}>
      {id}
    </button>
  )
}

/**
 * `código`, **negrita**, *cursiva*, [enlaces](url) y referencias `KEEL-12`, en ese orden
 * de prioridad. Un enlace se muestra con su destino en el título: la GUI no navega fuera.
 */
function inline(text: string): ReactNode[] {
  const out: ReactNode[] = []
  const re =
    /`([^`]+)`|\*\*([^*]+)\*\*|(?<![\w*])\*([^*\s][^*]*)\*(?![\w*])|\[([^\]]+)\]\(([^)\s]+)\)|\b([A-Z][A-Z0-9]{1,9}-\d+)\b/g
  let last = 0
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > last) out.push(text.slice(last, m.index))
    if (m[1] !== undefined) out.push(<code key={m.index}>{m[1]}</code>)
    else if (m[2] !== undefined) out.push(<strong key={m.index}>{inline(m[2])}</strong>)
    else if (m[3] !== undefined) out.push(<em key={m.index}>{inline(m[3])}</em>)
    else if (m[4] !== undefined)
      out.push(
        <span key={m.index} className="md-link" title={m[5]}>
          {m[4]}
        </span>,
      )
    else out.push(<Ref key={m.index} id={m[6] as string} />)
    last = m.index + m[0].length
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

/**
 * El Markdown de un agente en una lista (ADR-0034 §5): hasta `maxHeight`, con un
 * degradado al final y «ver detalle», que lo abre completo encima como un lugar más.
 */
export function MarkdownPreview({
  text,
  title,
  maxHeight = 220,
}: {
  text: string
  title: string
  maxHeight?: number
}) {
  const body = useRef<HTMLDivElement>(null)
  const [cut, setCut] = useState(false)
  const [open, setOpen] = useState(false)
  const openDetail = useOpenDetail()
  useLayoutEffect(() => {
    const el = body.current
    if (!el) return
    const check = () => setCut(el.scrollHeight > el.clientHeight + 4)
    check()
    if (typeof ResizeObserver === "undefined") return
    const ro = new ResizeObserver(check)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return (
    <div className="md-preview" data-cut={(cut && !open) || undefined}>
      <div
        ref={body}
        className="md-preview-body"
        style={open ? undefined : { maxHeight: `${maxHeight}px` }}
      >
        <Markdown text={text} />
      </div>
      {cut && !open && (
        <button
          type="button"
          className="md-more"
          onClick={() =>
            openDetail ? openDetail({ kind: "markdown", title, text }) : setOpen(true)
          }
        >
          Ver detalle
        </button>
      )}
    </div>
  )
}
