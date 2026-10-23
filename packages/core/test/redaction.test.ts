import { describe, expect, test } from "bun:test"
import { REDACTION_RULES_VERSION, redact } from "../src/index.ts"

// Valores falsos con la forma de los reales; ninguno es una credencial. Se arman por
// partes para que ningún escáner de secretos los tome por reales en el repo.
const j = (...parts: string[]) => parts.join("")
const FAKE = {
  anthropic: j("sk-", "ant-api03-", "A".repeat(40)),
  openai: j("sk-", "proj-", "b".repeat(40)),
  github: j("gh", "p_", "C".repeat(36)),
  aws: j("AK", "IA", "ABCDEFGHIJKLMNOP"),
  slack: j("xo", "xb-", "1".repeat(12), "-abc"),
  google: j("AI", "za", "D".repeat(35)),
}

describe("SDD 03 §5: redacción best-effort en el borde de la ingesta", () => {
  test("las reglas están versionadas", () => {
    expect(REDACTION_RULES_VERSION).toBeGreaterThanOrEqual(1)
  })

  test("un hook con secretos conserva todas las claves y sólo reemplaza los valores", () => {
    const hook = {
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: {
        command: `curl -H "Authorization: Bearer ${"t".repeat(30)}" https://admin:hunter2@db.example.com/x && GITHUB_TOKEN=${FAKE.github} gh pr list`,
        description: "lista PRs",
      },
      headers: { Authorization: "Basic dXNlcjpwYXNz", "x-api-key": FAKE.anthropic },
      env: { OPENAI_API_KEY: FAKE.openai, PATH: "/usr/bin" },
    }
    const { value, hits } = redact(hook)
    const out = JSON.stringify(value)
    for (const secret of [...Object.values(FAKE), "hunter2", "dXNlcjpwYXNz", "t".repeat(30)])
      expect(out).not.toContain(secret)
    expect(Object.keys(value.tool_input)).toEqual(["command", "description"])
    expect(value.tool_input.command).toContain("admin:[REDACTED:url_password]@db.example.com")
    expect(value.tool_input.command).toContain("GITHUB_TOKEN=[REDACTED:env_assignment]")
    expect(value.env.PATH).toBe("/usr/bin")
    expect(value.tool_input.description).toBe("lista PRs")
    expect(hits.map((h) => h.path)).toContain("$.headers.Authorization")
    expect(JSON.stringify(hits)).not.toContain(FAKE.anthropic)
  })

  test.each(Object.entries(FAKE))("formato de token conocido: %s", (_name, secret) => {
    const { value, hits } = redact({ text: `antes ${secret} después` })
    expect(value.text).not.toContain(secret)
    expect(value.text).toStartWith("antes ")
    expect(hits).toHaveLength(1)
  })

  test("clave privada PEM completa", () => {
    const pem =
      "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n-----END OPENSSH PRIVATE KEY-----"
    expect(redact({ file: `x\n${pem}\ny` }).value.file).toBe("x\n[REDACTED:private_key]\ny")
  })

  test("no toca lo que no es secreto: contadores de tokens, ids, hashes ni rutas", () => {
    const benign = {
      usage: {
        input_tokens: 1200,
        output_tokens: 80,
        cache_read_input_tokens: 5,
        max_tokens: 4096,
      },
      session_id: "f3c2a1b0-1234-4abc-9def-0123456789ab",
      uuid: "0198f3c2-a1b0-7234-8abc-9def01234567",
      tool_use_id: "toolu_01ABCDEFGHIJKLMNOPQRSTUV",
      sha: "16db984f931135e7277ce59a5ef4889477e0fea5",
      command: "MAX_TOKENS=100 bun test && git log --oneline",
      path: "/home/amara/projects/self/keel/packages/core/src/redaction.ts",
      token_count: 3,
      tokens: ["a", "b"],
      password_hint: null,
    }
    const { value, hits } = redact(benign)
    expect(hits).toEqual([])
    expect(value).toEqual(benign)
  })
})
