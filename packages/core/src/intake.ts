/**
 * Las tools deterministas del orquestador (ADR-0042): un primer corte de un mensaje en
 * intents, el check de listo, los carriles por frontera y el plan de la feature que
 * nace del lote (ADR-0035). Deciden los agentes; esto es lo mecánico, sin tokens, y lo
 * que el daemon usa para validar lo que el agente propone. Puro: sin I/O.
 */
import { z } from "zod"

export const INTENT_KINDS = [
  "copy",
  "ui-change",
  "bugfix",
  "feature",
  "refactor",
  "design-proposal",
  "research",
  "docs",
  "release",
  "chore",
] as const
export type IntentKind = (typeof INTENT_KINDS)[number]

/** Lo que no es un intent: una regla que imponer o un «sí» a decisiones. */
export const DRAFT_KINDS = [...INTENT_KINDS, "correction", "ratification"] as const
export type DraftKind = (typeof DRAFT_KINDS)[number]

export const IntentOrderingSchema = z.union([
  z.literal("now"),
  z.literal("end-of-batch"),
  z.literal("deferred"),
  z.object({ after: z.array(z.string()).min(1) }),
])
export type IntentOrdering = z.infer<typeof IntentOrderingSchema>

/** Con qué agente se trabaja una subtarea (ADR-0042 §4). */
export const AgentProfileSchema = z.object({
  provider: z.enum(["claude", "codex"]),
  model: z.string().max(100).optional(),
  effort: z.enum(["low", "medium", "high", "xhigh", "max"]).optional(),
})
export type AgentProfile = z.infer<typeof AgentProfileSchema>

/** Un intent como lo propone el orquestador en el plan del lote (ADR-0035 §2). */
export const BatchIntentSchema = z.object({
  /** `T1`, `T2`…: la clave de la subtarea que nace de él. */
  key: z.string().regex(/^T\d+$/),
  title: z.string().min(3).max(200),
  kind: z.enum(INTENT_KINDS),
  /** Qué resultado se espera. */
  goal: z.string().max(2_000).default(""),
  /** Dónde vive: globs de la frontera (ADR-0022). */
  scope: z.array(z.string().min(1).max(300)).max(20).default([]),
  /** Cómo se sabe que quedó: criterios verificables. */
  acceptance: z.array(z.string().min(1).max(500)).max(20).default([]),
  ordering: IntentOrderingSchema.default("now"),
  profile: AgentProfileSchema.optional(),
  /** De dónde salió: el mensaje o el pasaje de una fuente (`S-1 §3`). */
  provenance: z.array(z.string().max(200)).max(10).default([]),
})
export type BatchIntent = z.infer<typeof BatchIntentSchema>

// --- primer corte de un mensaje ------------------------------------------------------

export type DraftIntent = {
  text: string
  kind: DraftKind
  /** 0..1: qué tan clara es la clase. Bajo 0.6 el chip va punteado y pide aclarar. */
  confidence: number
  ordering: "now" | "end-of-batch" | "deferred"
  /** Dónde empieza en el mensaje: la procedencia del intent. */
  span: [number, number]
}

/** Reglas por clase, en español e inglés (SDD 05 §Reglas de clasificación). */
const RULES: { kind: DraftKind; re: RegExp }[] = [
  {
    kind: "ratification",
    re: /^(s[ií]\s+a\b|de acuerdo|aprobad[oa]s?|apruebo|yes to|approved?\b|go ahead)/i,
  },
  {
    kind: "correction",
    re: /\b(no (puedes|debe|deber[ií]a|se puede)|nunca|s[oó]lo si|solamente si|never|must not|only if|always)\b/i,
  },
  {
    kind: "bugfix",
    re: /\b(no (se )?(ve|ven|puede ver|funciona|aparece|aparecen|carga|abre)|falla|fallan|error|roto|rota|bug|arregla|corrige|fix|broken|doesn'?t work|can'?t see|crash)/i,
  },
  {
    kind: "copy",
    re: /\b(cambia el texto|cambia los textos|redacci[oó]n|copy\b|wording|label text)|[«"“][^»"”]{3,}[»"”]/i,
  },
  {
    kind: "design-proposal",
    re: /\b(prop[oó]n|prop[oó]ner|haz una propuesta|c[oó]mo deber[ií]a verse|qu[eé] se muestra|propose|mockup)/i,
  },
  {
    kind: "research",
    re: /\b(investiga|compara|qu[eé] opciones|research|evaluate|investigate|benchmark)/i,
  },
  {
    kind: "release",
    re: /\b(desplieg|despliega|desplegar|deploy|sube a prod|release|publica en producci[oó]n)/i,
  },
  {
    kind: "docs",
    re: /\b(documenta|actualiza (los )?docs|changelog|readme|\bADR\b|documentation)/i,
  },
  {
    kind: "refactor",
    re: /\b(refactor|reestructura|limpia el c[oó]digo|extrae|simplifica|clean ?up)/i,
  },
  {
    kind: "ui-change",
    re: /\b(m[aá]s grande|m[aá]s peque[nñ]|color|colores|invierte|invertir|mueve|mover|arriba|abajo|alinea|bot[oó]n|botones|men[uú]|en verde|en rojo|layout|bigger|smaller|move|align|button|menu)/i,
  },
  {
    kind: "feature",
    re: /\b(agrega|a[nñ]ade|integra|crea|implementa|permite|nueva? (pantalla|vista|secci[oó]n)|add|implement|create|integrate|support)\b/i,
  },
  {
    kind: "chore",
    re: /\b(actualiza dependencias|bump|configura|setup|ci\b|lint)/i,
  },
]

const AT_END =
  /\b(al final|cuando termine(s)? (todo)?|al cerrar|at the end|when (everything|all) is done)\b/i
const LATER =
  /\b(despu[eé]s lo vemos|lo vemos despu[eé]s|m[aá]s adelante|puede esperar|later|can wait)\b/i
/** Un pedido: verbo de acción o fórmula de deseo. Lo demás es contexto del anterior. */
const REQUEST =
  /\b(quiero|necesito|hay que|debe|deber[ií]a|que (se|sea|el|la|los|las)|agrega|a[nñ]ade|cambia|arregla|corrige|mueve|invierte|haz|crea|implementa|integra|revisa|prop[oó]n|investiga|despliega|documenta|elimina|quita|pon|make|add|change|fix|move|create|implement|review|propose|deploy|remove|update)\b/i
const CONNECTOR =
  /^(adem[aá]s|tambi[eé]n|luego|por otro lado|y que|otra cosa|also|then|plus)\b[,:]?\s*/i

/** Partes del mensaje que pueden ser un pedido: ítems de lista, párrafos y oraciones. */
function pieces(text: string): { text: string; start: number }[] {
  const out: { text: string; start: number }[] = []
  const re = /[^\n]+/g
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const line = m[0]
    const item = /^\s*(?:[-*+]|\d+[.)])\s+/.exec(line)
    if (item) {
      out.push({ text: line.slice(item[0].length).trim(), start: m.index + item[0].length })
      continue
    }
    // Oraciones: un punto, signo o «;» seguido de espacio y mayúscula o conector.
    const sre = /[^.;!?]+[.;!?]*/g
    for (let s = sre.exec(line); s; s = sre.exec(line)) {
      const t = s[0].trim()
      if (t) out.push({ text: t, start: m.index + s.index + s[0].indexOf(t) })
    }
  }
  return out.filter((p) => p.text.replace(/[.;!?]/g, "").trim().length > 0)
}

function classify(text: string): { kind: DraftKind; confidence: number } {
  const hits = RULES.filter((r) => r.re.test(text))
  if (hits.length === 0) return { kind: "feature", confidence: 0.4 }
  const first = hits[0] as (typeof RULES)[number]
  // Ratificar y corregir mandan: no son trabajo nuevo.
  if (first.kind === "ratification" || first.kind === "correction")
    return { kind: first.kind, confidence: 0.85 }
  // Un bug que además menciona la UI sigue siendo un bug: el orden de RULES lo decide.
  const distinct = new Set(hits.map((h) => h.kind))
  return { kind: first.kind, confidence: distinct.size === 1 ? 0.9 : 0.65 }
}

/**
 * `intake_draft`: el primer corte de un mensaje. Una oración sin pedido se une al
 * pedido anterior; un conector («además», «también») empieza uno nuevo. Es una ayuda:
 * el orquestador la acepta, la corrige o la ignora (ADR-0042 §3).
 */
export function intakeDraft(message: string): DraftIntent[] {
  const out: DraftIntent[] = []
  for (const p of pieces(message)) {
    const text = p.text.replace(CONNECTOR, "")
    const isRequest = REQUEST.test(text) || RULES.some((r) => r.re.test(text))
    const prev = out.at(-1)
    if (!isRequest && prev && !CONNECTOR.test(p.text)) {
      prev.text = `${prev.text} ${text}`
      prev.span = [prev.span[0], p.start + p.text.length]
      continue
    }
    if (!isRequest) continue
    const c = classify(text)
    out.push({
      text,
      kind: c.kind,
      confidence: c.confidence,
      ordering: AT_END.test(text) ? "end-of-batch" : LATER.test(text) ? "deferred" : "now",
      span: [p.start, p.start + p.text.length],
    })
  }
  // Sin un solo pedido reconocible, el mensaje entero es un intent que pide aclarar.
  if (out.length === 0 && message.trim())
    out.push({
      text: message.trim(),
      kind: "feature",
      confidence: 0.3,
      ordering: "now",
      span: [0, message.length],
    })
  // El orden también lo puede dar una oración de contexto unida después.
  for (const d of out)
    if (d.ordering === "now")
      d.ordering = AT_END.test(d.text) ? "end-of-batch" : LATER.test(d.text) ? "deferred" : "now"
  return out
}

// --- check de listo ------------------------------------------------------------------

export type ReadyQuestion = {
  slot: "goal" | "scope" | "acceptance"
  question: string
  options: string[]
}
export type ReadyCheck = {
  goal: boolean
  scope: boolean
  acceptance: boolean
  ready: boolean
  questions: ReadyQuestion[]
}

/**
 * `ready_check`: objetivo, alcance y criterio de aceptación (ADR-0035 §2, la validación
 * del brief de ADR-0021 aplicada a un intent). Cada hueco es una pregunta de plantilla;
 * `anchors` son las opciones de alcance que el repo dio.
 */
export function readyCheck(
  intent: Pick<BatchIntent, "title" | "goal" | "scope" | "acceptance" | "kind">,
  anchors: readonly string[] = [],
): ReadyCheck {
  const goal = intent.goal.trim().length >= 10
  // Investigar no toca archivos: su alcance es la pregunta misma.
  const scope = intent.kind === "research" || intent.scope.length > 0
  const acceptance = intent.acceptance.some((a) => a.trim().length >= 5)
  const questions: ReadyQuestion[] = []
  if (!goal)
    questions.push({
      slot: "goal",
      question: `¿Qué resultado esperas de «${intent.title}»?`,
      options: [],
    })
  if (!scope)
    questions.push({
      slot: "scope",
      question: `¿Dónde vive «${intent.title}»: qué archivos, pantalla o módulo?`,
      options: anchors.slice(0, 4),
    })
  if (!acceptance)
    questions.push({
      slot: "acceptance",
      question: `¿Cómo sabremos que «${intent.title}» quedó? Un criterio que se pueda comprobar.`,
      options: [],
    })
  return { goal, scope, acceptance, ready: goal && scope && acceptance, questions }
}

// --- carriles ------------------------------------------------------------------------

/** La parte fija de un glob: hasta el primer comodín, sin la barra final. */
function globBase(glob: string): string {
  const i = glob.search(/[*?[{]/)
  const fixed = i < 0 ? glob : glob.slice(0, i)
  return fixed.replace(/\/[^/]*$/, (m) => (i < 0 ? m : "")).replace(/\/+$/, "")
}

/** ¿Pueden dos fronteras tocar el mismo archivo? Por su parte fija, en carpetas. */
export function frontiersOverlap(a: readonly string[], b: readonly string[]): boolean {
  for (const x of a)
    for (const y of b) {
      const bx = globBase(x)
      const by = globBase(y)
      if (bx === "" || by === "") return true
      if (bx === by || bx.startsWith(`${by}/`) || by.startsWith(`${bx}/`)) return true
    }
  return false
}

/**
 * `lanes_compute` (ADR-0039 §1): los intents cuyas fronteras se cruzan van al mismo
 * carril, en orden; los demás, a carriles distintos. Sin frontera, su propio carril.
 */
export function lanesFor(items: readonly { key: string; scope: readonly string[] }[]): string[][] {
  const lanes: { keys: string[]; scope: string[] }[] = []
  for (const it of items) {
    const joined = lanes.filter((l) => it.scope.length > 0 && frontiersOverlap(l.scope, it.scope))
    if (joined.length === 0) {
      lanes.push({ keys: [it.key], scope: [...it.scope] })
      continue
    }
    // Un intent que toca dos carriles los une: no pueden correr a la vez.
    const [first, ...rest] = joined as [(typeof lanes)[number], ...(typeof lanes)[number][]]
    first.keys.push(it.key)
    first.scope.push(...it.scope)
    for (const r of rest) {
      first.keys.push(...r.keys)
      first.scope.push(...r.scope)
      lanes.splice(lanes.indexOf(r), 1)
    }
  }
  return lanes.map((l) => l.keys)
}

// --- de plan a feature ---------------------------------------------------------------

/**
 * Los documentos de la feature que nace del lote (ADR-0035 §1): un requisito `R<n>` por
 * intent con sus criterios, y el plan `tasks` que lee `parseTasks` (ADR-0022): fases por
 * orden, frontera y dependencias. Lo diferido no entra: vuelve al backlog.
 */
export function batchDocs(
  title: string,
  summary: string,
  intents: readonly BatchIntent[],
): { brief: string; spec: string; tasks: string } {
  // Desplegar no es una subtarea de código: es el último paso del cierre (ADR-0038 §4).
  const release = intents.filter((i) => i.kind === "release" && i.ordering !== "deferred")
  const live = intents.filter((i) => i.ordering !== "deferred" && i.kind !== "release")
  const phaseOf = new Map<string, number>()
  const resolve = (i: BatchIntent, seen = new Set<string>()): number => {
    const known = phaseOf.get(i.key)
    if (known) return known
    let p = 1
    if (typeof i.ordering === "object")
      for (const k of i.ordering.after) {
        const dep = live.find((x) => x.key === k)
        if (dep && !seen.has(k)) p = Math.max(p, resolve(dep, new Set([...seen, i.key])) + 1)
      }
    phaseOf.set(i.key, p)
    return p
  }
  for (const i of live) if (i.ordering !== "end-of-batch") resolve(i)
  const last = Math.max(1, ...phaseOf.values())
  for (const i of live) if (i.ordering === "end-of-batch") phaseOf.set(i.key, last + 1)
  const phases = [...new Set(phaseOf.values())].sort((a, b) => a - b)
  const req = (i: BatchIntent) => `R${Number(i.key.slice(1))}`
  const tasks = phases
    .map((ph) => {
      const items = live.filter((i) => phaseOf.get(i.key) === ph)
      const lines = items.map((i) => {
        const front = i.scope.map((g) => `\`${g}\``).join(" ")
        const after =
          typeof i.ordering === "object" ? ` (después de ${i.ordering.after.join(", ")})` : ""
        return `- [ ] ${i.key} ${i.title}${after}${front ? ` → ${front}` : ""} → ${req(i)}`
      })
      const name = items.every((i) => i.ordering === "end-of-batch") ? "Cierre" : `Paso ${ph}`
      return `## Fase ${ph} — ${name}\n${lines.join("\n")}`
    })
    .join("\n\n")
  const spec = [
    "## Requisitos",
    ...live.map((i) =>
      [
        `### ${req(i)} — ${i.title}`,
        i.goal || i.title,
        ...i.acceptance.map(
          (a, n) =>
            `#### Escenario: criterio ${n + 1}\n- **Dado** ${i.title}\n- **Cuando** se termina\n- **Entonces** ${a}`,
        ),
      ].join("\n"),
    ),
  ].join("\n\n")
  const brief = [
    `# ${title}`,
    "## Problema",
    summary || title,
    "## Alcance",
    live.map((i) => `- ${i.key} ${i.title}`).join("\n"),
    "## Fuera de alcance",
    intents
      .filter((i) => i.ordering === "deferred")
      .map((i) => `- ${i.title} (diferido)`)
      .join("\n") || "- Lo que no está en el alcance.",
    ...(release.length
      ? ["## Al cierre del lote", release.map((i) => `- ${i.title}`).join("\n")]
      : []),
    "## Criterios de aceptación",
    live.flatMap((i) => i.acceptance.map((a) => `- ${i.key}: ${a}`)).join("\n") ||
      "- Cada subtarea cumple sus criterios.",
  ].join("\n\n")
  return { brief, spec, tasks }
}
