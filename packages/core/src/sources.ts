/**
 * Fuentes del proyecto partidas en pasajes citables (ADR-0040). Un pasaje tiene un ancla
 * estable (`§3`) dentro de su fuente; lo que dice es dato, nunca instrucción. Puro.
 */

export type Passage = {
  /** `§1`, `§2`…: estable mientras la fuente no cambie. */
  anchor: string
  /** El encabezado bajo el que está, si hay. */
  heading: string | null
  text: string
}

/**
 * Markdown o texto plano a pasajes: un encabezado abre sección; cada párrafo y cada
 * ítem de lista es un pasaje. Un bloque de código es un pasaje entero.
 */
export function passagesOf(text: string): Passage[] {
  const out: Passage[] = []
  let heading: string | null = null
  let para: string[] = []
  const push = (t: string) => {
    const clean = t.trim()
    if (clean) out.push({ anchor: `§${out.length + 1}`, heading, text: clean })
  }
  const flush = () => {
    if (para.length) push(para.join(" "))
    para = []
  }
  const lines = text.replace(/\r\n?/g, "\n").split("\n")
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string
    if (/^\s*```/.test(line)) {
      flush()
      const body = [line]
      i++
      while (i < lines.length && !/^\s*```/.test(lines[i] as string))
        body.push(lines[i++] as string)
      body.push("```")
      push(body.join("\n"))
      continue
    }
    const h = /^\s{0,3}#{1,6}\s+(.*)$/.exec(line)
    if (h) {
      flush()
      heading = (h[1] as string).trim()
      continue
    }
    const item = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/.exec(line)
    if (item) {
      flush()
      push(item[1] as string)
      continue
    }
    if (!line.trim()) flush()
    else para.push(line.trim())
  }
  flush()
  return out
}

/** La cita corta de un pasaje: `S-2 §5`. */
export function citation(sourceKey: string, anchor: string): string {
  return `${sourceKey} ${anchor}`
}
