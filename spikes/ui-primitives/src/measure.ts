/**
 * Construye el mismo conjunto de controles (diálogo, select, checkbox, switch, popover,
 * menú, pestañas, tooltip) con cada librería y mide el JS que agrega sobre React solo.
 * También lo renderiza en el servidor: si una pieza no existe, React falla y se ve.
 */
import { readdirSync, readFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import { gzipSync } from "node:zlib"
import react from "@vitejs/plugin-react"
import { build } from "vite"

const root = join(import.meta.dir, "..")
const entries = ["baseline", "base-ui", "radix", "react-aria"]
const rows: { name: string; raw: number; gz: number; ssr: string }[] = []
for (const name of entries) {
  const outDir = join(root, "dist", name)
  rmSync(outDir, { recursive: true, force: true })
  await build({
    root,
    logLevel: "silent",
    plugins: [react()],
    define: { "process.env.NODE_ENV": '"production"' },
    build: {
      outDir,
      target: "es2022",
      rollupOptions: { input: join(root, "src", `${name}.tsx`) },
    },
  })
  let raw = 0
  let gz = 0
  const dir = join(outDir, "assets")
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".js"))) {
    const b = readFileSync(join(dir, f))
    raw += b.length
    gz += gzipSync(b, { level: 9 }).length
  }
  const ssr = Bun.spawnSync(["bun", join(import.meta.dir, "ssr.tsx"), name], {
    env: { ...process.env, NODE_ENV: "development" },
  })
    .stdout.toString()
    .trim()
  rows.push({ name, raw, gz, ssr })
}
const base = rows[0] as (typeof rows)[number]
const kb = (n: number) => `${(n / 1024).toFixed(1)} KB`
console.log("| Librería | JS min | gzip | gzip sobre React | SSR |")
console.log("| --- | --- | --- | --- | --- |")
for (const r of rows)
  console.log(
    `| ${r.name} | ${kb(r.raw)} | ${kb(r.gz)} | ${r === base ? "—" : kb(r.gz - base.gz)} | ${r.ssr} |`,
  )
