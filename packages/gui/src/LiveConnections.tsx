import type { ConnectionViewSchema } from "@keel/core"
import { Database, Plus, Server, ShieldAlert, Trash2 } from "lucide-react"
import { type FormEvent, useCallback, useEffect, useState } from "react"
import { mutationMeta } from "./client.js"
import { Button, Empty, Hint } from "./ui.js"
import type { useWorkspace } from "./useWorkspace.js"

type Call = ReturnType<typeof useWorkspace>["call"]
type Connection = ReturnType<typeof ConnectionViewSchema.parse>
type Kind = Connection["type"]

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
    { key: "allowed_commands", label: "Comandos permitidos (separados por coma)" },
  ],
  terraform: [{ key: "dir", label: "Carpeta de Terraform" }],
}
const WRITE = new Set(["query.write", "command.run", "iac.apply"])

/**
 * Conexiones del proyecto (ADR-0013): referencias a secretos, nunca valores;
 * permiso por operación; qué garantiza el servidor y qué sólo Keel.
 */
export function LiveConnections({ call, tick }: { call: Call; tick: number }) {
  const [items, setItems] = useState<Connection[]>([])
  const [error, setError] = useState("")
  const [name, setName] = useState("")
  const [type, setType] = useState<Kind>("sqlite")
  const [env, setEnv] = useState<"dev" | "staging" | "prod">("dev")
  const [config, setConfig] = useState<Record<string, string>>({})
  const [secret, setSecret] = useState("")
  const [secretRo, setSecretRo] = useState("")
  const [guarantee, setGuarantee] = useState("")
  const refresh = useCallback(async () => {
    try {
      setItems((await call("connections.list", {})).connections)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [call])
  // biome-ignore lint/correctness/useExhaustiveDependencies: `tick` sólo dispara la relectura.
  useEffect(() => {
    void refresh()
  }, [refresh, tick])
  async function act(work: () => Promise<unknown>) {
    setError("")
    try {
      await work()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
    await refresh()
  }
  function add(e: FormEvent) {
    e.preventDefault()
    const cfg: Record<string, unknown> = {}
    for (const f of FIELDS[type]) {
      const v = config[f.key]?.trim()
      if (!v) continue
      cfg[f.key] =
        f.key === "allowed_commands"
          ? v.split(",").map((x) => x.trim())
          : f.key === "port"
            ? Number(v)
            : v
    }
    void act(async () => {
      await call("connections.add", {
        ...mutationMeta(),
        name: name.trim(),
        type,
        environment: env,
        config: cfg,
        ...(secret.trim() ? { secret_ref: secret.trim() } : {}),
        ...(secretRo.trim() ? { secret_ref_ro: secretRo.trim() } : {}),
        ...(guarantee.trim() ? { server_guarantee: guarantee.trim() } : {}),
      })
      setName("")
      setConfig({})
      setSecret("")
      setSecretRo("")
      setGuarantee("")
    })
  }
  return (
    <div className="page">
      <div className="toolbar">
        <h1>Conexiones</h1>
        <span className="mono muted">{items.length} del proyecto</span>
      </div>
      <div className="padded connections">
        {error && (
          <p className="error-banner" role="alert">
            {error}
          </p>
        )}
        {items.map((c) => (
          <article key={c.id} className="connection" data-testid="connection">
            <header className="section-header">
              {c.type === "ssh" ? <Server size={14} /> : <Database size={14} />}
              <strong>{c.name}</strong>
              <span className="tag">{c.type}</span>
              <span className={`tag env-${c.environment}`}>{c.environment}</span>
              <span className="muted mono">
                {c.has_secret ? "con credencial" : "sin credencial"}
              </span>
              {c.has_secret_ro && <span className="muted mono">· credencial de sólo lectura</span>}
              <Button
                variant="ghost"
                icon={Trash2}
                aria-label={`Archivar ${c.name}`}
                onClick={() =>
                  void act(() =>
                    call("connections.archive", { ...mutationMeta(), connection_id: c.id }),
                  )
                }
              />
            </header>
            <p className="muted">
              <ShieldAlert size={12} /> Servidor: {c.guarantees.server ?? "sin garantía declarada"}{" "}
              · Keel: {c.guarantees.keel}
            </p>
            <table>
              <tbody>
                {c.operations.map((o) => (
                  <tr key={o.operation}>
                    <td className="mono">{o.operation}</td>
                    <td>
                      <select
                        aria-label={`Política de ${o.operation} en ${c.name}`}
                        value={o.policy}
                        onChange={(e) =>
                          void act(() =>
                            call("grants.set", {
                              ...mutationMeta(),
                              connection_id: c.id,
                              operation: o.operation,
                              policy: e.target.value,
                            }),
                          )
                        }
                      >
                        <option value="ask">preguntar</option>
                        <option
                          value="auto"
                          disabled={c.environment === "prod" && WRITE.has(o.operation)}
                        >
                          automático
                        </option>
                        <option value="deny">negar</option>
                      </select>
                    </td>
                    <td className="muted">
                      {o.effective !== o.policy
                        ? `en ${c.environment} queda en ${o.effective}`
                        : ""}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </article>
        ))}
        {items.length === 0 && (
          <Empty title="Sin conexiones">
            Una conexión le da al agente operaciones (consultar, ejecutar, planear), nunca la
            credencial.
          </Empty>
        )}
        <form className="connection-form" onSubmit={add}>
          <h3>Nueva conexión</h3>
          <input
            aria-label="Nombre de la conexión"
            placeholder="nombre"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
          />
          <select
            aria-label="Tipo de conexión"
            value={type}
            onChange={(e) => setType(e.target.value as Kind)}
          >
            <option value="sqlite">SQLite</option>
            <option value="postgres">PostgreSQL</option>
            <option value="ssh">SSH</option>
            <option value="terraform">Terraform</option>
          </select>
          <select
            aria-label="Entorno"
            value={env}
            onChange={(e) => setEnv(e.target.value as typeof env)}
          >
            <option value="dev">dev</option>
            <option value="staging">staging</option>
            <option value="prod">prod</option>
          </select>
          {FIELDS[type].map((f) => (
            <input
              key={f.key}
              aria-label={f.label}
              placeholder={f.label}
              value={config[f.key] ?? ""}
              onChange={(e) => setConfig((c) => ({ ...c, [f.key]: e.target.value }))}
            />
          ))}
          {type !== "sqlite" && type !== "ssh" && (
            <input
              aria-label="Referencia del secreto"
              placeholder="secreto: env:VAR, keychain:servicio/cuenta, op://…, vault:ruta#campo"
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
            />
          )}
          {type === "postgres" && (
            <input
              aria-label="Referencia del secreto de sólo lectura"
              placeholder="secreto del rol de sólo lectura"
              value={secretRo}
              onChange={(e) => setSecretRo(e.target.value)}
            />
          )}
          <input
            aria-label="Garantía del servidor"
            placeholder="qué garantiza el servidor (rol de sólo lectura, comando forzado…)"
            value={guarantee}
            onChange={(e) => setGuarantee(e.target.value)}
          />
          <button className="button primary" type="submit" disabled={!name.trim()}>
            <Plus size={13} /> Añadir
          </button>
          <Hint>
            Keel guarda dónde está el secreto, nunca su valor, y lo resuelve sólo al ejecutar. Una
            conexión nueva pregunta todo; en prod las escrituras siempre preguntan.
          </Hint>
        </form>
      </div>
    </div>
  )
}
