/**
 * Conexiones del proyecto (ADR-0025, ADR-0026), como en Termius: cada una con su método
 * de entrada (`agent`, `file`, `key`, `password`, `ask`). El vault guarda los secretos;
 * esta pantalla nunca los muestra ni los recibe de vuelta. En producción ejecutar
 * pregunta; quitar la pregunta pide escribir el nombre de la conexión.
 */
import type {
  ConnectionViewSchema,
  EventNotification,
  ImportedHostSchema,
  VaultStatusSchema,
} from "@keel/core"
import {
  Copy,
  Download,
  FileCode2,
  Fingerprint,
  FolderOpen,
  KeyRound,
  Lock,
  Plus,
  Rocket,
  Search,
  ShieldAlert,
  Terminal,
  Trash2,
} from "lucide-react"
import { type FormEvent, useCallback, useEffect, useMemo, useState } from "react"
import { buildChat } from "./chat-model.js"
import { hasNativeShell, mutationMeta } from "./client.js"
import { InfraCard } from "./InfraCard.js"
import type { InfraRun } from "./infra-model.js"
import { Button, Empty, Hint, Modal } from "./ui.js"
import type { useWorkspace } from "./useWorkspace.js"

type Call = ReturnType<typeof useWorkspace>["call"]
type Connection = ReturnType<typeof ConnectionViewSchema.parse>
type VaultStatus = ReturnType<typeof VaultStatusSchema.parse>
type ImportedHost = ReturnType<typeof ImportedHostSchema.parse>
type Kind = Connection["type"]
type Env = Connection["environment"]
type Method = "agent" | "file" | "key" | "password" | "ask"

/** Lo que propuso el agente con `setup_request` (ADR-0025 §6), para abrir el alta llena. */
export type SetupPrefill = {
  approval_id: string
  proposal: Record<string, unknown>
}

const FIELDS: Record<Kind, { key: string; label: string }[]> = {
  sqlite: [{ key: "path", label: "Ruta del archivo" }],
  postgres: [
    { key: "host", label: "Host" },
    { key: "port", label: "Puerto" },
    { key: "database", label: "Base" },
    { key: "user", label: "Usuario" },
    { key: "user_ro", label: "Usuario de sólo lectura" },
  ],
  ssh: [
    { key: "host", label: "Host" },
    { key: "user", label: "Usuario" },
    { key: "port", label: "Puerto" },
    { key: "proxy_jump", label: "Salto (ProxyJump)" },
  ],
  terraform: [{ key: "dir", label: "Carpeta de Terraform" }],
  // ADR-0031: el playbook y a qué conexión SSH va cada host del inventario.
  ansible: [
    { key: "dir", label: "Carpeta del playbook (en el proyecto)" },
    { key: "playbook", label: "Playbook" },
    { key: "hosts", label: "Hosts (host=conexión, separados por coma)" },
    { key: "tags", label: "Tags por defecto (separados por coma)" },
  ],
}
const METHODS: Record<Kind, Method[]> = {
  ssh: ["agent", "file", "key", "password", "ask"],
  postgres: ["password", "ask"],
  sqlite: [],
  terraform: [],
  // La contraseña de ansible-vault: guardada en el vault o pedida cada vez.
  ansible: ["password", "ask"],
}
const METHOD_HINT: Record<Method, string> = {
  agent: "Usa tu ssh-agent. Keel no guarda nada.",
  file: "Tu llave de ~/.ssh: la lee ssh, no Keel. Si tiene frase, Keel se la da a ssh (guárdala aquí o te la pide).",
  key: "Una llave de Keel en el vault. Recomendada para el agente: limítala en el servidor con command= y from=.",
  password: "La contraseña vive cifrada en el vault y nunca la ve el agente.",
  ask: "No se guarda: se pide cada vez. Al contestar puedes recordarla.",
}
/** La contraseña de ansible-vault, en palabras del humano. */
const VAULT_METHOD: Partial<Record<Method, string>> = {
  password: "Guardarla en el vault",
  ask: "Preguntarla cada vez",
}
const WRITE = new Set(["query.write", "command.run", "iac.apply"])
const ENVS: Env[] = ["prod", "staging", "dev"]

function target(c: Connection): string {
  const cfg = c.config
  if (c.type === "sqlite") return String(cfg.path ?? "")
  if (c.type === "terraform") return String(cfg.dir ?? "")
  if (c.type === "ansible") return `${String(cfg.dir ?? "")}/${String(cfg.playbook ?? "")}`
  const host = String(cfg.host ?? "")
  const user = cfg.user ? `${cfg.user}@` : ""
  const port = cfg.port ? `:${cfg.port}` : ""
  return c.type === "postgres" && cfg.database
    ? `${user}${host}${port}/${cfg.database}`
    : `${user}${host}${port}`
}

export function LiveConnections({
  call,
  tick,
  setup,
  onSetupDone,
  events = [],
  projectRoot = "",
}: {
  call: Call
  tick: number
  setup?: SetupPrefill | null
  onSetupDone?: () => void
  /** Los eventos del proyecto: el check y el despliegue se ven en vivo (ADR-0031 §5). */
  events?: EventNotification[]
  /** La carpeta del proyecto activo. */
  projectRoot?: string
}) {
  const [items, setItems] = useState<Connection[]>([])
  const [vault, setVault] = useState<VaultStatus | null>(null)
  const [selected, setSelected] = useState("")
  const [query, setQuery] = useState("")
  const [error, setError] = useState("")
  const [modal, setModal] = useState<
    | null
    | { kind: "new"; prefill?: SetupPrefill }
    | { kind: "import" }
    | { kind: "hostkeys"; conn: Connection }
    | { kind: "risk"; conn: Connection; operation: string }
    | { kind: "key"; line: string; pub: string }
  >(null)
  const refresh = useCallback(async () => {
    try {
      const [c, v] = await Promise.all([call("connections.list", {}), call("vault.status", {})])
      setItems(c.connections)
      setVault(v)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [call])
  // biome-ignore lint/correctness/useExhaustiveDependencies: `tick` sólo dispara la relectura.
  useEffect(() => {
    void refresh()
  }, [refresh, tick])
  useEffect(() => {
    if (setup) setModal({ kind: "new", prefill: setup })
  }, [setup])
  async function act(work: () => Promise<unknown>) {
    setError("")
    try {
      await work()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
    await refresh()
  }
  const current = items.find((c) => c.id === selected) ?? items[0]
  const visible = items.filter((c) =>
    `${c.name} ${target(c)} ${(c.tags ?? []).join(" ")}`
      .toLowerCase()
      .includes(query.toLowerCase()),
  )
  return (
    <div className="page conn-page">
      <div className="toolbar">
        <h1>Conexiones</h1>
        <span className="mono muted">
          {items.length} conexiones · vault {vaultLabel(vault)}
        </span>
        <div className="toolbar-spacer" />
        <Button icon={Download} onClick={() => setModal({ kind: "import" })}>
          Importar de ~/.ssh/config
        </Button>
        <Button variant="primary" icon={Plus} onClick={() => setModal({ kind: "new" })}>
          Nueva conexión
        </Button>
      </div>
      {error && (
        <p className="error-banner" role="alert">
          {error}
        </p>
      )}
      {vault && vault.state !== "unlocked" && (
        <VaultBanner vault={vault} call={call} onDone={() => void refresh()} />
      )}
      <div className="conn-body">
        <aside className="conn-list" aria-label="Conexiones">
          <label className="search-field">
            <Search size={14} />
            <input
              aria-label="Buscar conexión"
              placeholder="Buscar host, usuario o etiqueta…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </label>
          {ENVS.map((env) => {
            const rows = visible.filter((c) => c.environment === env)
            if (rows.length === 0) return null
            return (
              <div key={env} className="conn-group">
                <h3>
                  <i className={`env-dot env-${env}`} /> {env.toUpperCase()}
                </h3>
                {rows.map((c) => (
                  <button
                    type="button"
                    key={c.id}
                    className="conn-row"
                    aria-current={current?.id === c.id ? "true" : undefined}
                    onClick={() => setSelected(c.id)}
                  >
                    <span className="conn-row-top">
                      <strong>{c.name}</strong>
                      <span className="method-badge mono">{c.auth_method ?? c.type}</span>
                    </span>
                    <span className="mono muted">
                      {target(c)} · {c.type}
                    </span>
                  </button>
                ))}
              </div>
            )
          })}
          {items.length === 0 && (
            <Hint>
              Sin conexiones: importa tus hosts o crea una. El agente también puede pedírtela.
            </Hint>
          )}
        </aside>
        <section className="conn-detail" data-testid="connection">
          {current ? (
            <Detail
              key={current.id}
              c={current}
              call={call}
              events={events}
              act={act}
              onRisk={(operation) => setModal({ kind: "risk", conn: current, operation })}
              onHostKeys={() => setModal({ kind: "hostkeys", conn: current })}
              onKey={(line, pub) => setModal({ kind: "key", line, pub })}
            />
          ) : (
            <Empty title="Elige una conexión" />
          )}
        </section>
      </div>
      {modal?.kind === "new" && (
        <NewConnection
          call={call}
          connections={items}
          projectRoot={projectRoot}
          {...(modal.prefill ? { prefill: modal.prefill } : {})}
          onClose={() => {
            setModal(null)
            if (modal.prefill) onSetupDone?.()
          }}
          onCreated={async (c, key) => {
            setSelected(c.id)
            await refresh()
            if (modal.prefill) onSetupDone?.()
            setModal(key ? { kind: "key", line: key.line, pub: key.pub } : null)
          }}
        />
      )}
      {modal?.kind === "import" && (
        <ImportModal
          call={call}
          existing={new Set(items.map((c) => c.name))}
          onClose={() => setModal(null)}
          onDone={() => {
            setModal(null)
            void refresh()
          }}
        />
      )}
      {modal?.kind === "hostkeys" && (
        <HostKeysModal
          conn={modal.conn}
          call={call}
          onClose={() => {
            setModal(null)
            void refresh()
          }}
        />
      )}
      {modal?.kind === "risk" && (
        <RiskModal
          conn={modal.conn}
          operation={modal.operation}
          onClose={() => setModal(null)}
          onConfirm={(typed) =>
            act(() =>
              call("grants.set", {
                ...mutationMeta(),
                connection_id: modal.conn.id,
                operation: modal.operation,
                policy: "auto",
                risk_confirm: typed,
              }),
            ).then(() => setModal(null))
          }
        />
      )}
      {modal?.kind === "key" && (
        <Modal title="Llave generada por Keel · ed25519" onClose={() => setModal(null)}>
          <p className="muted">
            La privada vive sólo en el vault. Agrega esta línea al <code>authorized_keys</code> del
            usuario en el servidor:
          </p>
          <pre className="key-line" data-testid="authorized-keys">
            {modal.line}
          </pre>
          <Hint>
            command= limita la llave a ese script y from= a esta máquina: es la garantía en el
            servidor que el agente no puede saltarse (ADR-0013 §5).
          </Hint>
          <div className="modal-actions">
            <Button icon={Copy} onClick={() => void navigator.clipboard?.writeText(modal.line)}>
              Copiar línea
            </Button>
            <Button onClick={() => void navigator.clipboard?.writeText(modal.pub)}>
              Copiar sólo la pública
            </Button>
            <Button variant="primary" onClick={() => setModal(null)}>
              Listo
            </Button>
          </div>
        </Modal>
      )}
    </div>
  )
}

function vaultLabel(v: VaultStatus | null): string {
  if (!v) return "…"
  if (v.state === "unlocked")
    return v.keystore === "keychain" ? "desbloqueado con tu llavero" : "abierto con su frase"
  return v.state === "locked" ? "bloqueado" : "sin crear"
}

/** Sin llavero (o sin la llave en él): la frase abre el vault, o lo crea la primera vez. */
function VaultBanner({
  vault,
  call,
  onDone,
}: {
  vault: VaultStatus
  call: Call
  onDone: () => void
}) {
  const [phrase, setPhrase] = useState("")
  const [error, setError] = useState("")
  const first = vault.state === "uninitialized"
  async function open(e: FormEvent) {
    e.preventDefault()
    setError("")
    try {
      await call("vault.unlock", { ...mutationMeta(), passphrase: phrase })
      setPhrase("")
      onDone()
    } catch (x) {
      setError(x instanceof Error ? x.message : String(x))
    }
  }
  const keychainLost = vault.state === "locked" && vault.keystore === "keychain"
  return (
    <div className="vault-banner" data-testid="vault-banner">
      <Lock size={15} />
      <div>
        <strong>
          {keychainLost
            ? "Bloqueado: la llave maestra no está en el llavero"
            : first
              ? "El vault aún no existe"
              : "El vault está bloqueado"}
        </strong>
        <p className="muted">
          {keychainLost
            ? "¿Otra máquina o se borró del llavero? Los secretos no se pueden leer; las conexiones sin secreto siguen."
            : (vault.keychain.hint ??
              (first
                ? "Elige una frase para crearlo; sin llavero, se abre con ella hasta cerrar Keel."
                : "Escribe su frase para abrirlo hasta cerrar Keel."))}
        </p>
        {!keychainLost && (
          <form onSubmit={(e) => void open(e)} className="vault-unlock">
            <input
              type="password"
              aria-label="Frase del vault"
              placeholder={first ? "Frase nueva (8+ caracteres)" : "Frase del vault"}
              value={phrase}
              onChange={(e) => setPhrase(e.target.value)}
            />
            <button type="submit" className="button primary" disabled={phrase.length < 8}>
              {first ? "Crear vault" : "Abrir"}
            </button>
          </form>
        )}
        {!keychainLost && phrase.length > 0 && phrase.length < 8 && (
          <p className="muted">Mínimo 8 caracteres ({phrase.length}).</p>
        )}
        {first && (
          <p className="muted">
            Es una frase nueva para el vault de Keel, no tu contraseña del sistema. Guárdala: sin
            ella, los secretos del vault no se pueden leer.
          </p>
        )}
        {error && <p className="error">{error}</p>}
      </div>
    </div>
  )
}

function Detail({
  c,
  call,
  events,
  act,
  onRisk,
  onHostKeys,
  onKey,
}: {
  c: Connection
  call: Call
  events: EventNotification[]
  act: (work: () => Promise<unknown>) => Promise<void>
  onRisk: (operation: string) => void
  onHostKeys: () => void
  onKey: (line: string, pub: string) => void
}) {
  const [secret, setSecret] = useState("")
  const [identity, setIdentity] = useState(String(c.config.identity_file ?? ""))
  const [keyPath, setKeyPath] = useState("")
  const [guarantee, setGuarantee] = useState(c.guarantees.server ?? "")
  const [terminal, setTerminal] = useState(false)
  const methods = METHODS[c.type]
  const method = (c.auth_method ?? null) as Method | null
  const update = (patch: Record<string, unknown>) =>
    act(() => call("connections.update", { ...mutationMeta(), connection_id: c.id, ...patch }))
  const cmd = `keel ssh ${c.name}`
  return (
    <>
      <header className="conn-head">
        <h2>{c.name}</h2>
        <span className={`tag env-${c.environment}`}>{c.environment}</span>
        <span className="tag">{c.type}</span>
        <div className="toolbar-spacer" />
        {c.type === "ssh" && method && (
          <Button variant="primary" icon={Terminal} onClick={() => setTerminal((v) => !v)}>
            Abrir terminal
          </Button>
        )}
        {c.type === "ssh" && (
          <Button icon={Fingerprint} onClick={onHostKeys}>
            Huella
          </Button>
        )}
        <Button
          variant="ghost"
          icon={Trash2}
          aria-label={`Archivar ${c.name}`}
          onClick={() =>
            void act(() => call("connections.archive", { ...mutationMeta(), connection_id: c.id }))
          }
        />
      </header>
      {(c.type === "ansible" || c.type === "terraform") && (
        <Deploy c={c} call={call} events={events} />
      )}
      {terminal && (
        <div className="conn-terminal" data-testid="terminal-command">
          <code>{cmd}</code>
          <Button icon={Copy} onClick={() => void navigator.clipboard?.writeText(cmd)}>
            Copiar
          </Button>
          <Hint>
            Ábrelo en tu terminal: Keel prepara ssh con lo que tenga el vault y marca el entorno
            {c.environment === "prod" ? " (fondo rojo y aviso de producción)" : ""}. La terminal
            dentro de Keel llega con el host de PTY.
          </Hint>
        </div>
      )}
      <article className="conn-card">
        <h3>Destino</h3>
        <dl>
          <dt>Destino</dt>
          <dd className="mono">{target(c)}</dd>
          {c.type === "ansible" && (
            <>
              <dt>Hosts</dt>
              <dd className="mono">
                {Object.entries((c.config.hosts ?? {}) as Record<string, string>)
                  .map(([h, conn]) => `${h} → ${conn}`)
                  .join(" · ")}
              </dd>
              <dt>Tags</dt>
              <dd className="mono">
                {((c.config.tags ?? []) as string[]).join(", ") || "todas las tareas"}
              </dd>
            </>
          )}
          {c.config.proxy_jump ? (
            <>
              <dt>Salto</dt>
              <dd className="mono">{String(c.config.proxy_jump)}</dd>
            </>
          ) : null}
          {c.type === "ssh" && (
            <>
              <dt>Huella del host</dt>
              <dd className="mono">
                {c.host_key ? (
                  `${c.host_key.fingerprint} · ${c.host_key.type}`
                ) : (
                  <button type="button" className="text-link" onClick={onHostKeys}>
                    sin aceptar: revisar huella
                  </button>
                )}
              </dd>
            </>
          )}
          {(c.tags ?? []).length > 0 && (
            <>
              <dt>Etiquetas</dt>
              <dd className="mono">{(c.tags ?? []).join(" · ")}</dd>
            </>
          )}
        </dl>
      </article>
      {methods.length > 0 && (
        <article className="conn-card" data-testid="auth-card">
          <h3>{c.type === "ansible" ? "Contraseña de ansible-vault" : "Cómo entra"}</h3>
          <fieldset className="segmented methods" aria-label="Método de entrada">
            {methods.map((m) => (
              <button
                type="button"
                key={m}
                aria-pressed={method === m}
                className={c.type === "ansible" ? "" : "mono"}
                onClick={() => {
                  if (m === "key" && c.secret?.kind !== "ssh_key")
                    void act(async () => {
                      const r = await call("connections.generate_key", {
                        ...mutationMeta(),
                        connection_id: c.id,
                      })
                      onKey(r.authorized_keys, r.public_key)
                    })
                  else if (m !== method) void update({ auth_method: m })
                }}
              >
                {c.type === "ansible" ? (VAULT_METHOD[m] ?? m) : m}
              </button>
            ))}
          </fieldset>
          {!method && c.has_secret && (
            <p className="muted">
              Usa una referencia de secreto (ADR-0013). Elige un método para que Keel la guarde.
            </p>
          )}
          {method && <p className="muted">{METHOD_HINT[method]}</p>}
          {method === "file" && (
            <form
              className="conn-inline"
              onSubmit={(e) => {
                e.preventDefault()
                void update({
                  identity_file: identity,
                  ...(secret ? { secret_value: secret } : {}),
                }).then(() => setSecret(""))
              }}
            >
              <input
                aria-label="Ruta de la llave"
                className="mono"
                value={identity}
                placeholder="~/.ssh/id_ed25519"
                onChange={(e) => setIdentity(e.target.value)}
              />
              <input
                type="password"
                aria-label="Frase de la llave"
                placeholder={
                  c.secret ? "frase guardada · escribe otra para cambiarla" : "frase (opcional)"
                }
                value={secret}
                onChange={(e) => setSecret(e.target.value)}
              />
              <button type="submit" className="button">
                Guardar
              </button>
            </form>
          )}
          {method === "password" && (
            <form
              className="conn-inline"
              onSubmit={(e) => {
                e.preventDefault()
                void update({ secret_value: secret }).then(() => setSecret(""))
              }}
            >
              <input
                type="password"
                aria-label="Contraseña"
                placeholder={
                  c.secret ? "guardada en el vault · escribe otra para cambiarla" : "contraseña"
                }
                value={secret}
                onChange={(e) => setSecret(e.target.value)}
              />
              <button type="submit" className="button" disabled={!secret}>
                Guardar
              </button>
              {c.secret && (
                <Button onClick={() => void update({ forget_secret: true, auth_method: "ask" })}>
                  Olvidar
                </Button>
              )}
            </form>
          )}
          {method === "key" && (
            <div className="conn-inline">
              {c.secret?.public_key && (
                <code className="key-pub" title={c.secret.public_key}>
                  {c.secret.public_key.slice(0, 40)}…
                </code>
              )}
              <Button
                icon={KeyRound}
                onClick={() =>
                  void act(async () => {
                    const r = await call("connections.generate_key", {
                      ...mutationMeta(),
                      connection_id: c.id,
                    })
                    onKey(r.authorized_keys, r.public_key)
                  })
                }
              >
                Generar otra
              </Button>
              <input
                aria-label="Importar llave existente"
                className="mono"
                placeholder="o importa una: ~/.ssh/id_deploy"
                value={keyPath}
                onChange={(e) => setKeyPath(e.target.value)}
              />
              <Button
                disabled={!keyPath}
                onClick={() =>
                  void act(() =>
                    call("connections.import_key_file", {
                      ...mutationMeta(),
                      connection_id: c.id,
                      path: keyPath,
                    }),
                  ).then(() => setKeyPath(""))
                }
              >
                Importar
              </Button>
            </div>
          )}
          {c.secret?.last_used_at && (
            <p className="mono muted">usado {new Date(c.secret.last_used_at).toLocaleString()}</p>
          )}
        </article>
      )}
      <article className="conn-card">
        <h3>Lo que garantiza</h3>
        <dl>
          <dt>En el servidor</dt>
          <dd>
            <form
              className="conn-inline"
              onSubmit={(e) => {
                e.preventDefault()
                void update({ server_guarantee: guarantee })
              }}
            >
              <input
                aria-label={`Garantía del servidor de ${c.name}`}
                value={guarantee}
                placeholder="usuario restringido, rol de sólo lectura, command= …"
                onChange={(e) => setGuarantee(e.target.value)}
              />
              <button type="submit" className="button">
                Guardar
              </button>
            </form>
            {!c.guarantees.server && <span className="amber">nada declarado</span>}
          </dd>
          <dt>En Keel</dt>
          <dd className="muted">{c.guarantees.keel}</dd>
        </dl>
      </article>
      <article className="conn-card">
        <h3>Permisos del agente</h3>
        <table className="grant-table">
          <tbody>
            {c.operations.map((o) => {
              const prodWrite = c.environment === "prod" && WRITE.has(o.operation)
              return (
                <tr key={o.operation}>
                  <td className="mono">{o.operation}</td>
                  <td>
                    <select
                      aria-label={`Política de ${o.operation} en ${c.name}`}
                      value={o.policy}
                      onChange={(e) => {
                        const policy = e.target.value
                        // ADR-0026: quitar la pregunta en prod pide confirmar el riesgo.
                        if (policy === "auto" && prodWrite) onRisk(o.operation)
                        else
                          void act(() =>
                            call("grants.set", {
                              ...mutationMeta(),
                              connection_id: c.id,
                              operation: o.operation,
                              policy: policy as "auto" | "ask" | "deny",
                            }),
                          )
                      }}
                    >
                      <option value="ask">preguntar</option>
                      <option value="auto">sin preguntar</option>
                      <option value="deny">denegar</option>
                    </select>
                  </td>
                  <td className="muted">
                    {o.risk_accepted_at ? (
                      <span className="risk-chip" data-testid="risk-accepted">
                        <ShieldAlert size={12} /> prod sin preguntar
                      </span>
                    ) : o.effective !== o.policy ? (
                      `efectivo: ${o.effective}`
                    ) : prodWrite ? (
                      "en prod pregunta cada vez"
                    ) : (
                      ""
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </article>
    </>
  )
}

/** El alta (ADR-0025 §3), llena si viene de lo que pidió el agente (§6). */
function NewConnection({
  call,
  prefill,
  connections = [],
  projectRoot = "",
  onClose,
  onCreated,
}: {
  call: Call
  prefill?: SetupPrefill
  /** La carpeta del proyecto: el diálogo de archivos abre ahí. */
  projectRoot?: string
  /** Las conexiones que ya hay: un destino de Ansible elige entre las SSH. */
  connections?: Connection[]
  onClose: () => void
  onCreated: (c: Connection, key: { line: string; pub: string } | null) => void
}) {
  const p = prefill?.proposal ?? {}
  const str = (k: string) => (p[k] === undefined || p[k] === null ? "" : String(p[k]))
  const [name, setName] = useState(str("name"))
  const [type, setType] = useState<Kind>(
    (["ssh", "postgres", "sqlite", "terraform"].includes(str("type"))
      ? str("type")
      : "ssh") as Kind,
  )
  const [env, setEnv] = useState<Env>(
    (["dev", "staging", "prod"].includes(str("environment")) ? str("environment") : "dev") as Env,
  )
  const [config, setConfig] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      ["host", "user", "port", "proxy_jump", "database", "user_ro", "path", "dir"]
        .filter((k) => str(k))
        .map((k) => [k, str(k)]),
    ),
  )
  const [method, setMethod] = useState<Method>(type === "postgres" ? "password" : "key")
  const [secret, setSecret] = useState("")
  const [identity, setIdentity] = useState("")
  const [ref, setRef] = useState("")
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)
  const methods = METHODS[type]
  const [target, setTarget] = useState<AnsibleTarget | null>(null)
  // ADR-0031 §1: el destino es tan sensible como la más sensible de sus conexiones.
  const derivedEnv = useMemo(() => {
    if (type !== "ansible" || !target) return null
    const rank: Record<Env, number> = { dev: 0, staging: 1, prod: 2 }
    let max: Env = "dev"
    for (const conn of Object.values(target.hosts)) {
      const c = connections.find((x) => x.name === conn)
      if (c && rank[c.environment] > rank[max]) max = c.environment
    }
    return max
  }, [type, target, connections])
  useEffect(() => {
    if (derivedEnv) setEnv(derivedEnv)
  }, [derivedEnv])
  // Un nombre propuesto: la conexión del primer host sin su prefijo de entorno.
  useEffect(() => {
    if (type !== "ansible" || !target || name) return
    const first = Object.values(target.hosts)[0]
    if (first) setName(first.replace(/^(prod|staging|dev)[-_]/, ""))
  }, [type, target, name])
  const ansibleReady =
    type !== "ansible" ||
    (target !== null &&
      Object.keys(target.hosts).length > 0 &&
      Object.values(target.hosts).every(Boolean))
  async function submit(e: FormEvent) {
    e.preventDefault()
    if (!ansibleReady) return
    setBusy(true)
    setError("")
    const cfg: Record<string, unknown> = {}
    for (const f of FIELDS[type]) {
      const v = config[f.key]?.trim()
      if (v) cfg[f.key] = f.key === "port" ? Number(v) : v
    }
    if (type === "ansible" && target) {
      cfg.dir = target.dir
      cfg.playbook = target.playbook
      cfg.hosts = target.hosts
      cfg.tags = target.tags
    }
    if (method === "file" && identity) cfg.identity_file = identity
    const managed = methods.length > 0
    try {
      const c = await call("connections.add", {
        ...mutationMeta(),
        name: name.trim(),
        type,
        environment: env,
        config: cfg,
        ...(managed ? { auth_method: method === "key" ? "agent" : method } : {}),
        ...(managed && secret && (method === "password" || method === "file")
          ? { secret_value: secret }
          : {}),
        ...(!managed && ref ? { secret_ref: ref } : {}),
        ...(prefill ? { setup_request_id: prefill.approval_id } : {}),
      })
      let key: { line: string; pub: string } | null = null
      if (managed && method === "key" && type === "ssh") {
        const r = await call("connections.generate_key", { ...mutationMeta(), connection_id: c.id })
        key = { line: r.authorized_keys, pub: r.public_key }
      }
      onCreated(c, key)
    } catch (x) {
      setError(x instanceof Error ? x.message : String(x))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Modal title="Nueva conexión" onClose={onClose}>
      <form onSubmit={(e) => void submit(e)} className="conn-form" data-testid="new-connection">
        {prefill && (
          <p className="muted">
            Propuesta por el agente
            {p.why ? `: ${String(p.why).replace(/\.$/, "")}` : ""}. Revisa y completa; el agente
            nunca ve el secreto.
          </p>
        )}
        <div className="conn-form-row">
          <label>
            Nombre
            <input
              aria-label="Nombre de la conexión"
              required
              data-autofocus
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <label>
            Tipo
            <select
              aria-label="Tipo"
              value={type}
              onChange={(e) => {
                const t = e.target.value as Kind
                setType(t)
                // Ansible: la contraseña de ansible-vault se pide hasta que la guardes.
                setMethod(t === "postgres" ? "password" : t === "ansible" ? "ask" : "key")
              }}
            >
              <option value="ssh">SSH</option>
              <option value="postgres">PostgreSQL</option>
              <option value="sqlite">SQLite</option>
              <option value="terraform">Terraform</option>
              <option value="ansible">Ansible</option>
            </select>
          </label>
          <label>
            Entorno
            <select
              aria-label="Entorno"
              value={env}
              disabled={derivedEnv !== null}
              title={derivedEnv ? "Lo deciden las conexiones de los hosts" : undefined}
              onChange={(e) => setEnv(e.target.value as Env)}
            >
              <option value="dev">dev</option>
              <option value="staging">staging</option>
              <option value="prod">prod</option>
            </select>
          </label>
        </div>
        {env === "prod" && (
          <p className="prod-note">
            Producción: cada ejecución te pide permiso. Puedes quitar la pregunta después, desde la
            conexión, asumiendo el riesgo.
          </p>
        )}
        {type === "ansible" ? (
          <AnsiblePicker
            call={call}
            connections={connections}
            projectRoot={projectRoot}
            onChange={setTarget}
          />
        ) : (
          <div className="conn-form-row">
            {FIELDS[type].map((f) => (
              <label key={f.key}>
                {f.label}
                <input
                  aria-label={f.label}
                  className="mono"
                  value={config[f.key] ?? ""}
                  onChange={(e) => setConfig((o) => ({ ...o, [f.key]: e.target.value }))}
                />
              </label>
            ))}
          </div>
        )}
        {methods.length > 0 ? (
          <>
            <span className="label">
              {type === "ansible" ? "Contraseña de ansible-vault" : "Cómo entra"}
            </span>
            <fieldset className="segmented methods" aria-label="Método de entrada">
              {methods.map((m) => (
                <button
                  type="button"
                  key={m}
                  aria-pressed={method === m}
                  className={type === "ansible" ? "" : "mono"}
                  onClick={() => setMethod(m)}
                >
                  {type === "ansible" ? (VAULT_METHOD[m] ?? m) : m}
                </button>
              ))}
            </fieldset>
            <Hint>{METHOD_HINT[method]}</Hint>
            {method === "file" && (
              <input
                aria-label="Ruta de la llave"
                className="mono"
                placeholder="~/.ssh/id_ed25519"
                value={identity}
                onChange={(e) => setIdentity(e.target.value)}
              />
            )}
            {(method === "password" || method === "file") && (
              <input
                type="password"
                aria-label={method === "file" ? "Frase de la llave" : "Contraseña"}
                placeholder={method === "file" ? "frase (opcional)" : "contraseña"}
                value={secret}
                onChange={(e) => setSecret(e.target.value)}
              />
            )}
          </>
        ) : (
          <label>
            Referencia del secreto (opcional)
            <input
              aria-label="Referencia del secreto"
              className="mono"
              placeholder="env:NOMBRE · keychain:servicio/cuenta · op://…"
              value={ref}
              onChange={(e) => setRef(e.target.value)}
            />
          </label>
        )}
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        {!ansibleReady && (
          <p className="muted" data-testid="ansible-missing">
            Para añadirlo falta{" "}
            {target ? "elegir la conexión SSH de cada host" : "elegir el playbook"}.
          </p>
        )}
        <div className="modal-actions">
          <Button onClick={onClose}>Cancelar</Button>
          <button
            type="submit"
            className="button primary"
            disabled={!name.trim() || busy || !ansibleReady}
          >
            {prefill ? "Guardar y avisar al agente" : "Añadir"}
          </button>
        </div>
      </form>
    </Modal>
  )
}

function ImportModal({
  call,
  existing,
  onClose,
  onDone,
}: {
  call: Call
  existing: Set<string>
  onClose: () => void
  onDone: () => void
}) {
  const [hosts, setHosts] = useState<ImportedHost[] | null>(null)
  const [pick, setPick] = useState<Record<string, Env | null>>({})
  const [error, setError] = useState("")
  useEffect(() => {
    call("connections.import_preview", {})
      .then((r) => {
        setHosts(r.hosts)
        setPick(
          Object.fromEntries(
            r.hosts.map((h) => [h.alias, existing.has(h.alias) ? null : h.environment]),
          ),
        )
      })
      .catch((e: Error) => setError(e.message))
  }, [call, existing])
  const chosen = (hosts ?? []).filter((h) => pick[h.alias])
  async function run() {
    setError("")
    try {
      await call("connections.import", {
        ...mutationMeta(),
        hosts: chosen.map((h) => ({
          alias: h.alias,
          host: h.host,
          user: h.user,
          port: h.port,
          proxy_jump: h.proxy_jump,
          identity_file: h.identity_file,
          environment: pick[h.alias] as Env,
        })),
      })
      onDone()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }
  return (
    <Modal title="Importar de ~/.ssh/config" onClose={onClose} wide>
      <p className="muted">
        Keel lee sólo los Host de tu config: nombre, destino, usuario, puerto, salto y la ruta de la
        llave. No lee tus llaves ni otros archivos de ~/.ssh.
      </p>
      {!hosts && !error && <p className="muted">Leyendo…</p>}
      {hosts && hosts.length === 0 && <Hint>Tu ~/.ssh/config no tiene hosts.</Hint>}
      {hosts && hosts.length > 0 && (
        <table className="import-table">
          <thead>
            <tr>
              <th />
              <th>Host</th>
              <th>Destino</th>
              <th>Entorno</th>
              <th>Entra con</th>
            </tr>
          </thead>
          <tbody>
            {hosts.map((h) => (
              <tr key={h.alias} data-testid="import-row">
                <td>
                  <input
                    type="checkbox"
                    aria-label={`Importar ${h.alias}`}
                    disabled={existing.has(h.alias)}
                    checked={!!pick[h.alias]}
                    onChange={(e) =>
                      setPick((o) => ({
                        ...o,
                        [h.alias]: e.target.checked ? (h.environment ?? "dev") : null,
                      }))
                    }
                  />
                </td>
                <td>{h.alias}</td>
                <td className="mono">
                  {h.user ? `${h.user}@` : ""}
                  {h.host}:{h.port}
                </td>
                <td>
                  <select
                    aria-label={`Entorno de ${h.alias}`}
                    value={pick[h.alias] ?? h.environment ?? "dev"}
                    disabled={!pick[h.alias]}
                    onChange={(e) => setPick((o) => ({ ...o, [h.alias]: e.target.value as Env }))}
                  >
                    <option value="dev">dev</option>
                    <option value="staging">staging</option>
                    <option value="prod">prod</option>
                  </select>{" "}
                  <span className="muted">{existing.has(h.alias) ? "ya existe" : h.why}</span>
                </td>
                <td className="mono">
                  {h.identity_file ? `file · ${h.identity_file.split("/").pop()}` : "agent"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <Hint>
        El entorno sale del prefijo del alias, como en sshx. Cámbialo si no corresponde: en prod el
        agente siempre pregunta.
      </Hint>
      {error && <p className="error">{error}</p>}
      <div className="modal-actions">
        <Button onClick={onClose}>Cancelar</Button>
        <Button variant="primary" disabled={chosen.length === 0} onClick={() => void run()}>
          Importar {chosen.length} conexiones
        </Button>
      </div>
    </Modal>
  )
}

function HostKeysModal({
  conn,
  call,
  onClose,
}: {
  conn: Connection
  call: Call
  onClose: () => void
}) {
  const [keys, setKeys] = useState<{ line: string; fingerprint: string; type: string }[] | null>(
    null,
  )
  const [error, setError] = useState("")
  useEffect(() => {
    call("connections.host_keys", { connection_id: conn.id })
      .then((r) => setKeys(r.keys))
      .catch((e: Error) => setError(e.message))
  }, [call, conn.id])
  return (
    <Modal title={`Huella de ${conn.name}`} onClose={onClose}>
      <p className="muted">
        Compara la huella con la que te dé el administrador del servidor antes de aceptarla. Keel
        nunca acepta una huella por su cuenta, y si cambia, la operación falla.
      </p>
      {conn.host_key && (
        <p className="mono">
          Aceptada: {conn.host_key.fingerprint} · {conn.host_key.type}
        </p>
      )}
      {!keys && !error && <p className="muted">Preguntando al host…</p>}
      {keys?.map((k) => (
        <div key={k.line} className="hostkey-row">
          <span className="mono">
            {k.fingerprint} · {k.type}
          </span>
          <Button
            onClick={() =>
              void call("connections.host_key_accept", {
                ...mutationMeta(),
                connection_id: conn.id,
                line: k.line,
              })
                .then(onClose)
                .catch((e: Error) => setError(e.message))
            }
          >
            Aceptar
          </Button>
        </div>
      ))}
      {keys && keys.length === 0 && <Hint>El host no respondió con llaves.</Hint>}
      {error && <p className="error">{error}</p>}
    </Modal>
  )
}

/** ADR-0026: dejar de preguntar en producción, escribiendo el nombre de la conexión. */
function RiskModal({
  conn,
  operation,
  onClose,
  onConfirm,
}: {
  conn: Connection
  operation: string
  onClose: () => void
  onConfirm: (typed: string) => void
}) {
  const [typed, setTyped] = useState("")
  return (
    <Modal title="⚠  Dejar de preguntar en producción" onClose={onClose}>
      <div className="risk-modal" data-testid="risk-modal">
        <p>
          Los agentes podrán ejecutar <code>{operation}</code> en <strong>{conn.name}</strong> (
          {target(conn)}) sin pedirte permiso. Un error del agente llega directo al servidor.
        </p>
        <ul>
          <li>Vale para cualquier tarea de este proyecto</li>
          <li>La salida se sigue redactando y todo queda en la auditoría</li>
          <li>Vuelves a preguntar con un clic, sin confirmar</li>
        </ul>
        <label>
          Escribe {conn.name} para confirmar
          <input
            aria-label="Nombre de la conexión para confirmar"
            className="mono"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
          />
        </label>
        <Hint>Recomendado: una llave de Keel con command= en el servidor.</Hint>
        <div className="modal-actions">
          <Button onClick={onClose}>Cancelar</Button>
          <button
            type="button"
            className="button danger"
            disabled={typed !== conn.name}
            onClick={() => onConfirm(typed)}
          >
            Dejar de preguntar
          </button>
        </div>
      </div>
    </Modal>
  )
}

/**
 * ADR-0031 §4: el humano revisa y despliega sin agente. Primero el check (Ansible) o el
 * plan (Terraform); «Desplegar» sólo corre lo revisado, por su hash. Se ve en vivo.
 */
function Deploy({ c, call, events }: { c: Connection; call: Call; events: EventNotification[] }) {
  const [busy, setBusy] = useState<"plan" | "apply" | null>(null)
  const [error, setError] = useState("")
  const [plan, setPlan] = useState<{ sha: string; summary: string } | null>(null)
  const [confirm, setConfirm] = useState(false)
  const ansible = c.type === "ansible"
  const runs = useMemo(() => {
    const keys = new Set(
      events
        .filter(
          (e) =>
            e.kind === "iac.run.started" &&
            (e.payload as { connection?: string } | null)?.connection === c.name,
        )
        .map((e) => String((e.payload as { run_key?: string }).run_key)),
    )
    const mine = events.filter((e) =>
      keys.has(String((e.payload as { run_key?: string } | null)?.run_key)),
    )
    return buildChat(mine).filter((i): i is InfraRun => i.kind === "infra")
  }, [events, c.name])
  const last = runs[runs.length - 1]
  async function run(op: "plan" | "apply") {
    setBusy(op)
    setError("")
    try {
      const r = await call("resources.execute", {
        ...mutationMeta(),
        connection: c.name,
        operation: op === "plan" ? "iac.plan" : "iac.apply",
        input: op === "apply" && plan ? { plan_sha256: plan.sha } : {},
      })
      setPlan(op === "plan" && r.plan_sha256 ? { sha: r.plan_sha256, summary: r.summary } : null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
      setConfirm(false)
    }
  }
  return (
    <section className="conn-deploy" data-testid="deploy">
      <div className="conn-deploy-bar">
        <strong>{ansible ? "Desplegar con Ansible" : "Terraform"}</strong>
        <Button icon={Search} disabled={busy !== null} onClick={() => void run("plan")}>
          {busy === "plan" ? "Revisando…" : ansible ? "Check" : "Plan"}
        </Button>
        <Button
          variant="primary"
          icon={Rocket}
          disabled={busy !== null || !plan}
          onClick={() => setConfirm(true)}
        >
          {busy === "apply" ? "Desplegando…" : ansible ? "Desplegar" : "Aplicar"}
        </Button>
      </div>
      <Hint>
        {plan
          ? `Revisado: ${plan.summary}. Desplegar corre exactamente esto; si algo cambia, hay que revisar otra vez.`
          : `Primero ${ansible ? "el check" : "el plan"}: muestra qué cambiaría sin tocar el servidor.`}
      </Hint>
      {error && (
        <p className="deleted" role="alert">
          {error}
        </p>
      )}
      {last && <InfraCard key={last.run_key} r={last} call={call} />}
      {confirm && plan && (
        <Modal title={ansible ? "Desplegar" : "Aplicar el plan"} onClose={() => setConfirm(false)}>
          <p>
            {c.environment === "prod" ? <strong>Producción · </strong> : null}
            {c.name}: {plan.summary}.
          </p>
          <div className="conn-form-actions">
            <Button variant="ghost" onClick={() => setConfirm(false)}>
              Cancelar
            </Button>
            <Button variant="primary" icon={Rocket} onClick={() => void run("apply")}>
              {ansible ? "Desplegar" : "Aplicar"}
            </Button>
          </div>
        </Modal>
      )}
    </section>
  )
}

/** Un daemon anterior no sabe buscar playbooks: se dice qué hacer, no «método desconocido». */
function discoverError(e: unknown): string {
  if ((e as { rpc?: { code?: number } }).rpc?.code === -32601)
    return "El daemon corre una versión anterior de Keel y no sabe buscar playbooks: reinícialo con «Daemon desactualizado», arriba."
  return e instanceof Error ? e.message : String(e)
}

type AnsibleTarget = {
  dir: string
  playbook: string
  hosts: Record<string, string>
  tags: string[]
}
type Discovered = {
  dir: string
  playbook: string
  targets: string[]
  hosts: {
    name: string
    address: string | null
    user: string | null
    port: number | null
    suggested_connection: string | null
  }[]
  tags: string[]
  vault_files: string[]
  inventories: string[]
}

/**
 * ADR-0031 §1: Keel encuentra los playbooks; el humano elige uno, confirma la conexión
 * SSH de cada host (la que coincide ya viene elegida) y marca los tags.
 */
function AnsiblePicker({
  call,
  connections,
  projectRoot,
  onChange,
}: {
  call: Call
  connections: Connection[]
  projectRoot: string
  onChange: (t: AnsibleTarget | null) => void
}) {
  const [found, setFound] = useState<Discovered[] | null>(null)
  const [root, setRoot] = useState("")
  const [pick, setPick] = useState(0)
  const [hosts, setHosts] = useState<Record<string, string>>({})
  const [tags, setTags] = useState<string[]>([])
  const [path, setPath] = useState("")
  const [error, setError] = useState("")
  const ssh = connections.filter((c) => c.type === "ssh")
  useEffect(() => {
    let alive = true
    call("ansible.discover", {})
      .then((r) => {
        if (!alive) return
        setRoot(r.root)
        setFound(r.playbooks)
      })
      .catch((e) => {
        if (!alive) return
        setError(discoverError(e))
        setFound([])
      })
    return () => {
      alive = false
    }
  }, [call])
  const current = found?.[pick] ?? null
  // Al elegir un playbook: las conexiones sugeridas y, si existe, el tag «deploy».
  useEffect(() => {
    if (!current) return
    setHosts(Object.fromEntries(current.hosts.map((h) => [h.name, h.suggested_connection ?? ""])))
    setTags(current.tags.includes("deploy") ? ["deploy"] : [])
  }, [current])
  useEffect(() => {
    onChange(current ? { dir: current.dir, playbook: current.playbook, hosts, tags } : null)
  }, [current, hosts, tags, onChange])
  async function inspect(file: string) {
    setError("")
    try {
      const r = await call("ansible.discover", { path: file })
      const pb = r.playbooks[0]
      if (!pb) return
      const others = (found ?? []).filter((x) => !(x.dir === pb.dir && x.playbook === pb.playbook))
      setFound([pb, ...others])
      setPick(0)
    } catch (e) {
      setError(discoverError(e))
    }
  }
  async function chooseFile() {
    try {
      const { open } = await import("@tauri-apps/plugin-dialog")
      const chosen = await open({
        multiple: false,
        directory: false,
        title: "Elegir el playbook",
        // La carpeta del proyecto aunque la búsqueda haya fallado; nunca la de Keel.
        ...(root || projectRoot ? { defaultPath: root || projectRoot } : {}),
        filters: [{ name: "Playbook de Ansible", extensions: ["yml", "yaml"] }],
      })
      if (typeof chosen === "string") await inspect(chosen)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }
  return (
    <div className="ansible-picker" data-testid="ansible-picker">
      <span className="label">Playbook</span>
      {found === null && !error && <p className="muted">Buscando playbooks en el proyecto…</p>}
      {found?.length === 0 && <Hint>No encontré playbooks en el proyecto. Elige el archivo.</Hint>}
      <fieldset className="ansible-playbooks" aria-label="Playbooks encontrados">
        {(found ?? []).map((pb, i) => (
          <label key={`${pb.dir}/${pb.playbook}`} className="ansible-playbook">
            <input
              type="radio"
              name="ansible-playbook"
              checked={i === pick}
              onChange={() => setPick(i)}
            />
            <FileCode2 size={15} />
            <span className="mono">
              {pb.dir}/{pb.playbook}
            </span>
            <small>
              {pb.hosts.length} host{pb.hosts.length === 1 ? "" : "s"} · {pb.tags.length} tags
              {pb.vault_files.length > 0 ? " · vault cifrado" : ""}
            </small>
          </label>
        ))}
      </fieldset>
      <div className="ansible-file">
        {hasNativeShell() ? (
          <Button icon={FolderOpen} onClick={() => void chooseFile()}>
            Elegir otro archivo…
          </Button>
        ) : (
          <>
            <input
              aria-label="Ruta del playbook"
              className="mono"
              placeholder="infra/ansible/site.yml"
              value={path}
              onChange={(e) => setPath(e.target.value)}
            />
            <Button disabled={!path.trim()} onClick={() => void inspect(path.trim())}>
              Usar
            </Button>
          </>
        )}
      </div>
      {current && (
        <>
          <span className="label">Hosts del inventario</span>
          {current.hosts.length === 0 && (
            <Hint>
              El inventario no tiene hosts que Keel pueda leer (sus plays apuntan a{" "}
              {current.targets.join(", ") || "nada"}).
            </Hint>
          )}
          <table className="ansible-hosts">
            <tbody>
              {current.hosts.map((h) => (
                <tr key={h.name}>
                  <td className="mono">{h.name}</td>
                  <td className="muted mono">
                    {h.user ? `${h.user}@` : ""}
                    {h.address ?? "sin dirección"}
                  </td>
                  <td>
                    <select
                      aria-label={`Conexión de ${h.name}`}
                      value={hosts[h.name] ?? ""}
                      onChange={(e) => setHosts((o) => ({ ...o, [h.name]: e.target.value }))}
                    >
                      <option value="">Elige la conexión SSH…</option>
                      {ssh.map((c) => (
                        <option key={c.id} value={c.name}>
                          {c.name} · {c.environment}
                        </option>
                      ))}
                    </select>
                    {h.suggested_connection && hosts[h.name] === h.suggested_connection && (
                      <small className="ansible-match">coincide con el inventario</small>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {current.tags.length > 0 && (
            <>
              <span className="label">Tags por defecto</span>
              <fieldset className="ansible-tags" aria-label="Tags">
                {current.tags.map((t) => (
                  <button
                    type="button"
                    key={t}
                    className="chip"
                    aria-pressed={tags.includes(t)}
                    onClick={() =>
                      setTags((o) => (o.includes(t) ? o.filter((x) => x !== t) : [...o, t]))
                    }
                  >
                    {t}
                  </button>
                ))}
              </fieldset>
              <p className="muted">
                {tags.length
                  ? `Corre sólo las tareas con ${tags.join(", ")}.`
                  : "Sin tags se corre el playbook entero."}{" "}
                Se pueden cambiar en cada check.
              </p>
            </>
          )}
          {current.vault_files.length > 0 && (
            <p className="muted">
              Usa ansible-vault ({current.vault_files.join(", ")}): Keel te pedirá la contraseña, o
              guárdala aquí abajo.
            </p>
          )}
        </>
      )}
      {error && (
        <p className="deleted" role="alert">
          {error}
        </p>
      )}
    </div>
  )
}
