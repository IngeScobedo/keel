/**
 * El riesgo de un comando SSH (ADR-0032): Keel lo decide con código antes de
 * mandarlo. Se analizan tokens de shell, no texto: comillas, operadores,
 * redirecciones y sustituciones. Lo desconocido nunca es lectura y lo que no
 * se puede analizar es destructivo. Puro: sin I/O.
 */

export const SSH_RISK_CLASSES = ["read", "service", "destructive"] as const
export type SshRiskClass = (typeof SSH_RISK_CLASSES)[number]

export type SshRisk = {
  class: SshRiskClass
  /** El segmento que decidió la clase, tal como se escribió. */
  segment: string
  /** Por qué, en una línea. */
  reason: string
  /**
   * Programa y subcomando de cada segmento que no es lectura (`systemctl restart`),
   * ordenados: lo que cubre una aprobación «para la tarea».
   */
  programs: string[]
}

type Word = { text: string; quoted: boolean }
type Token = { op: string } | { word: Word } | { redirect: string; target: string }
type Segment = { words: Word[]; redirects: { op: string; target: string }[]; raw: string }

const RANK: Record<SshRiskClass, number> = { read: 0, service: 1, destructive: 2 }

class Unparseable extends Error {}

/** Tokens de shell: palabras con sus comillas resueltas, operadores y redirecciones. */
function tokenize(cmd: string, subs: string[]): Token[] {
  const out: Token[] = []
  let i = 0
  const n = cmd.length
  while (i < n) {
    const c = cmd[i] as string
    if (c === " " || c === "\t") {
      i++
      continue
    }
    if (c === "\n") {
      out.push({ op: ";" })
      i++
      continue
    }
    if (c === "#") {
      while (i < n && cmd[i] !== "\n") i++
      continue
    }
    const two = cmd.slice(i, i + 2)
    if (two === "<<") throw new Unparseable("heredoc")
    if (two === "&&" || two === "||" || two === ";;") {
      out.push({ op: two })
      i += 2
      continue
    }
    if (c === "|" || c === ";" || c === "&" || c === "(" || c === ")") {
      // `&>` es redirección, no fondo.
      if (c === "&" && cmd[i + 1] === ">") {
        i += cmd[i + 2] === ">" ? 3 : 2
        out.push({ redirect: ">", target: readWord(true).text })
        continue
      }
      out.push({ op: c === "(" || c === ")" ? ";" : c })
      i++
      continue
    }
    // Redirecciones: [n]>, [n]>>, [n]<, >&n.
    const redir = /^(\d*)(>>|>\||>&|>|<&|<)/.exec(cmd.slice(i))
    if (redir) {
      i += redir[0].length
      const op = redir[2] as string
      const target = readWord(true).text
      out.push({ redirect: op.startsWith("<") ? "<" : op === ">&" ? ">&" : ">", target })
      continue
    }
    out.push({ word: readWord(false) })
  }
  return out

  function readWord(required: boolean): Word {
    while (i < n && (cmd[i] === " " || cmd[i] === "\t")) i++
    let text = ""
    let quoted = false
    while (i < n) {
      const c = cmd[i] as string
      if (" \t\n|;&()<>".includes(c)) break
      if (c === "\\") {
        if (i + 1 >= n) throw new Unparseable("barra al final")
        text += cmd[i + 1]
        i += 2
        continue
      }
      if (c === "'") {
        const end = cmd.indexOf("'", i + 1)
        if (end < 0) throw new Unparseable("comilla sin cerrar")
        text += cmd.slice(i + 1, end)
        quoted = true
        i = end + 1
        continue
      }
      if (c === '"') {
        let j = i + 1
        let body = ""
        while (j < n && cmd[j] !== '"') {
          if (cmd[j] === "\\" && j + 1 < n) {
            body += cmd[j + 1]
            j += 2
            continue
          }
          if (cmd[j] === "`" || (cmd[j] === "$" && cmd[j + 1] === "(")) {
            const [inner, next] = substitution(cmd, j)
            subs.push(inner)
            body += "$SUB"
            j = next
            continue
          }
          body += cmd[j]
          j++
        }
        if (j >= n) throw new Unparseable("comilla sin cerrar")
        text += body
        quoted = true
        i = j + 1
        continue
      }
      if (c === "`" || (c === "$" && cmd[i + 1] === "(")) {
        const [inner, next] = substitution(cmd, i)
        subs.push(inner)
        text += "$SUB"
        i = next
        continue
      }
      text += c
      i++
    }
    if (required && text === "") throw new Unparseable("redirección sin destino")
    return { text, quoted }
  }
}

/** `$(…)` o `` `…` ``: el comando de adentro y dónde sigue el de afuera. */
function substitution(cmd: string, at: number): [string, number] {
  if (cmd[at] === "`") {
    const end = cmd.indexOf("`", at + 1)
    if (end < 0) throw new Unparseable("sustitución sin cerrar")
    return [cmd.slice(at + 1, end), end + 1]
  }
  let depth = 0
  let quote: string | null = null
  for (let j = at + 1; j < cmd.length; j++) {
    const c = cmd[j]
    if (quote) {
      if (c === quote) quote = null
      continue
    }
    if (c === "'" || c === '"') quote = c
    else if (c === "(") depth++
    else if (c === ")") {
      depth--
      if (depth === 0) return [cmd.slice(at + 2, j), j + 1]
    }
  }
  throw new Unparseable("sustitución sin cerrar")
}

function segments(tokens: Token[]): Segment[] {
  const out: Segment[] = []
  let cur: Segment = { words: [], redirects: [], raw: "" }
  const flush = () => {
    if (cur.words.length || cur.redirects.length) out.push(cur)
    cur = { words: [], redirects: [], raw: "" }
  }
  for (const t of tokens) {
    if ("op" in t) flush()
    else if ("word" in t) cur.words.push(t.word)
    else cur.redirects.push({ op: t.redirect, target: t.target })
  }
  flush()
  for (const s of out)
    s.raw = [
      ...s.words.map((w) => (w.quoted || /\s/.test(w.text) ? JSON.stringify(w.text) : w.text)),
      ...s.redirects.map((r) => `${r.op} ${r.target}`),
    ].join(" ")
  return out
}

// --- listas --------------------------------------------------------------------------

/** Programas que sólo leen, con lo que los haría escribir o correr otra cosa. */
const READ_PROGRAMS: Record<string, (args: string[]) => boolean> = {
  ls: () => true,
  cat: () => true,
  head: () => true,
  tail: () => true,
  less: () => true,
  grep: () => true,
  egrep: () => true,
  fgrep: () => true,
  zgrep: () => true,
  zcat: () => true,
  wc: () => true,
  sort: (a) => !a.some((x) => x === "-o" || x.startsWith("--output")),
  uniq: (a) => a.filter((x) => !x.startsWith("-")).length <= 1,
  cut: () => true,
  tr: () => true,
  column: () => true,
  df: () => true,
  du: () => true,
  free: () => true,
  uptime: () => true,
  ps: () => true,
  top: (a) => a.includes("-b"),
  ss: () => true,
  netstat: () => true,
  lsof: () => true,
  lsblk: () => true,
  stat: () => true,
  file: () => true,
  which: () => true,
  whoami: () => true,
  id: () => true,
  hostname: (a) => a.every((x) => x.startsWith("-")),
  uname: () => true,
  date: (a) => !a.some((x) => x === "-s" || x.startsWith("--set")),
  pwd: () => true,
  echo: () => true,
  printf: () => true,
  true: () => true,
  test: () => true,
  w: () => true,
  who: () => true,
  last: () => true,
  dmesg: (a) => !a.some((x) => /^-[a-zA-Z]*[cC]/.test(x) || x === "--clear"),
  find: (a) =>
    !a.some((x) =>
      ["-delete", "-exec", "-execdir", "-ok", "-okdir", "-fprint", "-fprintf", "-fls"].includes(x),
    ),
  journalctl: (a) =>
    !a.some((x) => x.startsWith("--vacuum") || x === "--rotate" || x === "--flush"),
  systemctl: (a) =>
    [
      "status",
      "is-active",
      "is-enabled",
      "is-failed",
      "list-units",
      "list-timers",
      "show",
      "cat",
    ].includes(sub(a) ?? ""),
  docker: (a) => {
    const s = sub(a)
    if (s === "compose") return ["ps", "logs", "config", "ls", "images"].includes(sub(a, 1) ?? "")
    if (s === "stats") return a.includes("--no-stream")
    return ["ps", "logs", "inspect", "images", "version", "info", "top", "port"].includes(s ?? "")
  },
  pm2: (a) => {
    const s = sub(a)
    if (s === "logs") return a.includes("--nostream")
    return ["list", "ls", "status", "describe", "show", "jlist", "prettylist"].includes(s ?? "")
  },
  git: (a) =>
    ["status", "log", "diff", "show", "rev-parse", "describe", "remote", "branch"].includes(
      sub(a) ?? "",
    ) &&
    !a.some((x) => ["-d", "-D", "--delete", "-m", "-M", "set-url", "add", "remove"].includes(x)),
  ip: (a) =>
    ["a", "addr", "address", "r", "route", "link", "-br"].includes(sub(a) ?? "") &&
    !a.some((x) => ["add", "del", "set", "flush"].includes(x)),
  nginx: (a) => a.includes("-t") || a.includes("-T") || a.includes("-v") || a.includes("-V"),
}

/** El primer argumento que no es opción, desde el n-ésimo. */
function sub(args: string[], nth = 0): string | undefined {
  return args.filter((a) => !a.startsWith("-"))[nth]
}

/** ¿Este segmento borra datos o deja el sistema sin servicio? Devuelve el motivo. */
function destructive(prog: string, args: string[], all: string[]): string | null {
  const flags = args.filter((a) => a.startsWith("-"))
  const hasShort = (ch: string) => flags.some((f) => /^-[a-zA-Z]+$/.test(f) && f.includes(ch))
  if (prog === "rm" && (hasShort("r") || hasShort("R") || flags.includes("--recursive")))
    return "rm recursivo"
  if (prog === "dd") return "dd escribe bloques crudos"
  if (prog.startsWith("mkfs") || prog === "wipefs" || prog === "fdisk" || prog === "parted")
    return `${prog} toca discos`
  if (["shutdown", "reboot", "halt", "poweroff"].includes(prog)) return `${prog} apaga el servidor`
  if (prog === "init" && (args[0] === "0" || args[0] === "6")) return "init apaga el servidor"
  if (prog === "systemctl" && ["poweroff", "reboot", "halt", "kexec"].includes(sub(args) ?? ""))
    return "systemctl apaga el servidor"
  if (
    (prog === "iptables" || prog === "ip6tables" || prog === "nft") &&
    args.some((a) => a === "-F" || a === "--flush" || a === "-X" || a === "flush")
  )
    return `${prog} vacía el firewall`
  if (prog === "ufw" && (sub(args) === "disable" || sub(args) === "reset"))
    return "ufw deja el firewall abierto"
  if (prog === "kill" || prog === "pkill" || prog === "killall") {
    if (prog === "kill" && args.filter((a) => !a.startsWith("-")).includes("1"))
      return "kill a init"
    if (args.some((a) => a === "-9" || a === "-KILL" || a === "-SIGKILL") && prog !== "kill")
      return `${prog} -9`
  }
  if (prog === "docker") {
    const s = sub(args)
    if (s === "system" && sub(args, 1) === "prune") return "docker system prune"
    if (
      (s === "volume" || s === "image" || s === "network") &&
      ["prune", "rm"].includes(sub(args, 1) ?? "")
    )
      return `docker ${s} ${sub(args, 1)}`
    if (
      s === "compose" &&
      sub(args, 1) === "down" &&
      args.some((a) => a === "-v" || a === "--volumes")
    )
      return "docker compose down -v borra los volúmenes"
  }
  // Recursivo sobre la raíz o un directorio de primer nivel (`/etc`, `/var`).
  const recursive = hasShort("R") || flags.includes("--recursive")
  if ((prog === "chmod" || prog === "chown") && recursive)
    if (args.some((a) => /^\/([^/]+\/?)?$/.test(a) && a !== "/tmp" && a !== "/tmp/"))
      return `${prog} -R sobre el sistema`
  if (prog === "truncate") return "truncate vacía archivos"
  if (prog === "shred") return "shred destruye archivos"
  // SQL que destruye, por psql o dentro de un docker exec.
  if (all.includes("psql") || prog === "psql" || prog === "mysql")
    if (all.some((a) => /\b(drop\s+(table|database|schema)|truncate)\b/i.test(a)))
      return "SQL que borra (DROP o TRUNCATE)"
  return null
}

/** Programa y subcomando: lo que cubre una aprobación de la tarea. */
function programKey(prog: string, args: string[]): string {
  if (prog === "docker" && sub(args) === "compose")
    return `docker compose ${sub(args, 1) ?? ""}`.trim()
  if (
    [
      "systemctl",
      "docker",
      "pm2",
      "git",
      "service",
      "apt",
      "apt-get",
      "npm",
      "bun",
      "kubectl",
    ].includes(prog)
  )
    return `${prog} ${sub(args) ?? ""}`.trim()
  if (prog === "nginx")
    return args.includes("-s") ? `nginx -s ${args[args.indexOf("-s") + 1] ?? ""}` : "nginx"
  return prog
}

function classifySegment(s: Segment): { cls: SshRiskClass; reason: string; key: string | null } {
  // Las asignaciones `FOO=bar` del principio no son el programa.
  let words = s.words.map((w) => w.text)
  while (words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0] as string)) words = words.slice(1)
  let elevated = false
  while (
    words[0] === "sudo" ||
    words[0] === "doas" ||
    words[0] === "nohup" ||
    words[0] === "time"
  ) {
    if (words[0] === "sudo" || words[0] === "doas") elevated = true
    words = words.slice(1)
    if (elevated) while (words[0]?.startsWith("-")) words = words.slice(words[0] === "-u" ? 2 : 1)
  }
  if (words.length === 0) return { cls: "service", reason: "sin programa", key: null }
  const prog = (words[0] as string).split("/").pop() as string
  const args = words.slice(1)
  const bad = destructive(prog, args, words)
  if (bad) return { cls: "destructive", reason: bad, key: programKey(prog, args) }
  for (const r of s.redirects)
    if (r.op === ">" && /^\/dev\/(sd|nvme|vd|xvd|hd|disk)/.test(r.target))
      return { cls: "destructive", reason: "escribe sobre un disco", key: programKey(prog, args) }
  const writes = s.redirects.some((r) => r.op === ">" && r.target !== "/dev/null")
  if (writes)
    return { cls: "service", reason: "redirige a un archivo", key: programKey(prog, args) }
  if (prog.includes("$"))
    return { cls: "service", reason: "el programa sale de una variable", key: null }
  if (elevated) return { cls: "service", reason: "corre con sudo", key: programKey(prog, args) }
  const read = READ_PROGRAMS[prog]
  if (read?.(args)) return { cls: "read", reason: "sólo lectura", key: null }
  return {
    cls: "service",
    reason: read ? `${prog} con argumentos que escriben` : `${prog} no está en la lista de lectura`,
    key: programKey(prog, args),
  }
}

/**
 * La clase del comando: la del segmento más riesgoso. Un comando que no se puede
 * analizar (comillas sin cerrar, heredoc) es destructivo.
 */
export function classifySshCommand(command: string): SshRisk {
  const subs: string[] = []
  let segs: Segment[]
  try {
    segs = segments(tokenize(command, subs))
  } catch (e) {
    return {
      class: "destructive",
      segment: command,
      reason: `no se pudo analizar (${e instanceof Unparseable ? e.message : "error"})`,
      programs: [],
    }
  }
  if (segs.length === 0)
    return { class: "service", segment: command, reason: "comando vacío", programs: [] }
  let worst: SshRisk = { class: "read", segment: command, reason: "sólo lectura", programs: [] }
  const programs = new Set<string>()
  for (const s of segs) {
    const r = classifySegment(s)
    if (r.key && r.cls !== "read") programs.add(r.key)
    if (RANK[r.cls] > RANK[worst.class])
      worst = { class: r.cls, segment: s.raw, reason: r.reason, programs: [] }
  }
  // Lo de adentro de `$(…)` corre también: cuenta como un segmento más.
  for (const inner of subs) {
    const r = classifySshCommand(inner)
    for (const p of r.programs) programs.add(p)
    if (RANK[r.class] > RANK[worst.class]) worst = { ...r, programs: [] }
    else if (worst.class === "read")
      worst = { class: "service", segment: inner, reason: "sustitución de comandos", programs: [] }
  }
  return { ...worst, programs: [...programs].sort() }
}

/** ¿La aprobación de la tarea (sus programas) cubre este comando de servicio? */
export function sshProgramsCovered(granted: readonly string[], risk: SshRisk): boolean {
  return (
    risk.class === "service" &&
    risk.programs.length > 0 &&
    risk.programs.every((p) => granted.includes(p))
  )
}
