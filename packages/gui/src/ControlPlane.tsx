import { ArrowRight, Check, GitBranch, Plus, Search, ShieldCheck } from "lucide-react"
import { useState } from "react"
import { demoProfiles } from "./fixtures.js"
import { Select } from "./ui/index.js"
import { Button, Empty, Hint, Modal, Tabs } from "./ui.js"

const tabs = ["Perfiles", "Equipo y flujo", "Model routing", "Quality gates", "Evals"] as const
export function ControlPlane({ demo }: { demo: boolean }) {
  const [tab, setTab] = useState<(typeof tabs)[number]>("Perfiles")
  const [profiles, setProfiles] = useState(demoProfiles)
  const [selected, setSelected] = useState(0)
  const [query, setQuery] = useState("")
  const [edit, setEdit] = useState(false)
  const [name, setName] = useState("")
  const [scope, setScope] = useState("")
  const [complexity, setComplexity] = useState("2")
  const [gate, setGate] = useState("Typecheck")
  const profile = profiles[selected] ?? profiles[0]
  if (!profile) return null
  return (
    <div className="page control-page">
      <div className="toolbar">
        <h1>Perfiles de agentes</h1>
        <div className="toolbar-spacer" />
        <Button icon={Plus} disabled title="La persistencia de perfiles necesita su endpoint">
          Nuevo perfil
        </Button>
      </div>
      <Tabs values={tabs} active={tab} onChange={setTab} />
      {!demo ? (
        <Empty title="Control Plane pendiente de conexión">
          El daemon aún no expone perfiles, routing, gates ni evals.
        </Empty>
      ) : (
        <div className="padded">
          <p className="muted">
            keel-api / Agent Control Plane · {profiles.length} perfiles · Configuración versionada
            en Git · Datos ilustrativos
          </p>
          {tab === "Perfiles" && (
            <>
              <div className="profile-filters">
                <label className="search-field">
                  <Search size={14} />
                  <input
                    aria-label="Buscar perfiles"
                    placeholder="Buscar por nombre, disciplina o capacidad"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                  />
                </label>
              </div>
              <div className="profile-layout">
                <table>
                  <thead>
                    <tr>
                      <th>PERFIL / DISCIPLINA</th>
                      <th>ROL DE EJECUCIÓN</th>
                      <th>VERSIÓN / ESTADO</th>
                    </tr>
                  </thead>
                  <tbody>
                    {profiles.map(
                      (entry, index) =>
                        `${entry.name} ${entry.discipline}`
                          .toLowerCase()
                          .includes(query.toLowerCase()) && (
                          <tr key={entry.name} className={selected === index ? "selected" : ""}>
                            <td>
                              <button
                                type="button"
                                className="text-link"
                                onClick={() => setSelected(index)}
                              >
                                {entry.name} · {entry.discipline}
                              </button>
                            </td>
                            <td>{entry.role}</td>
                            <td className="muted">
                              v{entry.version} · {entry.state}
                            </td>
                          </tr>
                        ),
                    )}
                  </tbody>
                </table>
                <aside className="profile-detail">
                  <h3>PERFIL SELECCIONADO</h3>
                  <h2>{profile.name}</h2>
                  <p>{profile.description}</p>
                  <pre>{`${profile.role} · v${profile.version}\nScope: ${profile.scope}\nModelo: resuelto por policy\nTools: read, edit, test, browser\nPermisos: heredados y restringidos`}</pre>
                  <p className="added">
                    EVALS / ÚLTIMA VERSIÓN
                    <br />
                    18/20 tareas pasan · fixture suite v3
                    <br />
                    $0.42 estimado / tarea · 2m 18s
                  </p>
                  <Button
                    variant="primary"
                    onClick={() => {
                      setName(profile.name)
                      setScope(profile.scope)
                      setEdit(true)
                    }}
                  >
                    Editar perfil
                  </Button>
                  <Hint>
                    Los runs activos conservan su snapshot. Publicar una versión no cambia agentes
                    en ejecución.
                  </Hint>
                </aside>
              </div>
            </>
          )}
          {tab === "Equipo y flujo" && (
            <>
              <h2>Workflow · contrato antes de implementación</h2>
              <p className="muted">
                Las lanes declaran repositorio, file_scope y dependencias explícitas.
              </p>
              <div className="workflow-grid">
                {[
                  { name: "Reasoner", role: "Read-only · genera DAG", scope: "docs/specs/**" },
                  {
                    name: "Backend engineer",
                    role: "Worker · define contrato",
                    scope: "backend/src/**",
                  },
                  { name: "Contract gate", role: "ready_for_mock · v1", scope: "checkout_api" },
                  {
                    name: "Frontend engineer",
                    role: "Worker · consumes v1",
                    scope: "frontend/src/**",
                  },
                  {
                    name: "Reviewer",
                    role: "Read-only · independent QA",
                    scope: "diff + evidence",
                  },
                ].map((step, index) => (
                  <div className="workflow-step" key={step.name}>
                    <span className="mono muted">0{index + 1}</span>
                    <strong>{step.name}</strong>
                    <p>{step.role}</p>
                    <code>{step.scope}</code>
                    <ArrowRight size={16} />
                  </div>
                ))}
              </div>
              <div className="callout">
                <GitBranch size={16} />
                <strong>Fronteras disjuntas</strong>
                <p>
                  El worker frontend espera el contrato, después programa contra un SDK tipado y
                  mocks. Cada repositorio conserva su worktree.
                </p>
              </div>
            </>
          )}
          {tab === "Model routing" && (
            <div className="routing-panel">
              <h2>Routing simulator</h2>
              <label>
                Complexity score
                <Select
                  aria-label="Complejidad de routing"
                  value={complexity}
                  onChange={(v) => setComplexity(v)}
                  options={[1, 2, 3, 4, 5].map((value) => ({ value: String(value), label: value }))}
                />
              </label>
              <section className="callout">
                <h3>Policy result · preview</h3>
                <p>
                  {Number(complexity) <= 2
                    ? "Mono-agent · worker rápido · sin delegación"
                    : "Reasoner → workers con lanes justificadas → reviewer independiente"}
                </p>
                <p className="mono">
                  route: {Number(complexity) <= 2 ? "simple_task" : "planned_workflow"} · role:
                  worker · auth: capability per profile
                </p>
              </section>
              <Hint>Simulador de ejemplo, sin consultas a modelos.</Hint>
            </div>
          )}
          {tab === "Quality gates" && (
            <div className="gates-layout">
              <div>
                {["Typecheck", "Lint", "Tests", "Contract compatibility", "Independent review"].map(
                  (label) => (
                    <button
                      type="button"
                      className={`gate-row ${gate === label ? "selected" : ""}`}
                      onClick={() => setGate(label)}
                      key={label}
                    >
                      <ShieldCheck size={16} />
                      <span>{label}</span>
                      <span className="role">required</span>
                    </button>
                  ),
                )}
              </div>
              <section className="callout">
                <h2>{gate}</h2>
                <p>
                  El daemon ejecuta el runner independiente y guarda evidencia ligada al SHA del
                  diff.
                </p>
                <pre>
                  {gate === "Typecheck"
                    ? "bun run typecheck\nexit_code: 0\nbase_sha: 3e1d9c0"
                    : "Required check · no waiver without human rationale"}
                </pre>
                <Hint>Evidence fixture · no check se ha ejecutado desde esta pantalla.</Hint>
              </section>
            </div>
          )}
          {tab === "Evals" && (
            <>
              <h2>Evaluación de perfiles</h2>
              <table>
                <thead>
                  <tr>
                    <th>Suite</th>
                    <th>Perfil</th>
                    <th>Resultado</th>
                    <th>Costo / tarea</th>
                    <th>Estado</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td>fixture suite v3 · 20 tasks</td>
                    <td>
                      {profile.name} v{profile.version}
                    </td>
                    <td>18 / 20</td>
                    <td>$0.42 estimado</td>
                    <td className="added">
                      <Check size={12} /> Example
                    </td>
                  </tr>
                </tbody>
              </table>
              <Hint>
                Los evals reales requieren un corpus y ejecuciones reproducibles del backend.
              </Hint>
            </>
          )}
        </div>
      )}
      {edit && (
        <Modal title="Editar borrador del perfil" onClose={() => setEdit(false)}>
          <form
            onSubmit={(e) => {
              e.preventDefault()
              setProfiles((old) =>
                old.map((entry, index) =>
                  index === selected
                    ? {
                        ...entry,
                        name: name.trim(),
                        scope: scope.trim(),
                        version: entry.version + 1,
                        state: "Borrador local",
                      }
                    : entry,
                ),
              )
              setEdit(false)
            }}
          >
            <label>
              Nombre
              <input value={name} onChange={(e) => setName(e.target.value)} required />
            </label>
            <label>
              File scope
              <input value={scope} onChange={(e) => setScope(e.target.value)} required />
            </label>
            <Hint>Se crea una versión local de ejemplo. No se modifica ningún run.</Hint>
            <div className="modal-actions">
              <Button onClick={() => setEdit(false)}>Cancelar</Button>
              <button type="submit" className="button primary">
                Guardar borrador local
              </button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  )
}
