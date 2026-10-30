import { describe, expect, test } from "bun:test"
import { parseAnsi } from "../src/ansi.js"

describe("ADR-0044: la pantalla de tmux con sus colores", () => {
  test("SGR base, 256, 24 bits y reset; lo que no es SGR se descarta", () => {
    const spans = parseAnsi(
      "\x1b[1mhola\x1b[0m \x1b[31mrojo\x1b[39m \x1b[38;5;196mx\x1b[38;2;215;119;87my\x1b[m\x1b(Bfin",
    )
    expect(spans).toEqual([
      { text: "hola", style: { bold: true } },
      { text: " ", style: {} },
      { text: "rojo", style: { fg: "var(--color-status-failed)" } },
      { text: " ", style: {} },
      { text: "x", style: { fg: "rgb(255 0 0)" } },
      { text: "y", style: { fg: "rgb(215 119 87)" } },
      { text: "fin", style: {} },
    ])
  })
})
