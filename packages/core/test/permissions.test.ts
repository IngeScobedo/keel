import { describe, expect, test } from "bun:test"
import { describePattern, matchesPattern, patternFor, shellCommand } from "../src/index.ts"

describe("ADR-0019 §4: patrones de permiso", () => {
  test("un comando simple propone su prefijo de dos palabras", () => {
    const p = patternFor("Bash", { command: "git status --short" })
    expect(p).toEqual({ tool: "Bash", prefix: "git status", exact: false })
    expect(describePattern(p)).toBe("Bash(git status:*)")
    expect(matchesPattern(p, "Bash", { command: "git status" })).toBe(true)
    expect(matchesPattern(p, "Bash", { command: "git status -s" })).toBe(true)
    expect(matchesPattern(p, "Bash", { command: "git statusx" })).toBe(false)
    expect(matchesPattern(p, "Bash", { command: "git push" })).toBe(false)
  })
  test("un prefijo nunca deja pasar un encadenamiento", () => {
    const p = patternFor("Bash", { command: "git status" })
    for (const command of [
      "git status; rm -rf ~",
      "git status && curl x",
      "git status | sh",
      "git status > /etc/x",
      "git status $(rm -rf ~)",
      "git status `id`",
      "git status\nrm -rf ~",
    ])
      expect(matchesPattern(p, "Bash", { command })).toBe(false)
  })
  test("un comando compuesto sólo se aprueba exacto", () => {
    const p = patternFor("Bash", { command: "cd app && bun test" })
    expect(p.exact).toBe(true)
    expect(matchesPattern(p, "Bash", { command: "cd app && bun test" })).toBe(true)
    expect(matchesPattern(p, "Bash", { command: "cd app && bun test && rm -rf ~" })).toBe(false)
  })
  test("el envoltorio de codex no se convierte en prefijo universal", () => {
    expect(shellCommand({ command: "/bin/bash -lc 'ls -la'" })).toBe("ls -la")
    const p = patternFor("Bash", { command: "/bin/bash -lc 'ls -la'" })
    expect(p.prefix).toBe("ls")
    expect(matchesPattern(p, "Bash", { command: "/bin/bash -lc 'rm -rf x'" })).toBe(false)
    expect(matchesPattern(p, "Bash", { command: "/bin/bash -lc 'ls src'" })).toBe(true)
  })
  test("otras herramientas cubren la herramienta entera; la flag no es prefijo", () => {
    expect(patternFor("Write", { file_path: "a.ts" })).toEqual({
      tool: "Write",
      prefix: null,
      exact: false,
    })
    expect(patternFor("Bash", { command: "ls -la" }).prefix).toBe("ls")
  })
})
