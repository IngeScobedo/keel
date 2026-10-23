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
    ).toBe("/run/user/1000/keel/keel.sock")
    expect(defaultEndpoint({ platform: "darwin", env: {}, home: "/Users/a" })).toBe(
      "/Users/a/.keel/keel.sock",
    )
  })

  test("Windows: Named Pipe por usuario, con el nombre saneado", () => {
    const pipe = defaultEndpoint({ platform: "win32", env: {}, user: "Ana María" })
    expect(pipe).toBe("\\\\.\\pipe\\keel-daemon-Ana_Mar_a")
    expect(isNamedPipe(pipe)).toBe(true)
    expect(isNamedPipe("/run/user/1000/keel/keel.sock")).toBe(false)
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
