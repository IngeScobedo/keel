import type { ApprovalViewSchema, PermissionRuleViewSchema } from "@keel/core"
import { Plus, ShieldCheck, Trash2 } from "lucide-react"
import { type FormEvent, useCallback, useEffect, useState } from "react"
import { mutationMeta } from "./client.js"
import { actorLabel, type Run, type WorkItem } from "./model.js"
import { Select } from "./ui/index.js"
import { Button, Empty, Hint } from "./ui.js"
import type { useWorkspace } from "./useWorkspace.js"

type Call = ReturnType<typeof useWorkspace>["call"]
type Rule = ReturnType<typeof PermissionRuleViewSchema.parse>
type Approval = ReturnType<typeof ApprovalViewSchema.parse>

const ULID_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
/** Las aprobaciones no guardan fecha propia: su ULID la lleva (48 bits de ms). */
export function ulidTime(id: string): Date | null {
  let ms = 0
  for (const ch of id.slice(0, 10).toUpperCase()) {
    const v = ULID_ALPHABET.indexOf(ch)
    if (v < 0) return null
    ms = ms * 32 + v
  }
  return new Date(ms)
}

function opText(operation: unknown): { tool: string; input: string } {
  const op = (operation ?? {}) as { tool?: string; input?: Record<string, unknown> }
  const i = op.input ?? {}
  const input =
    typeof i.command === "string"
      ? i.command
      : typeof i.file_path === "string"
        ? i.file_path
        : JSON.stringify(i)
  return { tool: op.tool ?? "?", input }
}

const STATE_LABEL: Record<string, string> = {
  pending: "pendiente",
  approved: "aprobada",
  consumed: "aprobada",
  denied: "denegada",
  expired: "venció",
}

/**
 * Lo que has permitido (ADR-0019 §4): reglas activas del proyecto, que se
 * revocan aquí, y el historial de cada decisión con quién la tomó.
 */
export function Permissions({
  call,
  tick,
  tasks,
  runs,
}: {
  call: Call
  tick: number
  tasks: WorkItem[]
  runs: Run[]
}) {
  const [rules, setRules] = useState<Rule[]>([])
  const [history, setHistory] = useState<Approval[]>([])
  const [showRevoked, setShowRevoked] = useState(false)
  const [error, setError] = useState("")
  const [tool, setTool] = useState("Bash")
  const [prefix, setPrefix] = useState("")
  const [effect, setEffect] = useState<"auto" | "deny">("auto")
  const refresh = useCallback(async () => {
    try {
      const [r, h] = await Promise.all([
        call("permissions.rules_list", { include_revoked: showRevoked }),
        call("approvals.list", { include_resolved: true, limit: 200 }),
      ])
      setRules(r.rules)
      setHistory(h.approvals)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [call, showRevoked])
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
    void act(async () => {
      await call("permissions.rule_add", {
        ...mutationMeta(),
        tool: tool.trim(),
        prefix: prefix.trim() ? prefix.trim() : null,
        effect,
      })
      setPrefix("")
    })
  }
  const taskOf = (id: string) => tasks.find((t) => t.id === id)?.display_id ?? id.slice(0, 8)
  const runOf = (id: string) => runs.find((r) => r.id === id)
  return (
    <div className="page">
      <div className="toolbar">
        <h1>Permisos</h1>
        <span className="mono muted">
          {rules.filter((r) => !r.revoked_at).length} reglas activas · {history.length} decisiones
        </span>
      </div>
      <div className="padded permissions">
        {error && (
          <p className="error-banner" role="alert">
            {error}
          </p>
        )}
        <section>
          <header className="section-header">
            <ShieldCheck size={13} />
            <strong>Reglas del proyecto</strong>
            <span className="muted">se aplican antes de preguntarte</span>
            <label className="raw-toggle">
              <input
                type="checkbox"
                checked={showRevoked}
                onChange={(e) => setShowRevoked(e.target.checked)}
              />
              Ver revocadas
            </label>
          </header>
          <table>
            <thead>
              <tr>
                <th>Regla</th>
                <th>Efecto</th>
                <th>Creada</th>
                <th>Por</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rules.map((r) => (
                <tr key={r.id} data-testid="rule" className={r.revoked_at ? "muted" : ""}>
                  <td>
                    <code>{r.label}</code>
                  </td>
                  <td className={r.effect === "deny" ? "deleted" : "added"}>
                    {r.effect === "deny" ? "negar" : "permitir"}
                  </td>
                  <td className="mono">{new Date(r.created_at).toLocaleString()}</td>
                  <td>
                    {actorLabel(r.created_by).label}
                    {r.source_approval_id ? " · desde una aprobación" : ""}
                  </td>
                  <td>
                    {r.revoked_at ? (
                      <span className="muted">revocada</span>
                    ) : (
                      <Button
                        variant="danger"
                        icon={Trash2}
                        onClick={() =>
                          void act(() =>
                            call("permissions.rule_revoke", { ...mutationMeta(), rule_id: r.id }),
                          )
                        }
                      >
                        Revocar
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {rules.length === 0 && (
            <Empty title="Sin reglas">
              Se crean con «Siempre» al aprobar, o aquí. Mientras no haya, todo te pregunta.
            </Empty>
          )}
          <form className="rule-form" onSubmit={add}>
            <input
              aria-label="Herramienta"
              value={tool}
              onChange={(e) => setTool(e.target.value)}
            />
            <input
              aria-label="Prefijo del comando"
              placeholder="git status (vacío = toda la herramienta)"
              value={prefix}
              onChange={(e) => setPrefix(e.target.value)}
            />
            <Select
              aria-label="Efecto"
              value={effect}
              onChange={(v) => setEffect(v as "auto" | "deny")}
              options={[
                { value: "auto", label: "permitir" },
                { value: "deny", label: "negar" },
              ]}
            />
            <button type="submit" className="button" disabled={!tool.trim()}>
              <Plus size={13} /> Añadir regla
            </button>
          </form>
          <Hint>
            Una regla nunca cubre archivos fuera del worktree del run, y un prefijo nunca deja pasar
            comandos encadenados (`;`, `&&`, `|`, `$(…)`).
          </Hint>
        </section>
        <section>
          <header className="section-header">
            <strong>Decisiones</strong>
            <span className="muted">cada aprobación, quién la decidió y cuándo</span>
          </header>
          <table>
            <thead>
              <tr>
                <th>Cuándo</th>
                <th>Tarea</th>
                <th>Operación</th>
                <th>Resultado</th>
                <th>Decidió</th>
              </tr>
            </thead>
            <tbody>
              {history.map((a) => {
                const op = opText(a.operation)
                const run = runOf(a.run_id)
                return (
                  <tr key={a.id} data-testid="decision">
                    <td className="mono">{ulidTime(a.id)?.toLocaleString() ?? "—"}</td>
                    <td>
                      {taskOf(a.work_item_id)}
                      {run ? <span className="muted"> · {run.purpose}</span> : null}
                    </td>
                    <td>
                      <code>{op.tool}</code> <span className="mono">{op.input}</span>
                    </td>
                    <td className={a.state === "denied" || a.state === "expired" ? "deleted" : ""}>
                      {STATE_LABEL[a.state] ?? a.state}
                    </td>
                    <td>
                      {a.decision_actor
                        ? actorLabel(a.decision_actor).label
                        : a.state === "expired"
                          ? "nadie (venció)"
                          : "—"}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          {history.length === 0 && <Empty title="Todavía no hay decisiones" />}
        </section>
      </div>
    </div>
  )
}
