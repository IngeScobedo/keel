import {
  FileCode2,
  FolderGit2,
  GitCompareArrows,
  Monitor,
  Plug,
  ShieldCheck,
  Terminal,
} from "lucide-react"
import { useState } from "react"
import { hasNativeShell } from "./client.js"
import { demoDiff } from "./fixtures.js"
import { Select } from "./ui/index.js"
import { Button, Empty, Hint, Tabs } from "./ui.js"

export function Connections({ demo }: { demo: boolean }) {
  const [tab, setTab] = useState<"Connections" | "Contract hub">("Connections")
  const [version, setVersion] = useState("v1")
  return (
    <div className="page">
      <div className="toolbar">
        <h1>Connections</h1>
        <div className="toolbar-spacer" />
        <Button icon={Plug} disabled>
          New connection
        </Button>
      </div>
      <Tabs values={["Connections", "Contract hub"] as const} active={tab} onChange={setTab} />
      {!demo ? (
        <Empty title="Conexiones pendientes de integración">
          El protocolo aún no expone servidores MCP ni contratos.
        </Empty>
      ) : (
        <div className="padded">
          {tab === "Connections" ? (
            <>
              <Hint>Connections del diseño · no se han contactado estos servicios.</Hint>
              <table>
                <thead>
                  <tr>
                    <th>Connection</th>
                    <th>Target</th>
                    <th>Grant</th>
                    <th>State</th>
                  </tr>
                </thead>
                <tbody>
                  {[
                    ["Filesystem", "worktree:keel-api", "agent_ro", "Example healthy"],
                    ["Postgres", "keel-staging", "dry_run_then_ask", "Example needs approval"],
                    ["OpenPencil", "design artifacts", "read-only", "Integration pending"],
                    ["GitHub", "org/keel-api", "ask", "Example healthy"],
                  ].map(([name, target, grant, state]) => (
                    <tr key={name}>
                      <td>
                        <Plug size={13} /> {name}
                      </td>
                      <td className="mono">{target}</td>
                      <td>
                        <span className="role">{grant}</span>
                      </td>
                      <td>{state}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="callout">
                <ShieldCheck size={17} />
                <strong>Connection broker</strong>
                <p>
                  Las credenciales pertenecen al runtime y al vault del host. Los prompts y eventos
                  sólo reciben referencias saneadas.
                </p>
              </div>
            </>
          ) : (
            <>
              <div className="contract-heading">
                <div>
                  <h2>checkout_api</h2>
                  <p className="muted">backend → frontend · OpenAPI · append-only</p>
                </div>
                <Select
                  aria-label="Versión del contrato"
                  value={version}
                  onChange={(v) => setVersion(v)}
                  options={[
                    { value: "v1", label: "v1" },
                    { value: "v2", label: "v2" },
                  ]}
                />
              </div>
              <div className="callout" data-state={version === "v1" ? "succeeded" : "blocked"}>
                <strong>
                  {version === "v1"
                    ? "ready_for_mock · consumers can build"
                    : "Breaking change · reconciliation required"}
                </strong>
                <p>
                  {version === "v1"
                    ? "La interfaz consume el contrato v1 con un SDK tipado y mocks; el backend continúa implementando."
                    : "v1 se conserva. v2 agrega currency requerida; el consumidor necesita una subtarea de alineación."}
                </p>
              </div>
              <div className="contract-columns">
                <section>
                  <h3>Schema · {version}</h3>
                  <pre>{`POST /api/v1/checkout\nrequest:\n  items: [{ product_id, quantity }]${version === "v2" ? "\n  currency: string (required)" : ""}\nresponse:\n  checkout_id: string\n  total_cents: integer`}</pre>
                </section>
                <section>
                  <h3>Dependencies</h3>
                  <p className="mono">KEEL-135 · frontend</p>
                  <span className="role">required_state: ready_for_mock</span>
                  <p>
                    {version === "v1"
                      ? "Dependency satisfied · example"
                      : "Alinear cliente con contrato v2"}
                  </p>
                  <Hint>El hub es una vista del diseño; no modifica contratos reales.</Hint>
                </section>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}
export function Workbench({ demo }: { demo: boolean }) {
  const [tab, setTab] = useState<"Diff" | "Terminal" | "Preview">("Diff")
  return (
    <div className="page">
      <div className="toolbar">
        <h1>Workbench</h1>
        <span className="muted mono">
          {demo ? "keel/KEEL-142-auth-retry · ejemplo" : "No worktree selected"}
        </span>
        <div className="toolbar-spacer" />
        <Button icon={Terminal} disabled title="Requiere el host de PTY en el daemon">
          Neovim
        </Button>
        <Button icon={FolderGit2} disabled title="Requiere el host de PTY en el daemon">
          Lazygit
        </Button>
      </div>
      <Tabs values={["Diff", "Terminal", "Preview"] as const} active={tab} onChange={setTab} />
      {tab === "Diff" && demo ? (
        <div className="workbench-layout">
          <aside>
            <h3>CHANGED FILES</h3>
            <div className="selected file-row">
              <FileCode2 size={14} />
              src/auth/client.ts
            </div>
            <Hint>Fixture del diseño.</Hint>
          </aside>
          <section>
            <div className="diff-heading">
              <GitCompareArrows size={16} />
              src/auth/client.ts · +14 −3
            </div>
            <pre className="diff">
              {demoDiff.split("\n").map((line) => (
                <span
                  key={line}
                  className={line.startsWith("+") ? "added" : line.startsWith("-") ? "deleted" : ""}
                >
                  {line}
                  {"\n"}
                </span>
              ))}
            </pre>
          </section>
        </div>
      ) : (
        <Empty
          title={
            tab === "Terminal"
              ? "PTY pendiente de conexión"
              : tab === "Preview"
                ? "Sin servidor de preview"
                : "Sin diff disponible"
          }
          icon={tab === "Terminal" ? Terminal : Monitor}
        >
          {tab === "Terminal"
            ? "El cliente adjuntará la sesión del target cuando el daemon implemente pty.attach y su stream."
            : tab === "Preview"
              ? "La detección de puertos y el sandbox necesitan soporte del daemon."
              : "La lectura de diffs pasa por el daemon; el cliente no abre el repositorio."}
        </Empty>
      )}
    </div>
  )
}
export function DesignStudio() {
  return (
    <div className="page">
      <div className="toolbar">
        <h1>Design Studio</h1>
        <span className="muted">Artifacts · visual review</span>
      </div>
      <Empty title="Canvas pendiente de integración" icon={Monitor}>
        La conexión con OpenPencil requiere validar su SDK. La fuente visual actual de Keel es el
        canvas de pen.dev.
      </Empty>
    </div>
  )
}
export function Settings({
  mode,
  onConnect,
  onDemo,
}: {
  mode: string
  onConnect: () => void
  onDemo: () => void
}) {
  return (
    <div className="page">
      <div className="toolbar">
        <h1>Project setup</h1>
      </div>
      <div className="settings-layout">
        <aside>
          <strong>Workspace</strong>
          <p className="muted">Repositories</p>
          <p className="muted">Runtime target</p>
          <p className="muted">Permissions</p>
        </aside>
        <section>
          <h2>Runtime target & connection</h2>
          <p className="muted">
            La GUI habla con el daemon por el socket del host. Los ejemplos visuales funcionan
            también en el navegador.
          </p>
          <div className="callout">
            <h3>{hasNativeShell() ? "Tauri native shell" : "Browser preview"}</h3>
            <p>
              Mode: <code>{mode}</code>
            </p>
            <Button variant="primary" onClick={onConnect}>
              Configurar conexión
            </Button>
            <Button onClick={onDemo}>Volver a ejemplos</Button>
          </div>
          <h2>Repositorios federados</h2>
          <table>
            <thead>
              <tr>
                <th>Alias</th>
                <th>Source</th>
                <th>Context</th>
                <th>Availability</th>
              </tr>
            </thead>
            <tbody>
              {["backend", "frontend", "docs"].map((repo) => (
                <tr key={repo}>
                  <td>
                    <FolderGit2 size={13} /> {repo}
                  </td>
                  <td className="mono">org/{repo}</td>
                  <td>shared specs · contracts</td>
                  <td>Diseño · pendiente de backend</td>
                </tr>
              ))}
            </tbody>
          </table>
          <Hint>
            El editor de configuración y el bridge Windows ↔ WSL se conectarán cuando exista su
            contrato. No se modifican repositorios desde esta vista.
          </Hint>
        </section>
      </div>
    </div>
  )
}
