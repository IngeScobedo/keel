/**
 * Redacción de secretos en el borde de la ingesta (SDD 03 §5, ADR-0004 §3,
 * ADR-0004 de Mirador §4).
 *
 * El payload se guarda «íntegro y saneado»: se conservan todas las claves y la
 * forma del JSON, y sólo se reemplazan los valores que parecen secretos. Es
 * **best-effort**: reglas versionadas probadas con fixtures, nunca una garantía
 * de ausencia de secretos. Pura y sin I/O, para que la use cualquier harness.
 *
 * Cada reemplazo deja un `hit` con la ruta y la regla, nunca el valor.
 */

/** Sube cuando cambian las reglas; se registra junto a cada redacción. */
export const REDACTION_RULES_VERSION = 1

export type RedactionHit = {
  /** Ruta JSON (`$.tool_input.command`). */
  path: string
  rule: string
}

const MARK = (rule: string) => `[REDACTED:${rule}]`

/**
 * Claves cuyo valor se reemplaza entero. Anclado al final para no tocar
 * contadores como `input_tokens` o `max_tokens`.
 */
const SECRET_KEY =
  /(^|[_-])(authorization|proxy[_-]?authorization|cookie|set[_-]?cookie|password|passwd|secret|client[_-]?secret|token|access[_-]?token|refresh[_-]?token|id[_-]?token|auth[_-]?token|api[_-]?key|apikey|x[_-]?api[_-]?key|private[_-]?key)$/i

type ValueRule = { name: string; re: RegExp; replace: (m: string, ...g: string[]) => string }

const VALUE_RULES: ValueRule[] = [
  {
    name: "private_key",
    re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    replace: () => MARK("private_key"),
  },
  {
    name: "bearer",
    re: /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/g,
    replace: (_m, scheme) => `${scheme} ${MARK("bearer")}`,
  },
  {
    // usuario:contraseña@ en una URL: se conserva el usuario.
    name: "url_password",
    re: /\b([a-z][a-z0-9+.-]*:\/\/)([^/\s:@]+):([^/\s@]+)@/gi,
    replace: (_m, scheme, user) => `${scheme}${user}:${MARK("url_password")}@`,
  },
  {
    name: "anthropic_key",
    re: /\bsk-ant-[A-Za-z0-9_-]{10,}/g,
    replace: () => MARK("anthropic_key"),
  },
  {
    name: "openai_key",
    re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/g,
    replace: () => MARK("openai_key"),
  },
  {
    name: "github_token",
    re: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{20,})/g,
    replace: () => MARK("github_token"),
  },
  {
    name: "aws_access_key",
    re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
    replace: () => MARK("aws_access_key"),
  },
  {
    name: "slack_token",
    re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
    replace: () => MARK("slack_token"),
  },
  {
    name: "google_api_key",
    re: /\bAIza[0-9A-Za-z_-]{35}\b/g,
    replace: () => MARK("google_api_key"),
  },
  {
    // VARIABLE=valor en comandos de shell, cuando el nombre termina en una palabra de secreto.
    name: "env_assignment",
    re: /\b([A-Z][A-Z0-9_]*(?:API_KEY|SECRET|TOKEN|PASSWORD|PASSWD|_PAT|PRIVATE_KEY))=("[^"]*"|'[^']*'|[^\s"';&|]+)/g,
    replace: (_m, name) => `${name}=${MARK("env_assignment")}`,
  },
]

function redactString(s: string, path: string, hits: RedactionHit[]): string {
  let out = s
  for (const rule of VALUE_RULES) {
    rule.re.lastIndex = 0
    if (!rule.re.test(out)) continue
    rule.re.lastIndex = 0
    out = out.replace(rule.re, (...args) => {
      hits.push({ path, rule: rule.name })
      return rule.replace(...(args as [string, ...string[]]))
    })
  }
  return out
}

function walk(value: unknown, path: string, hits: RedactionHit[]): unknown {
  if (typeof value === "string") return redactString(value, path, hits)
  if (Array.isArray(value)) return value.map((v, i) => walk(v, `${path}[${i}]`, hits))
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const p = `${path}.${k}`
      if (
        SECRET_KEY.test(k) &&
        (typeof v === "string" || typeof v === "number") &&
        String(v) !== ""
      ) {
        hits.push({ path: p, rule: "secret_key" })
        out[k] = MARK("secret_key")
      } else out[k] = walk(v, p, hits)
    }
    return out
  }
  return value
}

/**
 * Devuelve una copia con los secretos reemplazados y la lista de reemplazos.
 * Si no hay ninguno, `value` es estructuralmente igual a la entrada.
 */
export function redact<T>(value: T): { value: T; hits: RedactionHit[] } {
  const hits: RedactionHit[] = []
  const out = walk(value, "$", hits) as T
  return { value: out, hits }
}
