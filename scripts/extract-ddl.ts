/**
 * Extrae los bloques ```sql del SDD 03 a la migración 0001 del daemon (ADR-0004 §2:
 * «la migración 0001 ES ese DDL»). Con --check sólo verifica que no haya deriva.
 *
 *   bun scripts/extract-ddl.ts          # escribe packages/daemon/migrations/0001-initial{,.vec}.sql
 *   bun scripts/extract-ddl.ts --check  # sale 1 si la migración no coincide con el SDD
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

const root = join(import.meta.dir, "..")
const sdd = readFileSync(join(root, "docs/sdd/03-data-model-and-storage.md"), "utf8")
const blocks = [...sdd.matchAll(/```sql\n([\s\S]*?)```/g)].map((m) => m[1] ?? "")
if (blocks.length < 2) {
  console.error(`esperaba 2 bloques sql en el SDD 03, hay ${blocks.length}`)
  process.exit(1)
}
const header = (what: string) =>
  `-- Generado desde docs/sdd/03-data-model-and-storage.md (${what}) por scripts/extract-ddl.ts.\n-- No editar a mano: el SDD es la fuente; \`bun scripts/extract-ddl.ts --check\` detecta deriva.\n\n`
const files: [string, string][] = [
  ["packages/daemon/migrations/0001-initial.sql", header("bloque relacional + FTS5") + blocks[0]],
  [
    "packages/daemon/migrations/0001-initial.vec.sql",
    header("bloque vec0, requiere sqlite-vec") + blocks[1],
  ],
]
let drift = false
for (const [rel, content] of files) {
  const path = join(root, rel)
  if (process.argv.includes("--check")) {
    const current = existsSync(path) ? readFileSync(path, "utf8") : ""
    if (current !== content) {
      drift = true
      console.error(`deriva: ${rel} no coincide con el SDD 03`)
    }
  } else {
    mkdirSync(join(path, ".."), { recursive: true })
    writeFileSync(path, content)
    console.log(`escrito ${rel}`)
  }
}
process.exit(drift ? 1 : 0)
