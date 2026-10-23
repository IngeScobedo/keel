import { describe, expect, test } from "bun:test"
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loadMigrations, MIGRATIONS_DIR, MigrationChecksumError, openStore } from "../src/index.ts"

const tmp = () => mkdtempSync(join(tmpdir(), "keel-store-"))
const root = join(import.meta.dir, "..", "..", "..")

describe("ADR-0004: store SQLite WAL con migraciones", () => {
  test("la migración 0001 es el DDL del SDD 03, sin deriva", () => {
    const r = Bun.spawnSync(["bun", join(root, "scripts/extract-ddl.ts"), "--check"])
    expect(r.exitCode).toBe(0)
  })

  test("abre, aplica 0001 relacional y vec0 y las posteriores, y deja los PRAGMA de conexión", () => {
    const dir = tmp()
    const store = openStore(join(dir, "keel.sqlite"))
    expect(store.migrations.map((m) => `${m.id}:${m.status}`)).toEqual([
      "0001-initial:applied",
      "0001-initial.vec:applied",
      "0002-workspace-driver:applied",
      "0003-run-requests-y-pairings:applied",
      "0004-uso-interactivo:applied",
      "0005-artefactos-y-evidencia:applied",
      "0006-eventos-semanticos:applied",
      "0007-contexto:applied",
      "0008-intermediario-de-recursos:applied",
      "0009-plugins:applied",
      "0010-investigaciones:applied",
      "0011-ajustes-del-usuario:applied",
    ])
    expect(store.vector.available).toBe(true)
    const pragma = (n: string) => store.db.query(`PRAGMA ${n}`).get() as Record<string, unknown>
    expect(pragma("journal_mode").journal_mode).toBe("wal")
    expect(pragma("foreign_keys").foreign_keys).toBe(1)
    expect(pragma("synchronous").synchronous).toBe(2)
    expect(
      store.db
        .query(
          "SELECT count(*) n FROM sqlite_master WHERE name IN ('events','runs','research_vectors')",
        )
        .get(),
    ).toEqual({ n: 3 })
    store.db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  test("reabrir es idempotente", () => {
    const dir = tmp()
    const path = join(dir, "keel.sqlite")
    openStore(path).db.close()
    const again = openStore(path)
    expect(again.migrations.every((m) => m.status === "already")).toBe(true)
    again.db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  test("sin sqlite-vec el bloque vectorial queda skipped y se aplica cuando aparece", () => {
    const dir = tmp()
    const path = join(dir, "keel.sqlite")
    const first = openStore(path, { loadVector: false })
    expect(first.migrations.find((m) => m.kind === "vector")?.status).toBe("skipped")
    expect(first.vector.available).toBe(false)
    first.db.close()
    const second = openStore(path)
    expect(second.migrations.find((m) => m.kind === "vector")?.status).toBe("applied")
    second.db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  test("un checksum distinto para una migración aplicada es error, no reescritura", () => {
    const dir = tmp()
    const path = join(dir, "keel.sqlite")
    openStore(path).db.close()
    const altered = join(dir, "migrations")
    cpSync(MIGRATIONS_DIR, altered, { recursive: true })
    const f = join(altered, "0001-initial.sql")
    writeFileSync(f, `${readFileSync(f, "utf8")}\n-- cambio ilegal\n`)
    expect(() => openStore(path, { migrationsDir: altered })).toThrow(MigrationChecksumError)
    rmSync(dir, { recursive: true, force: true })
  })

  test("la suite de validación del DDL pasa contra la migración, no sólo contra el SDD", () => {
    const r = Bun.spawnSync([
      "bun",
      join(root, "scripts/validate-ddl.ts"),
      join(MIGRATIONS_DIR, "0001-initial.sql"),
    ])
    const out = r.stdout.toString()
    expect(r.exitCode).toBe(0)
    expect(out).toContain("0 fallidas")
    expect(loadMigrations(MIGRATIONS_DIR)).toHaveLength(12)
  })
})
