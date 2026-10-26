/**
 * Dónde vive la llave maestra del vault (ADR-0025 §2): el llavero del sistema.
 *
 * - Linux y WSL2: Secret Service por `secret-tool` (paquete `libsecret-tools`).
 * - macOS: Keychain por `security`.
 * - Windows: pendiente de medir (Credential Manager); sin llavero, el vault pide frase.
 *
 * Se guarda como `service=keel account=vault`. El sandbox de los runs tapa el bus de
 * D-Bus (ADR-0025 §10): el agente no puede pedirle esta llave al llavero.
 */

export type KeyStore = {
  /** Hay llavero en esta máquina (la herramienta existe). */
  available(): boolean
  get(): Promise<Uint8Array | null>
  set(raw: Uint8Array): Promise<void>
  describe(): { available: boolean; tool: string | null; hint: string | null }
}

async function run(
  cmd: string[],
  stdin?: string,
): Promise<{ code: number; out: string; err: string }> {
  const p = Bun.spawn(cmd, {
    stdin: stdin === undefined ? "ignore" : new Blob([stdin]),
    stdout: "pipe",
    stderr: "pipe",
  })
  // El error del llavero nunca lleva el secreto: es el mensaje de la herramienta.
  const [out, err] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
  ])
  return { code: await p.exited, out: out.trim(), err: err.trim() }
}

/** El mensaje del llavero en palabras del humano. */
function keychainError(err: string): string {
  if (/locked collection/i.test(err))
    return "Tu llavero del sistema está bloqueado (en WSL no se desbloquea al entrar): desbloquéalo y reinicia Keel, o abre el vault con una frase."
  return `el llavero no aceptó la llave del vault${err ? `: ${err}` : ""}`
}

export function systemKeyStore(platform: NodeJS.Platform = process.platform): KeyStore {
  if (platform === "linux") {
    const tool = Bun.which("secret-tool")
    return {
      available: () => tool !== null,
      async get() {
        if (!tool) return null
        const r = await run([tool, "lookup", "service", "keel", "account", "vault"])
        return r.code === 0 && r.out ? new Uint8Array(Buffer.from(r.out, "base64")) : null
      },
      async set(raw) {
        if (!tool) throw new Error("no hay secret-tool")
        const r = await run(
          [tool, "store", "--label=Keel vault", "service", "keel", "account", "vault"],
          Buffer.from(raw).toString("base64"),
        )
        if (r.code !== 0) throw new Error(keychainError(r.err))
      },
      describe: () => ({
        available: tool !== null,
        tool: tool ? "secret-tool" : null,
        hint: tool
          ? null
          : "Instala libsecret-tools (sudo apt install libsecret-tools) para que el vault use el llavero; mientras, se abre con una frase.",
      }),
    }
  }
  if (platform === "darwin") {
    const tool = Bun.which("security")
    return {
      available: () => tool !== null,
      async get() {
        if (!tool) return null
        const r = await run([tool, "find-generic-password", "-s", "keel", "-a", "vault", "-w"])
        return r.code === 0 && r.out ? new Uint8Array(Buffer.from(r.out, "base64")) : null
      },
      async set(raw) {
        if (!tool) throw new Error("no hay security")
        // `security` sólo acepta el valor por argumento; vive lo que tarda en guardarse.
        const r = await run([
          tool,
          "add-generic-password",
          "-s",
          "keel",
          "-a",
          "vault",
          "-U",
          "-w",
          Buffer.from(raw).toString("base64"),
        ])
        if (r.code !== 0) throw new Error(keychainError(r.err))
      },
      describe: () => ({ available: tool !== null, tool: tool ? "security" : null, hint: null }),
    }
  }
  return {
    available: () => false,
    get: async () => null,
    set: async () => {
      throw new Error("sin llavero en esta plataforma")
    },
    describe: () => ({
      available: false,
      tool: null,
      hint: "El llavero de esta plataforma aún no está medido: el vault se abre con una frase.",
    }),
  }
}

/** Para las pruebas: un llavero en memoria. */
export function memoryKeyStore(
  initial: Uint8Array | null = null,
): KeyStore & { raw: Uint8Array | null } {
  const store = {
    raw: initial,
    available: () => true,
    get: async () => (store.raw ? new Uint8Array(store.raw) : null),
    set: async (raw: Uint8Array) => {
      store.raw = new Uint8Array(raw)
    },
    describe: () => ({ available: true, tool: "memoria", hint: null }),
  }
  return store
}

/** Sin llavero: el vault se abre con frase. */
export function noKeyStore(): KeyStore {
  return {
    available: () => false,
    get: async () => null,
    set: async () => {
      throw new Error("sin llavero")
    },
    describe: () => ({ available: false, tool: null, hint: null }),
  }
}
