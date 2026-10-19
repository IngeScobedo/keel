/** Proyecta los tokens canónicos de pen.dev a CSS; no introduce nuevos valores. */
type Token = {
  type: string
  value: string | number | { value: string | number; theme: { mode: string } }[]
}
const source = new URL("../../../docs/design/tokens.json", import.meta.url)
const target = new URL("../src/tokens.css", import.meta.url)
const data: { variables: Record<string, Token> } = await Bun.file(source).json()
const output = ["/* Generado desde docs/design/tokens.json. Fuente visual: pen.dev; ADR-0001. */"]
for (const mode of ["dark", "light"]) {
  output.push(mode === "dark" ? ":root {" : ':root[data-theme="light"] {')
  for (const [key, token] of Object.entries(data.variables)) {
    let value = Array.isArray(token.value)
      ? token.value.find((entry) => entry.theme.mode === mode)?.value
      : token.value
    if (value === undefined) throw new Error(`Falta ${key} para ${mode}`)
    if (typeof value === "number" && !key.endsWith("/line") && key !== "icon/stroke")
      value = `${value}px`
    if (key.startsWith("font/")) value = `"${value}"`
    output.push(`  --${key.replaceAll("/", "-").replaceAll("_", "-")}: ${value};`)
  }
  output.push("}")
}
await Bun.write(target, `${output.join("\n")}\n`)
const result = Bun.spawn(["bunx", "biome", "format", target.pathname, "--write"], {
  stdout: "inherit",
  stderr: "inherit",
})
if ((await result.exited) !== 0) throw new Error("No se pudo formatear la proyección CSS")
