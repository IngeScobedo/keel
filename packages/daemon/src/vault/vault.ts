/**
 * El vault de Keel (ADR-0025 §2): guarda y descifra; nunca habla con el agente.
 *
 * - Cada secreto tiene su propia llave (DEK, AES-256-GCM) envuelta con la llave
 *   maestra (KEK, AES-KW). Todo con WebCrypto: sin dependencias nativas.
 * - La KEK vive en el llavero del sistema (`keel/vault`); sin llavero, se deriva de
 *   una frase con scrypt y sólo vive en la memoria del daemon.
 * - No hay `get`: `use(id, fn)` entrega el valor a una función del daemon y lo
 *   suelta al volver. Bun no tiene `zeroize` (ADR-0003): lo único que se promete es
 *   que el valor vive el menor tiempo posible.
 */
import type { Database } from "bun:sqlite"
import { scryptSync } from "node:crypto"
import { ulid } from "../ids.js"
import type { KeyStore } from "./keystore.js"

export const VAULT_KINDS = [
  "password",
  "ssh_key",
  "passphrase",
  "token",
  "connection_string",
] as const
export type VaultKind = (typeof VAULT_KINDS)[number]

export type VaultItemRow = {
  id: string
  project_id: string | null
  kind: VaultKind
  label: string
  public_key: string | null
  created_by: string
  created_at: string
  rotated_at: string | null
  last_used_at: string | null
}

export type VaultState = "unlocked" | "locked" | "uninitialized"

export class VaultError extends Error {
  readonly code: "locked" | "not_found" | "invalid"
  constructor(code: VaultError["code"], message: string) {
    super(message)
    this.code = code
  }
}

/** Un texto conocido cifrado con la KEK: detecta una frase equivocada sin guardar la KEK. */
const CHECK = "keel-vault-check-v1"
const enc = new TextEncoder()
const dec = new TextDecoder()

export type VaultEvents = (kind: string, payload: Record<string, unknown>) => void

export class Vault {
  private kek: CryptoKey | null = null
  private source: "keychain" | "passphrase" | null = null
  private readonly db: Database
  private readonly keystore: KeyStore
  private readonly emit: VaultEvents
  constructor(deps: { db: Database; keystore: KeyStore; emit?: VaultEvents }) {
    this.db = deps.db
    this.keystore = deps.keystore
    this.emit = deps.emit ?? (() => {})
  }

  private meta(key: string): string | null {
    return (
      this.db
        .query<{ value: string }, [string]>("SELECT value FROM vault_meta WHERE key = ?")
        .get(key)?.value ?? null
    )
  }
  private setMeta(key: string, value: string): void {
    this.db
      .query(
        "INSERT INTO vault_meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .run(key, value)
  }

  /**
   * Abre el vault con el llavero si se puede. La primera vez crea la KEK y la guarda
   * ahí. Sin llavero queda bloqueado hasta `unlock(frase)`.
   */
  /** Por qué no se pudo usar el llavero, para decírselo al humano. */
  private keychainError: string | null = null

  async open(): Promise<VaultState> {
    try {
      return await this.openWithKeychain()
    } catch (e) {
      this.keychainError = e instanceof Error ? e.message : String(e)
      return this.state()
    }
  }

  private async openWithKeychain(): Promise<VaultState> {
    if (this.kek) return "unlocked"
    const mode = this.meta("mode")
    if (mode === "passphrase") return "locked"
    if (!this.keystore.available()) return mode ? "locked" : "uninitialized"
    let raw = await this.keystore.get()
    if (!raw) {
      if (mode === "keychain") return "locked" // había vault y el llavero ya no tiene la KEK
      raw = crypto.getRandomValues(new Uint8Array(32))
      await this.keystore.set(raw)
      const fresh = await importKek(raw)
      this.setMeta("mode", "keychain")
      this.setMeta("check", await sealCheck(fresh))
    }
    const kek = await importKek(raw)
    raw.fill(0)
    if (!(await openCheck(kek, this.meta("check")))) return "locked"
    this.kek = kek
    this.source = "keychain"
    return "unlocked"
  }

  /** Sin llavero: la frase crea el vault la primera vez y lo abre después. */
  async unlock(passphrase: string): Promise<VaultState> {
    if (this.kek) return "unlocked"
    const mode = this.meta("mode")
    if (mode === "keychain")
      throw new VaultError("invalid", "este vault usa el llavero del sistema")
    let salt = this.meta("salt")
    if (!salt) {
      salt = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("base64")
      const kek = await importKek(derive(passphrase, salt))
      this.setMeta("mode", "passphrase")
      this.setMeta("salt", salt)
      this.setMeta("check", await sealCheck(kek))
      this.kek = kek
      this.source = "passphrase"
      return "unlocked"
    }
    const kek = await importKek(derive(passphrase, salt))
    if (!(await openCheck(kek, this.meta("check"))))
      throw new VaultError("invalid", "la frase no abre el vault")
    this.kek = kek
    this.source = "passphrase"
    return "unlocked"
  }

  state(): VaultState {
    if (this.kek) return "unlocked"
    return this.meta("mode") ? "locked" : "uninitialized"
  }

  status() {
    return {
      state: this.state(),
      keystore: (this.source ??
        this.meta("mode") ??
        (this.keystore.available() ? "keychain" : "none")) as "keychain" | "passphrase" | "none",
      keychain: {
        ...this.keystore.describe(),
        ...(this.keychainError && !this.kek ? { hint: this.keychainError } : {}),
      },
      items:
        this.db
          .query<{ n: number }, []>("SELECT count(*) n FROM vault_items WHERE deleted_at IS NULL")
          .get()?.n ?? 0,
    }
  }

  private requireKek(): CryptoKey {
    if (!this.kek)
      throw new VaultError(
        "locked",
        "el vault está bloqueado: ábrelo con el llavero del sistema o con su frase",
      )
    return this.kek
  }

  /** Guarda un secreto nuevo y devuelve su id. El valor nunca se registra en un evento. */
  async put(p: {
    project_id: string | null
    kind: VaultKind
    label: string
    value: string
    public_key?: string | null
    actor: string
  }): Promise<string> {
    const kek = this.requireKek()
    const sealed = await seal(kek, p.value)
    const id = ulid()
    this.db
      .query(
        `INSERT INTO vault_items(id, project_id, kind, label, ciphertext, nonce, wrapped_dek, public_key, created_by)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        id,
        p.project_id,
        p.kind,
        p.label,
        sealed.ciphertext,
        sealed.nonce,
        sealed.wrapped,
        p.public_key ?? null,
        p.actor,
      )
    this.emit("vault.item_created", { item_id: id, kind: p.kind, label: p.label, actor: p.actor })
    return id
  }

  /** Cambia el valor (otra DEK, otro nonce). */
  async rotate(id: string, value: string, actor: string, publicKey?: string | null): Promise<void> {
    const kek = this.requireKek()
    this.item(id)
    const sealed = await seal(kek, value)
    this.db
      .query(
        `UPDATE vault_items SET ciphertext = ?, nonce = ?, wrapped_dek = ?, public_key = coalesce(?, public_key),
           rotated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`,
      )
      .run(sealed.ciphertext, sealed.nonce, sealed.wrapped, publicKey ?? null, id)
    this.emit("vault.item_rotated", { item_id: id, actor })
  }

  /** Borra el secreto: el cifrado se sobrescribe; la fila queda para la auditoría. */
  remove(id: string, actor: string): void {
    this.item(id)
    this.db
      .query(
        `UPDATE vault_items SET ciphertext = x'', nonce = x'', wrapped_dek = x'',
           deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`,
      )
      .run(id)
    this.emit("vault.item_deleted", { item_id: id, actor })
  }

  item(id: string): VaultItemRow {
    const row = this.db
      .query<VaultItemRow, [string]>(
        "SELECT id, project_id, kind, label, public_key, created_by, created_at, rotated_at, last_used_at FROM vault_items WHERE id = ? AND deleted_at IS NULL",
      )
      .get(id)
    if (!row) throw new VaultError("not_found", "ese secreto no existe en el vault")
    return row
  }

  /**
   * El valor, sólo dentro de `fn` y sólo para el daemon. `by` dice quién lo usa (el
   * broker para una operación, la terminal del humano) y queda en la auditoría.
   */
  async use<T>(id: string, by: string, fn: (value: string) => T | Promise<T>): Promise<T> {
    const kek = this.requireKek()
    const row = this.db
      .query<{ ciphertext: Uint8Array; nonce: Uint8Array; wrapped_dek: Uint8Array }, [string]>(
        "SELECT ciphertext, nonce, wrapped_dek FROM vault_items WHERE id = ? AND deleted_at IS NULL",
      )
      .get(id)
    if (!row) throw new VaultError("not_found", "ese secreto no existe en el vault")
    const dek = await crypto.subtle.unwrapKey(
      "raw",
      new Uint8Array(row.wrapped_dek),
      kek,
      "AES-KW",
      "AES-GCM",
      false,
      ["decrypt"],
    )
    const plain = new Uint8Array(
      await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: new Uint8Array(row.nonce) },
        dek,
        new Uint8Array(row.ciphertext),
      ),
    )
    this.db
      .query(
        "UPDATE vault_items SET last_used_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?",
      )
      .run(id)
    this.emit("vault.item_used", { item_id: id, by })
    try {
      return await fn(dec.decode(plain))
    } finally {
      plain.fill(0)
    }
  }
}

function derive(passphrase: string, salt: string): Uint8Array {
  return new Uint8Array(
    scryptSync(passphrase, Buffer.from(salt, "base64"), 32, {
      N: 1 << 15,
      r: 8,
      p: 1,
      maxmem: 64 * 1024 * 1024,
    }),
  )
}

function importKek(raw: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", new Uint8Array(raw), "AES-KW", false, [
    "wrapKey",
    "unwrapKey",
  ])
}

async function seal(kek: CryptoKey, value: string) {
  const dek = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt"])
  const nonce = crypto.getRandomValues(new Uint8Array(12))
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, dek, enc.encode(value)),
  )
  const wrapped = new Uint8Array(await crypto.subtle.wrapKey("raw", dek, kek, "AES-KW"))
  return { ciphertext, nonce, wrapped }
}

async function sealCheck(kek: CryptoKey): Promise<string> {
  const s = await seal(kek, CHECK)
  return JSON.stringify({
    c: Buffer.from(s.ciphertext).toString("base64"),
    n: Buffer.from(s.nonce).toString("base64"),
    w: Buffer.from(s.wrapped).toString("base64"),
  })
}

async function openCheck(kek: CryptoKey, check: string | null): Promise<boolean> {
  if (!check) return false
  try {
    const { c, n, w } = JSON.parse(check) as { c: string; n: string; w: string }
    const dek = await crypto.subtle.unwrapKey(
      "raw",
      Buffer.from(w, "base64"),
      kek,
      "AES-KW",
      "AES-GCM",
      false,
      ["decrypt"],
    )
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: Buffer.from(n, "base64") },
      dek,
      Buffer.from(c, "base64"),
    )
    return dec.decode(plain) === CHECK
  } catch {
    return false
  }
}
