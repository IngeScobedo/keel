/** ADR-0025 §2: el vault guarda y descifra; nada en claro en la base. */
import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { openStore } from "../src/store/db.ts"
import { memoryKeyStore, noKeyStore } from "../src/vault/keystore.ts"
import { Vault, VaultError } from "../src/vault/vault.ts"

const dirs: string[] = []
const stores: { db: { close: () => void } }[] = []
afterEach(() => {
  // Windows no deja borrar un archivo abierto: primero se cierra la base.
  for (const s of stores.splice(0)) s.db.close()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
function store() {
  const dir = mkdtempSync(join(tmpdir(), "keel-vault-"))
  dirs.push(dir)
  const path = join(dir, "keel.sqlite")
  const s = openStore(path)
  stores.push(s)
  return { s, path }
}
const SENTINEL = "centinela-7f3a-no-debe-verse"

describe("ADR-0025: el vault", () => {
  test("con llavero: crea la llave maestra la primera vez, cifra y no deja nada en claro", async () => {
    const { s, path } = store()
    const keystore = memoryKeyStore()
    const events: string[] = []
    const v = new Vault({ db: s.db, keystore, emit: (k) => events.push(k) })
    expect(v.state()).toBe("uninitialized")
    expect(await v.open()).toBe("unlocked")
    expect(keystore.raw?.length).toBe(32)
    const id = await v.put({
      project_id: null,
      kind: "password",
      label: "pg-staging",
      value: SENTINEL,
      actor: "user:a",
    })
    const seen = await v.use(id, "broker", (x) => x)
    expect(seen).toBe(SENTINEL)
    s.db.exec("PRAGMA wal_checkpoint(TRUNCATE)")
    expect(readFileSync(path).includes(Buffer.from(SENTINEL))).toBe(false)
    expect(events).toEqual(["vault.item_created", "vault.item_used"])

    // Otro daemon con el mismo llavero abre el vault; sin la llave, queda bloqueado.
    const again = new Vault({ db: s.db, keystore })
    expect(await again.open()).toBe("unlocked")
    expect(await again.use(id, "broker", (x) => x.length)).toBe(SENTINEL.length)
    const lost = new Vault({ db: s.db, keystore: memoryKeyStore() })
    expect(await lost.open()).toBe("locked")
    await expect(lost.use(id, "broker", (x) => x)).rejects.toBeInstanceOf(VaultError)
  })

  test("sin llavero: la frase crea el vault y una frase equivocada no lo abre", async () => {
    const { s } = store()
    const v = new Vault({ db: s.db, keystore: noKeyStore() })
    expect(await v.open()).toBe("uninitialized")
    expect(await v.unlock("frase larga de prueba")).toBe("unlocked")
    const id = await v.put({ project_id: null, kind: "token", label: "t", value: "x1", actor: "a" })
    const other = new Vault({ db: s.db, keystore: noKeyStore() })
    expect(await other.open()).toBe("locked")
    await expect(other.unlock("otra frase cualquiera")).rejects.toThrow("no abre")
    expect(await other.unlock("frase larga de prueba")).toBe("unlocked")
    expect(await other.use(id, "t", (x) => x)).toBe("x1")
  })

  test("rotar cambia el cifrado; borrar lo sobrescribe y deja la fila", async () => {
    const { s } = store()
    const v = new Vault({ db: s.db, keystore: memoryKeyStore() })
    await v.open()
    const id = await v.put({
      project_id: null,
      kind: "password",
      label: "p",
      value: "uno",
      actor: "a",
    })
    const before = s.db
      .query<{ c: Uint8Array }, [string]>("SELECT ciphertext c FROM vault_items WHERE id = ?")
      .get(id)?.c
    await v.rotate(id, "dos", "a")
    const after = s.db
      .query<{ c: Uint8Array }, [string]>("SELECT ciphertext c FROM vault_items WHERE id = ?")
      .get(id)?.c
    expect(Buffer.from(after as Uint8Array).equals(Buffer.from(before as Uint8Array))).toBe(false)
    expect(await v.use(id, "t", (x) => x)).toBe("dos")
    v.remove(id, "a")
    await expect(v.use(id, "t", (x) => x)).rejects.toThrow("no existe")
    expect(s.db.query("SELECT count(*) n FROM vault_items").get()).toEqual({ n: 1 })
  })

  test("un llavero bloqueado no rompe: el vault queda sin crear y dice por qué", async () => {
    const { s } = store()
    const locked = {
      ...memoryKeyStore(),
      set: async () => {
        throw new Error("Tu llavero del sistema está bloqueado")
      },
    }
    const v = new Vault({ db: s.db, keystore: locked })
    expect(await v.open()).toBe("uninitialized")
    expect(v.status().keychain.hint).toContain("bloqueado")
    // La frase sigue funcionando como respaldo.
    expect(await v.unlock("frase de respaldo")).toBe("unlocked")
    expect(v.status().keychain.hint).toBeNull()
  })
})
