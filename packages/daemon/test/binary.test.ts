import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { claudeCandidates, detectClaudeBinary } from "../src/index.ts"

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe("ADR-0002 regla 3: se detecta el claude instalado, no se bundlea", () => {
  test("orden: KEEL_CLAUDE_PATH, instalador nativo y PATH; en Windows sólo claude.exe y Path con «;»", () => {
    expect(
      claudeCandidates({
        platform: "linux",
        env: { KEEL_CLAUDE_PATH: "/opt/c", PATH: "/a:/b" },
        home: "/h",
      }),
    ).toEqual([
      "/opt/c",
      join("/h", ".local", "bin", "claude"),
      "/usr/local/bin/claude",
      "/usr/bin/claude",
      join("/a", "claude"),
      join("/b", "claude"),
    ])
    expect(
      claudeCandidates({ platform: "win32", env: { Path: "C:/x;C:/y" }, home: "C:/Users/a" }),
    ).toEqual([
      join("C:/Users/a", ".local", "bin", "claude.exe"),
      join("C:/x", "claude.exe"),
      join("C:/y", "claude.exe"),
    ])
  })

  test("encuentra el que existe en el PATH y devuelve null si no hay ninguno", () => {
    const home = mkdtempSync(join(tmpdir(), "keel-bin-"))
    dirs.push(home)
    const bin = join(home, "otro-bin")
    mkdirSync(bin)
    const exe = process.platform === "win32" ? "claude.exe" : "claude"
    const env = { PATH: bin, Path: bin }
    expect(detectClaudeBinary({ env, home })).toBeNull()
    writeFileSync(join(bin, exe), "")
    expect(detectClaudeBinary({ env, home })).toBe(join(bin, exe))
  })
})
