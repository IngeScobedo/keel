/**
 * El método que conduce Keel (ADR-0021): etapas de una tarea, sus gates
 * humanos, la ceremonia (trabajo directo o ciclo formal) y la validación
 * determinista de los documentos de la tarea.
 *
 * Destilado del harness de Casa Matte (`change-state.sh` y `validate.mjs`):
 * la legalidad vive en código, no en la prosa que el agente tendría que
 * recordar, y lo que un script puede comprobar no le cuesta tokens al agente.
 * Puro: sin I/O.
 */
import type { Lifecycle, RunPurpose } from "./visual-state.js"

export const STAGES = ["brief", "design", "implement", "review", "close"] as const
export type Stage = (typeof STAGES)[number]

/** «directo» salta los gates (a) y (b); «formal» recorre el ciclo completo. */
export const CEREMONIES = ["direct", "formal"] as const
export type Ceremony = (typeof CEREMONIES)[number]

/** Los tres gates humanos: (a) brief, (b) contrato congelado, (c) cierre al canon. */
export type Gate = "brief" | "design" | "close"

export const TASK_DOC_KINDS = ["brief", "spec", "design", "tasks", "story", "qa"] as const
export type TaskDocKind = (typeof TASK_DOC_KINDS)[number]

/** Etapas en las que el agente no escribe en el repo. */
export const READ_ONLY_STAGES: readonly Stage[] = ["brief", "design", "review"]

export function isReadOnlyStage(stage: Stage): boolean {
  return READ_ONLY_STAGES.includes(stage)
}

/**
 * Con qué propósito de run corre cada etapa. Brief y diseño son `plan` (sólo
 * lectura, la tarea sigue en `triage`); el resto, `execute`. Todos trabajan en
 * el worktree de la tarea, así que la sesión del proveedor se retoma entre
 * runs: es una sola conversación.
 */
export function purposeForStage(stage: Stage): Extract<RunPurpose, "plan" | "execute"> {
  return stage === "brief" || stage === "design" ? "plan" : "execute"
}

/** El lifecycle (ADR-0006) que corresponde a cada etapa. */
export function lifecycleForStage(stage: Stage): Lifecycle {
  switch (stage) {
    case "brief":
    case "design":
      return "triage"
    case "implement":
    case "review":
      return "running"
    case "close":
      return "needs_review"
  }
}

export type StageMove =
  | {
      ok: true
      gate: Gate | null
      requires: readonly TaskDocKind[]
      /** El paso exige decir por qué: el hallazgo que lo motiva (ADR-0029 §1). */
      needsReason?: true
    }
  | { ok: false; reason: string }

/**
 * ¿Puede el agente pasar de `from` a `to`? Devuelve el gate humano que exige
 * y los documentos que deben validar antes. Volver atrás también es legal:
 * diseño a brief, revisión a implementación (un FAIL) y cierre a implementación
 * con el hallazgo que lo motiva (ADR-0029).
 */
export function stageMove(from: Stage, to: Stage, ceremony: Ceremony | null): StageMove {
  const no = (reason: string): StageMove => ({ ok: false, reason })
  if (from === to) return no(`la tarea ya está en ${to}`)
  switch (`${from}>${to}`) {
    case "brief>design":
      return ceremony === "formal"
        ? { ok: true, gate: "brief", requires: ["brief"] }
        : no("el diseño es del ciclo formal; en trabajo directo se pasa a implement")
    case "brief>implement":
      return ceremony === "direct"
        ? { ok: true, gate: null, requires: ["brief"] }
        : no(
            ceremony === "formal"
              ? "en el ciclo formal el brief pasa a design"
              : "declara la ceremonia (direct o formal) al cerrar el brief",
          )
    case "design>implement":
      return { ok: true, gate: "design", requires: ["spec", "design"] }
    case "design>brief":
      return { ok: true, gate: null, requires: [] }
    case "implement>review":
      return { ok: true, gate: null, requires: [] }
    case "review>implement":
      return { ok: true, gate: null, requires: [] }
    case "review>close":
      return { ok: true, gate: null, requires: ["qa"] }
    case "close>implement":
      return { ok: true, gate: null, requires: [], needsReason: true }
    default:
      return no(`no hay paso legal de ${from} a ${to}`)
  }
}

/**
 * ADR-0029 §3: en `close` el agente sólo escribe el canon del proyecto. `path` es
 * relativo a la raíz del worktree; los directorios del canon, también.
 */
export function canonWritable(
  path: string,
  canon: { adr_dirs: readonly string[]; sdd_dirs: readonly string[]; roadmap: string | null },
): boolean {
  const norm = (p: string) => p.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "")
  const file = norm(path)
  if (file === "" || file.startsWith("../") || file.startsWith("/")) return false
  if (canon.roadmap && file === norm(canon.roadmap)) return true
  return [...canon.adr_dirs, ...canon.sdd_dirs]
    .map(norm)
    .some((dir) => dir !== "" && (file === dir || file.startsWith(`${dir}/`)))
}

/** Un humano puede devolver la tarea a cualquier etapa anterior. */
export function canReturn(from: Stage, to: Stage): boolean {
  return STAGES.indexOf(to) < STAGES.indexOf(from)
}

// --- validación determinista de documentos -----------------------------------------

export type DocCheck = { ok: boolean; level: "block" | "warn"; msg: string; detail?: string }
export type DocReport = { ok: boolean; checks: DocCheck[] }

/** Lo que el perfil del proyecto aporta a la validación. */
export type ValidationContext = {
  /** Fuentes de RegExp: si spec o diseño las mencionan, el diseño debe enlazar un ADR. */
  invariants?: readonly string[]
  /** Fuente de RegExp de un ADR del proyecto; por defecto `ADR-\w*\d+`. */
  adr?: string
}

function report(checks: DocCheck[]): DocReport {
  return { ok: checks.every((c) => c.ok || c.level === "warn"), checks }
}

/** La sección `## <título>` hasta el siguiente `## `. */
export function section(md: string, heading: RegExp): string | null {
  const lines = md.split("\n")
  const start = lines.findIndex((l) => /^##\s/.test(l) && heading.test(l.replace(/^##\s+/, "")))
  if (start < 0) return null
  const rest = lines.slice(start + 1)
  const end = rest.findIndex((l) => /^##\s/.test(l))
  return rest.slice(0, end < 0 ? rest.length : end).join("\n")
}

const filled = (s: string | null) =>
  s !== null &&
  s
    .split("\n")
    .map((l) => l.trim())
    .some((l) => l && l !== "…" && !/^(<.*>|&lt;.*&gt;|_.*_)$/.test(l))

const BRIEF_SECTIONS: [string, RegExp][] = [
  ["Problema", /^problema|^por qu[eé]/i],
  ["Alcance", /^alcance|^qu[eé] cambia/i],
  ["Fuera de alcance", /^fuera de alcance|^no objetivos/i],
  ["Criterios de aceptación", /^criterios/i],
]

/** El brief: problema, alcance, fuera de alcance y criterios, no vacíos. */
export function validateBrief(md: string): DocReport {
  return report(
    BRIEF_SECTIONS.map(([name, re]) => ({
      ok: filled(section(md, re)),
      level: "block" as const,
      msg: `sección «${name}» con contenido`,
    })),
  )
}

export type SpecRequirement = {
  id: string
  title: string
  scenarios: { title: string; clauses: Record<string, string> }[]
}

/** Requisitos `### R<n>` con escenarios `#### Escenario:` y cláusulas Dado/Cuando/Entonces. */
export function parseSpec(md: string): SpecRequirement[] {
  const reqs: SpecRequirement[] = []
  let cur: SpecRequirement | null = null
  let sc: SpecRequirement["scenarios"][number] | null = null
  for (const raw of md.split("\n")) {
    const r = /^###\s+(R\d+)\b\s*(?:[—-]\s*)?(.*)$/.exec(raw)
    if (r) {
      cur = { id: r[1] as string, title: (r[2] ?? "").trim(), scenarios: [] }
      reqs.push(cur)
      sc = null
      continue
    }
    const s = /^####\s+Escenario:\s*(.*)$/i.exec(raw)
    if (s && cur) {
      sc = { title: (s[1] ?? "").trim(), clauses: {} }
      cur.scenarios.push(sc)
      continue
    }
    const c = /^\s*[-*]\s*\*\*(Dado|Cuando|Entonces|Y)\*\*\s*(.*)$/i.exec(raw)
    if (c && sc) {
      const k = (c[1] as string).toLowerCase()
      sc.clauses[k] = `${sc.clauses[k] ?? ""} ${c[2] ?? ""}`.trim()
    }
  }
  return reqs
}

/** Cada requisito con al menos un escenario, y cada escenario con Dado, Cuando y Entonces. */
export function validateSpec(md: string): DocReport {
  const reqs = parseSpec(md)
  const noScenario = reqs.filter((r) => r.scenarios.length === 0).map((r) => r.id)
  const incomplete = reqs.flatMap((r) =>
    r.scenarios
      .filter((s) => !s.clauses.dado || !s.clauses.cuando || !s.clauses.entonces)
      .map((s) => `${r.id} «${s.title}»`),
  )
  return report([
    { ok: reqs.length > 0, level: "block", msg: "al menos un requisito `### R1`" },
    {
      ok: noScenario.length === 0,
      level: "block",
      msg: "cada requisito tiene al menos un escenario",
      ...(noScenario.length ? { detail: noScenario.join(", ") } : {}),
    },
    {
      ok: incomplete.length === 0,
      level: "block",
      msg: "cada escenario tiene Dado, Cuando y Entonces",
      ...(incomplete.length ? { detail: incomplete.join(", ") } : {}),
    },
  ])
}

/** Filas `| engineer | `glob` … |` de la sección «Fronteras». */
export function frontiers(designMd: string): { owner: string; glob: string }[] {
  const sec = section(designMd, /^fronteras/i)
  if (!sec) return []
  const rows: { owner: string; glob: string }[] = []
  for (const line of sec.split("\n")) {
    const m = /^\|\s*([^|]+?)\s*\|\s*(.+?)\s*\|\s*$/.exec(line)
    if (!m) continue
    const owner = (m[1] as string).trim()
    if (/engineer|archivos|responsable/i.test(owner) || /^-+$/.test(owner)) continue
    for (const g of (m[2] as string).match(/`([^`]+)`/g) ?? [])
      rows.push({ owner, glob: g.replace(/`/g, "") })
  }
  return rows
}

/** El texto que fija el contrato: su hash es el `.contract-lock` de la tarea. */
export function contractSection(designMd: string): string | null {
  return section(designMd, /^contrato/i)
}

/** El diseño: contrato no vacío, fronteras disjuntas y, si toca un invariante, su ADR. */
export function validateDesign(
  designMd: string,
  specMd: string,
  ctx: ValidationContext = {},
): DocReport {
  const rows = frontiers(designMd)
  const seen = new Map<string, string>()
  const dup: string[] = []
  for (const r of rows) {
    const other = seen.get(r.glob)
    if (other && other !== r.owner) dup.push(r.glob)
    seen.set(r.glob, r.owner)
  }
  const adr = new RegExp(ctx.adr ?? "ADR-\\w*\\d+")
  const touched = (ctx.invariants ?? []).filter((src) =>
    new RegExp(src, "i").test(`${specMd}\n${designMd}`),
  )
  return report([
    {
      ok: filled(contractSection(designMd)),
      level: "block",
      msg: "sección «Contrato» con contenido",
    },
    { ok: rows.length > 0, level: "block", msg: "sección «Fronteras» con al menos un glob" },
    {
      ok: dup.length === 0,
      level: "block",
      msg: "fronteras disjuntas entre responsables",
      ...(dup.length ? { detail: dup.join(", ") } : {}),
    },
    {
      ok: touched.length === 0 || adr.test(designMd),
      level: "block",
      msg: "si toca un invariante del proyecto, el diseño enlaza su ADR",
      ...(touched.length && !adr.test(designMd) ? { detail: touched.join(", ") } : {}),
    },
    {
      ok: !/\[INFERIDO[^\]]*\][^\n]*\b(decidid|aceptad)/i.test(designMd),
      level: "warn",
      msg: "nada marcado [INFERIDO] presentado como decidido",
    },
  ])
}

// --- el plan de la feature (ADR-0022) ------------------------------------------------

/** Una línea del documento `tasks`: una subtarea con su frontera y sus requisitos. */
export type PlannedTask = {
  /** `T<n>`: el que escribió el agente o el de su posición. */
  key: string
  phase: number
  phase_title: string
  title: string
  frontier: string[]
  requirements: string[]
  /** Dependencias: todas las de la fase anterior más las explícitas («después de T3»). */
  after: string[]
  line: string
}

/**
 * Lee `tasks` con código (ADR-0022 §1): secciones `## Fase N — título` y líneas
 * `- [ ] T1 título → \`glob\` → R1`. Sin secciones de fase, todo es la fase 1.
 */
export function parseTasks(md: string): PlannedTask[] {
  const out: PlannedTask[] = []
  let phase = 1
  let phaseTitle = ""
  let sawPhase = false
  for (const raw of md.split("\n")) {
    const ph = /^##\s+Fase\s+(\d+)\s*(?:[—:–-]\s*(.*))?$/i.exec(raw.trim())
    if (ph) {
      phase = Number(ph[1])
      phaseTitle = (ph[2] ?? "").trim()
      sawPhase = true
      continue
    }
    const item = /^\s*[-*]\s*\[[ xX]\]\s*(.+)$/.exec(raw)
    if (!item) continue
    const body = (item[1] as string).trim()
    const parts = body.split(/\s*(?:→|->)\s*/)
    let head = (parts[0] ?? "").trim()
    const keyMatch = /^(T\d+)\b[.:)]?\s*/.exec(head)
    const key = keyMatch ? (keyMatch[1] as string) : `T${out.length + 1}`
    if (keyMatch) head = head.slice(keyMatch[0].length)
    const rest = parts.slice(1).join(" ")
    const frontier = [...rest.matchAll(/`([^`]+)`/g)].map((m) => m[1] as string)
    const requirements = [...new Set([...rest.matchAll(/\bR\d+\b/g)].map((m) => m[0]))]
    const explicit = /(?:despu[eé]s de|after)\s+((?:T\d+[\s,y]*)+)/i.exec(body)
    const after = explicit ? [...(explicit[1] as string).matchAll(/T\d+/g)].map((m) => m[0]) : []
    out.push({
      key,
      phase: sawPhase ? phase : 1,
      phase_title: phaseTitle,
      title: head.replace(/\s*\((?:despu[eé]s de|after)[^)]*\)\s*$/i, "").trim(),
      frontier,
      requirements,
      after,
      line: raw.trim(),
    })
  }
  // Una fase depende de la anterior entera.
  const phases = [...new Set(out.map((t) => t.phase))].sort((a, b) => a - b)
  for (const t of out) {
    const prev = phases[phases.indexOf(t.phase) - 1]
    const before = prev === undefined ? [] : out.filter((x) => x.phase === prev).map((x) => x.key)
    t.after = [...new Set([...before, ...t.after])]
  }
  return out
}

/** Hay un ciclo en las dependencias del plan; devuelve las llaves que lo forman. */
function cycleIn(tasks: PlannedTask[]): string[] {
  const deps = new Map(tasks.map((t) => [t.key, t.after]))
  const state = new Map<string, 1 | 2>()
  const stack: string[] = []
  const visit = (k: string): string[] | null => {
    if (state.get(k) === 2) return null
    if (state.get(k) === 1) return stack.slice(stack.indexOf(k))
    state.set(k, 1)
    stack.push(k)
    for (const d of deps.get(k) ?? []) {
      const c = visit(d)
      if (c) return c
    }
    stack.pop()
    state.set(k, 2)
    return null
  }
  for (const t of tasks) {
    const c = visit(t.key)
    if (c) return c
  }
  return []
}

/** El plan: cada línea con frontera, fronteras disjuntas, requisitos de la spec y sin ciclos. */
export function validateTasks(md: string, specMd = ""): DocReport {
  const tasks = parseTasks(md)
  const keys = new Set(tasks.map((t) => t.key))
  const dupKeys = tasks.filter((t, i) => tasks.findIndex((x) => x.key === t.key) !== i)
  const noFrontier = tasks.filter((t) => t.frontier.length === 0).map((t) => t.key)
  const owner = new Map<string, string>()
  const overlap: string[] = []
  for (const t of tasks)
    for (const g of t.frontier) {
      const other = owner.get(g)
      if (other && other !== t.key) overlap.push(`${g} (${other}, ${t.key})`)
      owner.set(g, t.key)
    }
  const known = new Set(parseSpec(specMd).map((r) => r.id))
  const unknownReq = specMd
    ? tasks.flatMap((t) => t.requirements.filter((r) => !known.has(r)).map((r) => `${t.key}→${r}`))
    : []
  const noReq = tasks.filter((t) => t.requirements.length === 0).map((t) => t.key)
  const badDeps = tasks.flatMap((t) =>
    t.after.filter((d) => !keys.has(d)).map((d) => `${t.key}→${d}`),
  )
  const cycle = cycleIn(tasks)
  return report([
    { ok: tasks.length > 0, level: "block", msg: "al menos una línea `- [ ] … → `glob` → R1`" },
    {
      ok: dupKeys.length === 0,
      level: "block",
      msg: "cada subtarea tiene una llave distinta",
      ...(dupKeys.length ? { detail: dupKeys.map((t) => t.key).join(", ") } : {}),
    },
    {
      ok: noFrontier.length === 0,
      level: "block",
      msg: "cada línea nombra su frontera de archivos",
      ...(noFrontier.length ? { detail: noFrontier.join(", ") } : {}),
    },
    {
      ok: overlap.length === 0,
      level: "block",
      msg: "las fronteras de las subtareas no se solapan",
      ...(overlap.length ? { detail: overlap.join("; ") } : {}),
    },
    {
      ok: badDeps.length === 0,
      level: "block",
      msg: "las dependencias explícitas nombran subtareas del plan",
      ...(badDeps.length ? { detail: badDeps.join(", ") } : {}),
    },
    {
      ok: cycle.length === 0,
      level: "block",
      msg: "las dependencias no forman un ciclo",
      ...(cycle.length ? { detail: cycle.join(" → ") } : {}),
    },
    {
      ok: noReq.length === 0,
      level: "warn",
      msg: "cada línea cita un requisito de la spec",
      ...(noReq.length ? { detail: noReq.join(", ") } : {}),
    },
    {
      ok: unknownReq.length === 0,
      level: "block",
      msg: "los requisitos citados existen en la spec",
      ...(unknownReq.length ? { detail: unknownReq.join(", ") } : {}),
    },
  ])
}

/**
 * La story de una subtarea, sin agente: su línea, los escenarios de la spec que
 * cita y el contrato congelado del padre (ADR-0022 §1).
 */
export function storyFor(task: PlannedTask, specMd: string, designMd: string): string {
  const reqs = parseSpec(specMd).filter((r) => task.requirements.includes(r.id))
  const scenarios = reqs
    .map(
      (r) =>
        `### ${r.id} — ${r.title}\n${r.scenarios
          .map(
            (s) =>
              `#### Escenario: ${s.title}\n- **Dado** ${s.clauses.dado ?? ""}\n- **Cuando** ${s.clauses.cuando ?? ""}\n- **Entonces** ${s.clauses.entonces ?? ""}`,
          )
          .join("\n")}`,
    )
    .join("\n\n")
  return [
    `# ${task.key} — ${task.title}`,
    "## Qué",
    task.title,
    "## Frontera",
    task.frontier.map((g) => `- \`${g}\``).join("\n") || "- (sin frontera)",
    "## Escenarios",
    scenarios || "(la línea no cita requisitos)",
    "## Contrato congelado",
    contractSection(designMd)?.trim() || "(el diseño no tiene contrato)",
    "## Cómo se cierra",
    "Sólo se tocan archivos de la frontera. Se cierra con QA PASS y sin rojo nuevo; integrar es llevar esta rama a la de la feature.",
  ].join("\n\n")
}

/** Un archivo cae dentro de la frontera si casa con alguno de sus globs. */
export function withinFrontier(path: string, frontier: readonly string[]): boolean {
  return frontier.some((g) => globToRegExp(g).test(path))
}

/** `**` cruza carpetas, `*` no; `?` es un carácter. Suficiente para fronteras de archivos. */
export function globToRegExp(glob: string): RegExp {
  let re = ""
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i] as string
    if (c === "*") {
      if (glob[i + 1] === "*") {
        re += glob[i + 2] === "/" ? "(?:.*/)?" : ".*"
        i += glob[i + 2] === "/" ? 2 : 1
      } else re += "[^/]*"
    } else if (c === "?") re += "[^/]"
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&")
  }
  return new RegExp(`^${re}$`)
}

export const QA_VERDICTS = ["PASS", "CONCERNS", "FAIL", "WAIVED"] as const
export type QaVerdict = (typeof QA_VERDICTS)[number]

export function qaVerdict(md: string): QaVerdict | null {
  const m = /Veredicto:\s*\**\s*(PASS|CONCERNS|FAIL|WAIVED)/i.exec(md)
  return m ? ((m[1] as string).toUpperCase() as QaVerdict) : null
}

/** La revisión deja cerrar con PASS, CONCERNS o WAIVED justificado; FAIL vuelve a implementar. */
export function validateQa(md: string): DocReport {
  const v = qaVerdict(md)
  // Al menos 20 caracteres de texto después de «Justificación», no sólo el título.
  const why = /justificaci[oó]n[^\n]*\n?([\s\S]{0,800})/i.exec(md)?.[1] ?? ""
  const waivedOk = v !== "WAIVED" || why.replace(/\s/g, "").length >= 20
  return report([
    { ok: v !== null, level: "block", msg: "veredicto PASS, CONCERNS, FAIL o WAIVED" },
    {
      ok: v !== "FAIL",
      level: "block",
      msg: "el veredicto no es FAIL",
      ...(v ? { detail: v } : {}),
    },
    { ok: waivedOk, level: "block", msg: "WAIVED lleva su justificación" },
  ])
}

/** Valida un documento según su tipo; los que no tienen forma fija pasan. */
export function validateDoc(
  kind: TaskDocKind,
  md: string,
  others: Partial<Record<TaskDocKind, string>> = {},
  ctx: ValidationContext = {},
): DocReport {
  switch (kind) {
    case "brief":
      return validateBrief(md)
    case "spec":
      return validateSpec(md)
    case "design":
      return validateDesign(md, others.spec ?? "", ctx)
    case "qa":
      return validateQa(md)
    case "tasks":
      return validateTasks(md, others.spec ?? "")
    default:
      return { ok: md.trim().length > 0, checks: [] }
  }
}

// --- verificación delta-verde ------------------------------------------------------

/** Un comando de verificación del proyecto (lint, typecheck, test, build…). */
export type VerifyCheck = { name: string; ok: boolean }

/**
 * «Verde» es no introducir rojo nuevo: lo que pasaba en el baseline y ahora
 * falla. La deuda que ya estaba roja no bloquea, pero se reporta.
 */
export function verifyDelta(
  baseline: readonly VerifyCheck[] | null,
  now: readonly VerifyCheck[],
): { green: boolean; newRed: string[]; stillRed: string[]; fixed: string[] } {
  const before = new Map((baseline ?? []).map((c) => [c.name, c.ok]))
  const newRed = now.filter((c) => !c.ok && before.get(c.name) !== false).map((c) => c.name)
  const stillRed = now.filter((c) => !c.ok && before.get(c.name) === false).map((c) => c.name)
  const fixed = now.filter((c) => c.ok && before.get(c.name) === false).map((c) => c.name)
  return { green: newRed.length === 0, newRed, stillRed, fixed }
}
