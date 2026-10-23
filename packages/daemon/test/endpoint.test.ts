import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import { defaultEndpoint, defaultWorktreesDir, isNamedPipe } from "../src/index.ts"

describe("ADR-0005 §1: endpoint por plataforma", () => {
  test("POSIX: socket bajo XDG_RUNTIME_DIR o, si no está, bajo ~/.keel", () => {
    expect(
      defaultEndpoint({
        platform: "linux",
        env: { XDG_RUNTIME_DIR: "/run/user/1000" },
        home: "/h",
      }),
    ).toBe(join("/run/user/1000", "keel", "keel.sock"))
    expect(defaultEndpoint({ platform: "darwin", env: {}, home: "/Users/a" })).toBe(
      join("/Users/a", ".keel", "keel.sock"),
    )
  })

  test("Windows: AF_UNIX bajo LOCALAPPDATA, no Named Pipe (ADR-0005 §1, revisión 2026-10-23)", () => {
    const sock = defaultEndpoint({
      platform: "win32",
      env: { LOCALAPPDATA: "C:/Users/a/AppData/Local" },
    })
    expect(sock).toBe(join("C:/Users/a/AppData/Local", "keel", "keel.sock"))
    expect(isNamedPipe(sock)).toBe(false)
    expect(isNamedPipe("\\\\.\\pipe\\keel-x")).toBe(true)
  })

  test("worktrees: XDG_STATE_HOME en POSIX y LOCALAPPDATA en Windows", () => {
    expect(defaultWorktreesDir("linux", { XDG_STATE_HOME: "/s" })).toBe(
      join("/s", "keel", "worktrees"),
    )
    expect(defaultWorktreesDir("win32", { LOCALAPPDATA: "C:/Users/a/AppData/Local" })).toBe(
      join("C:/Users/a/AppData/Local", "keel", "worktrees"),
    )
  })
})
