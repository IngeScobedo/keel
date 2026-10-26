import {
  Activity,
  ArrowRight,
  Bot,
  ChevronDown,
  CircleDot,
  Command,
  FileText,
  FolderGit2,
  FolderOpen,
  GitBranch,
  Inbox as InboxIcon,
  LayoutGrid,
  Moon,
  PenTool,
  Plug,
  Plus,
  Search,
  Settings as SettingsIcon,
  ShieldCheck,
  Sun,
  Terminal,
} from "lucide-react"
import { type FormEvent, useEffect, useState } from "react"
import { Board } from "./Board.js"
import { ControlPlane } from "./ControlPlane.js"
import { hasNativeShell } from "./client.js"
import { demoDetails } from "./fixtures.js"
import { Inbox } from "./Inbox.js"
import { Inspector } from "./Inspector.js"
import { LiveConnections } from "./LiveConnections.js"
import { LiveInbox } from "./LiveInbox.js"
import { LivePlugins } from "./LivePlugins.js"
import { LiveProviders } from "./LiveProviders.js"
import { formatCost, type Run, type TaskDetails, type WorkItem } from "./model.js"
import { Permissions } from "./Permissions.js"
import { RunsList, RunView } from "./RunView.js"
import { Connections, DesignStudio, Settings, Workbench } from "./SupportViews.js"
import { Button, Hint, Modal } from "./ui.js"
import { useWorkspace } from "./useWorkspace.js"

const nav = [
  { id: "board", label: "Board", icon: LayoutGrid },
  { id: "inbox", label: "Inbox", icon: InboxIcon },
  { id: "runs", label: "Runs", icon: Activity },
  { id: "workbench", label: "Workbench", icon: Terminal },
  { id: "design", label: "Design Studio", icon: PenTool },
  { id: "permissions", label: "Permisos", icon: ShieldCheck },
  { id: "connections", label: "Connections", icon: Plug },
  { id: "agents", label: "Agent Control Plane", icon: Bot },
  { id: "settings", label: "Project setup", icon: SettingsIcon },
] as const
type Page = (typeof nav)[number]["id"] | "task" | "run"
function initialTheme() {
  try {
    return localStorage.getItem("keel-theme") === "light" ? "light" : "dark"
  } catch {
    return "dark"
  }
}

export function App() {
  const workspace = useWorkspace()
  const [page, setPage] = useState<Page>("board")
  const [theme, setTheme] = useState(initialTheme)
  const [selectedTask, setSelectedTask] = useState("")
  const [selectedRun, setSelectedRun] = useState("")
  const [palette, setPalette] = useState(false)
  const [paletteQuery, setPaletteQuery] = useState("")
  const [newTask, setNewTask] = useState(false)
  const [connection, setConnection] = useState(false)
  const [title, setTitle] = useState("")
  const [spec, setSpec] = useState("")
  const [kind, setKind] = useState("feature")
  const [submitError, setSubmitError] = useState("")
  const [busy, setBusy] = useState(false)
  const [path, setPath] = useState(workspace.socketPath || "")
  useEffect(() => {
    if (workspace.socketPath) setPath(workspace.socketPath)
  }, [workspace.socketPath])
  const [projectId, setProjectId] = useState("")
  const [localDetails, setLocalDetails] = useState<Record<string, TaskDetails>>({})
  const [switcher, setSwitcher] = useState(false)
  const [sessionNotes, setSessionNotes] = useState<Record<string, { id: string; text: string }[]>>(
    {},
  )
  const demo = workspace.mode === "demo"
  const [openPath, setOpenPath] = useState("")
  const currentProject = workspace.projects.find((p) => p.id === workspace.health?.project?.id)
  async function openFolder(path: string) {
    try {
      await workspace.openProject(path)
      setOpenPath("")
      setPage("board")
    } catch (e) {
      setSubmitError(e instanceof Error ? e.message : String(e))
      setConnection(true)
    }
  }
  async function pickFolder() {
    // Diálogo nativo (tauri-plugin-dialog, ADR-0019 §2); en el navegador no existe.
    try {
      const { open } = await import("@tauri-apps/plugin-dialog")
      const chosen = await open({ directory: true, multiple: false, title: "Abrir proyecto" })
      if (typeof chosen === "string") await openFolder(chosen)
    } catch (e) {
      setSubmitError(e instanceof Error ? e.message : String(e))
    }
  }
  const details = demo ? { ...demoDetails, ...localDetails } : {}
  const task = workspace.work_items.find((item) => item.id === selectedTask)
  const run = workspace.runs.find((item) => item.id === selectedRun)
  const runTask = workspace.work_items.find((item) => item.id === run?.work_item_id)
  const activeRuns = workspace.runs.filter((item) => item.status === "running")

  function openTask(item: WorkItem) {
    setSelectedTask(item.id)
    setPage("task")
    setPalette(false)
  }
  function openRun(item: Run) {
    setSelectedRun(item.id)
    setPage("run")
    setPalette(false)
  }
  useEffect(() => {
    document.documentElement.dataset.theme = theme
    try {
      localStorage.setItem("keel-theme", theme)
    } catch {
      /* Preferencia no crítica. */
    }
  }, [theme])
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault()
        setPalette((value) => !value)
        return
      }
      const target = event.target as HTMLElement
      if (
        target.matches("input, textarea, select") ||
        target.isContentEditable ||
        document.querySelector("dialog[open]")
      )
        return
      if (event.key.toLowerCase() === "c" && !event.metaKey && !event.ctrlKey) {
        event.preventDefault()
        setNewTask(true)
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [])
  async function create(event: FormEvent) {
    event.preventDefault()
    if (!title.trim() || busy) return
    setBusy(true)
    setSubmitError("")
    try {
      const created = await workspace.create(title.trim(), spec.trim(), kind)
      if (demo)
        setLocalDetails((old) => ({
          ...old,
          [created.id]: {
            repo: "sin asignar",
            assignee: "YO",
            role: "unassigned",
            labels: [],
            spec: spec.trim(),
            steps: [0, 0],
          },
        }))
      setNewTask(false)
      setTitle("")
      setSpec("")
      openTask(created)
    } catch (e) {
      setSubmitError(e instanceof Error ? e.message : "No se pudo crear la tarea")
    } finally {
      setBusy(false)
    }
  }
  // ADR-0017: con el daemon, la paleta busca también en notas y evidencia (FTS, léxico).
  const [found, setFound] = useState<
    { ref: string; kind: string; title: string; snippet: string }[]
  >([])
  const live = workspace.mode === "live"
  const call = workspace.call
  useEffect(() => {
    if (!palette || !live || paletteQuery.trim().length < 2) {
      setFound([])
      return
    }
    const t = setTimeout(() => {
      call("context.search", { query: paletteQuery, limit: 12 })
        .then((r) => setFound(r.results.filter((x) => x.kind !== "task")))
        .catch(() => setFound([]))
    }, 200)
    return () => clearTimeout(t)
  }, [palette, live, call, paletteQuery])
  const commandTasks = workspace.work_items.filter((item) =>
    `${item.display_id} ${item.title}`.toLowerCase().includes(paletteQuery.toLowerCase()),
  )
  const commandPages = nav.filter((item) =>
    item.label.toLowerCase().includes(paletteQuery.toLowerCase()),
  )
  return (
    <div className="app-shell">
      <header className="app-header">
        <span className="keel-mark" title="Keel">
          ⠿
        </span>
        <div className="workspace-menu">
          <Button
            icon={FolderGit2}
            onClick={() => setSwitcher((value) => !value)}
            aria-expanded={switcher}
            aria-label="Proyecto"
          >
            {demo
              ? "keel-api"
              : currentProject?.name || repoName(workspace.health?.project?.root_path)}
            <ChevronDown size={12} />
          </Button>
          {!demo && workspace.repo?.git && <RepoBadge git={workspace.repo.git} />}
          {!demo && workspace.repo && !workspace.repo.git && (
            <span className="repo-badge muted">sin git</span>
          )}
          {switcher && (
            <div className="workspace-popover">
              <h3>Proyectos</h3>
              {workspace.projects.map((p) => (
                <button
                  type="button"
                  key={p.id}
                  aria-current={p.id === currentProject?.id ? "true" : undefined}
                  onClick={() => {
                    setSwitcher(false)
                    setPage("board")
                    void workspace.switchProject(p.id)
                  }}
                >
                  <FolderGit2 size={15} />
                  {p.name}
                  <small className="mono">{p.root_path}</small>
                </button>
              ))}
              <button
                type="button"
                disabled={workspace.mode !== "live"}
                onClick={() => {
                  setSwitcher(false)
                  void pickFolder()
                }}
              >
                <FolderOpen size={15} />
                Abrir carpeta…<small>Elige un repo o carpeta del disco</small>
              </button>
              <form
                className="open-path"
                onSubmit={(e) => {
                  e.preventDefault()
                  if (!openPath.trim()) return
                  setSwitcher(false)
                  void openFolder(openPath.trim())
                }}
              >
                <input
                  aria-label="Ruta de la carpeta"
                  placeholder="/ruta/al/repo"
                  value={openPath}
                  onChange={(e) => setOpenPath(e.target.value)}
                  disabled={workspace.mode !== "live"}
                />
                <button type="submit" className="button" disabled={workspace.mode !== "live"}>
                  Abrir
                </button>
              </form>
              <h3>Otros</h3>
              <button
                type="button"
                onClick={() => {
                  setSwitcher(false)
                  void workspace.showDemo()
                  setPage("board")
                }}
              >
                <FolderGit2 size={15} />
                keel-api <small>Ejemplos del canvas</small>
              </button>
              <button
                type="button"
                onClick={() => {
                  setSwitcher(false)
                  setConnection(true)
                }}
              >
                <Plug size={15} />
                Conectar daemon<small>Socket local</small>
              </button>
            </div>
          )}
        </div>
        <button
          type="button"
          className="global-search"
          onClick={() => {
            setPaletteQuery("")
            setPalette(true)
          }}
        >
          <Search size={14} />
          <span>Search tasks, files, commits, agents…</span>
          <kbd>⌘K</kbd>
        </button>
        <div className="header-status">
          <span className={`health-dot ${workspace.mode}`} />
          <button type="button" onClick={() => setConnection(true)}>
            {demo
              ? "Prototipo · datos de ejemplo"
              : workspace.mode === "live"
                ? `keeld · ${workspace.health?.project?.root_path ?? "proyecto"}`
                : workspace.mode === "connecting"
                  ? workspace.phase || "Connecting…"
                  : "Daemon offline"}
          </button>
        </div>
        <Button
          variant="ghost"
          icon={InboxIcon}
          aria-label="Abrir Inbox"
          onClick={() => setPage("inbox")}
        />
        <Button
          variant="ghost"
          icon={theme === "dark" ? Sun : Moon}
          aria-label={theme === "dark" ? "Activar tema claro" : "Activar tema oscuro"}
          onClick={() => setTheme((value) => (value === "dark" ? "light" : "dark"))}
        />
      </header>
      <nav className="nav-rail" aria-label="Navegación principal">
        {nav.map((item) => (
          <button
            type="button"
            key={item.id}
            title={item.label}
            aria-label={item.label}
            aria-current={
              page === item.id ||
              (item.id === "board" && page === "task") ||
              (item.id === "runs" && page === "run")
                ? "page"
                : undefined
            }
            onClick={() => setPage(item.id)}
          >
            <item.icon size={17} strokeWidth={1.5} />
            {item.id === "inbox" &&
              workspace.work_items.some(
                (t) => t.lifecycle === "waiting_human" || t.visual_state === "waiting_human",
              ) && <span className="nav-count">!</span>}
          </button>
        ))}
        <div className="rail-spacer" />
        <button
          type="button"
          title="Command palette"
          aria-label="Command palette"
          onClick={() => setPalette(true)}
        >
          <Command size={17} />
        </button>
      </nav>
      <main className="main-content">
        {workspace.error && !connection && (
          <div className="error-banner" role="alert">
            {workspace.error}
            <Button onClick={() => setConnection(true)}>Revisar conexión</Button>
          </div>
        )}
        {page === "board" && (
          <Board
            tasks={workspace.work_items}
            runs={workspace.runs}
            details={details}
            demo={demo}
            onSelect={openTask}
            onRun={openRun}
            onNew={() => setNewTask(true)}
          />
        )}
        {page === "task" &&
          (task ? (
            <Inspector
              key={task.id}
              task={task}
              {...(details[task.id] ? { details: details[task.id] } : {})}
              demo={demo}
              runs={workspace.runs}
              events={workspace.events}
              onBack={() => setPage("board")}
              onRun={openRun}
              onUpdate={workspace.updateDemo}
              notes={sessionNotes[task.id] ?? []}
              {...(workspace.mode === "live" ? { call: workspace.call } : {})}
              onAddNote={(text) =>
                setSessionNotes((old) => ({
                  ...old,
                  [task.id]: [{ id: crypto.randomUUID(), text }, ...(old[task.id] ?? [])],
                }))
              }
            />
          ) : (
            <div className="padded">
              <Button onClick={() => setPage("board")}>Volver al tablero</Button>
              <Hint>La tarea no pertenece al workspace conectado.</Hint>
            </div>
          ))}
        {page === "runs" && (
          <RunsList runs={workspace.runs} tasks={workspace.work_items} onRun={openRun} />
        )}
        {page === "run" &&
          (run ? (
            <RunView
              key={run.id}
              run={run}
              {...(runTask ? { task: runTask } : {})}
              demo={demo}
              events={workspace.events}
              onBack={() => setPage("runs")}
              onTask={() => {
                if (runTask) openTask(runTask)
              }}
              {...(workspace.mode === "live" ? { call: workspace.call } : {})}
              runs={workspace.runs}
              onRun={openRun}
              onOpenTask={(id) => {
                const item = workspace.work_items.find((w) => w.id === id)
                if (item) openTask(item)
              }}
            />
          ) : (
            <div className="padded">
              <Button onClick={() => setPage("runs")}>Volver a runs</Button>
            </div>
          ))}
        {page === "inbox" && workspace.mode === "live" && (
          <LiveInbox
            call={workspace.call}
            tick={workspace.inboxTick}
            tasks={workspace.work_items}
            runs={workspace.runs}
            onTask={openTask}
            onRun={openRun}
          />
        )}
        {page === "inbox" && workspace.mode !== "live" && (
          <Inbox
            key={workspace.mode}
            demo={demo}
            tasks={workspace.work_items}
            runs={workspace.runs}
            events={workspace.events}
            onTask={openTask}
          />
        )}
        {page === "permissions" &&
          (workspace.mode === "live" ? (
            <Permissions
              call={workspace.call}
              tick={workspace.inboxTick}
              tasks={workspace.work_items}
              runs={workspace.runs}
            />
          ) : (
            <div className="padded">
              <Hint>Conecta el daemon para ver y revocar lo que has permitido.</Hint>
            </div>
          ))}
        {page === "agents" && <ControlPlane demo={demo} />}
        {page === "connections" &&
          (workspace.mode === "live" ? (
            <LiveConnections call={workspace.call} tick={workspace.inboxTick} />
          ) : (
            <Connections demo={demo} />
          ))}
        {page === "workbench" && <Workbench demo={demo} />}
        {page === "design" && <DesignStudio />}
        {page === "settings" && (
          <>
            <Settings
              mode={workspace.mode}
              onConnect={() => setConnection(true)}
              onDemo={() => {
                void workspace.showDemo()
                setPage("board")
              }}
            />
            {workspace.mode === "live" && (
              <div className="padded">
                <LiveProviders call={workspace.call} />
                <LivePlugins call={workspace.call} />
              </div>
            )}
          </>
        )}
      </main>
      <footer className="status-bar">
        <span>
          <GitIcon />
          {demo ? "keel/KEEL-142-auth-retry · ejemplo" : "IPC · keel_protocol: 1"}
        </span>
        <span className="status-spacer" />
        <span className="blue">
          <CircleDot size={10} />
          {activeRuns.length} runs {demo ? "de ejemplo" : "activos"}
        </span>
        <span>{demo ? "$12.40 hoy · estimado · ejemplo" : formatCost()}</span>
        <span className="muted">{demo ? "pen.dev · 107 tokens" : workspace.mode}</span>
      </footer>
      {palette && (
        <Modal title="Command palette" onClose={() => setPalette(false)}>
          <div className="palette-search">
            <Search size={17} />
            <input
              aria-label="Buscar comandos o tareas"
              placeholder="Search tasks and commands…"
              value={paletteQuery}
              onChange={(e) => setPaletteQuery(e.target.value)}
            />
          </div>
          <div className="palette-results">
            <h3>NAVIGATION</h3>
            {commandPages.map((item) => (
              <button
                type="button"
                key={item.id}
                onClick={() => {
                  setPage(item.id)
                  setPalette(false)
                }}
              >
                <item.icon size={15} />
                {item.label}
                <ArrowRight size={13} />
              </button>
            ))}
            <h3>TASKS</h3>
            {commandTasks.slice(0, 12).map((item) => (
              <button type="button" key={item.id} onClick={() => openTask(item)}>
                <span className="mono muted">{item.display_id}</span>
                {item.title}
              </button>
            ))}
            {found.length > 0 && <h3>NOTAS Y EVIDENCIA</h3>}
            {found.map((r) => (
              <button
                type="button"
                key={r.ref}
                data-testid="palette-context"
                onClick={() => setPalette(false)}
              >
                <span className="mono muted">{r.kind}</span>
                <span className="palette-snippet">{r.snippet}</span>
              </button>
            ))}
            {commandPages.length === 0 && commandTasks.length === 0 && found.length === 0 && (
              <Hint>No results.</Hint>
            )}
          </div>
        </Modal>
      )}
      {newTask && (
        <Modal
          title="New task"
          onClose={() => {
            if (!busy) setNewTask(false)
          }}
        >
          <form
            onSubmit={(event) => {
              void create(event)
            }}
          >
            <label>
              Title
              <input
                required
                data-autofocus
                maxLength={240}
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="What needs to change?"
              />
            </label>
            <label>
              Tipo
              <select
                aria-label="Tipo de tarea"
                value={kind}
                onChange={(e) => setKind(e.target.value)}
              >
                <option value="feature">feature</option>
                <option value="bug">bug</option>
                <option value="refactor">refactor</option>
                <option value="chore">chore</option>
                <option value="docs">docs</option>
                <option value="research">investigación</option>
              </select>
            </label>
            <label>
              Spec / acceptance criteria
              <textarea
                rows={6}
                value={spec}
                onChange={(e) => setSpec(e.target.value)}
                placeholder="Given… When… Then…"
              />
            </label>
            <Hint>
              {demo
                ? "Se crea en los ejemplos de esta sesión."
                : "Se crea en el proyecto default del daemon. No inicia agentes."}
            </Hint>
            {submitError && (
              <p role="alert" className="deleted">
                {submitError}
              </p>
            )}
            <div className="modal-actions">
              <Button disabled={busy} onClick={() => setNewTask(false)}>
                Cancel
              </Button>
              <button className="button primary" type="submit" disabled={!title.trim() || busy}>
                <Plus size={13} />
                {busy ? "Creating…" : "Create task"}
              </button>
            </div>
          </form>
        </Modal>
      )}
      {connection && (
        <Modal title="Conectar al daemon" onClose={() => setConnection(false)}>
          <form
            onSubmit={(event) => {
              event.preventDefault()
              void workspace.connect(path.trim(), projectId.trim()).then(() => {})
            }}
          >
            <label>
              Socket del host
              <input value={path} onChange={(e) => setPath(e.target.value)} required />
            </label>
            <label>
              Project ID (opcional)
              <input
                value={projectId}
                onChange={(e) => setProjectId(e.target.value)}
                placeholder="Se descubre del primer evento si existe"
              />
            </label>
            <Hint>
              {hasNativeShell()
                ? "El cascarón Tauri abre el socket; la GUI no lee SQLite. Usa la ruta que reporta el daemon al arrancar."
                : "Estás en el preview del navegador, que sólo muestra ejemplos. Para hablar con el daemon abre la ventana nativa con «bun run gui:desktop»."}
            </Hint>
            {workspace.mode === "live" && (
              <p className="added">
                Conectado · {workspace.work_items.length} tareas · {workspace.runs.length} runs
              </p>
            )}
            {workspace.error && (
              <p className="deleted" role="alert">
                {workspace.error}
              </p>
            )}
            <div className="modal-actions">
              <Button
                onClick={() => {
                  void workspace.showDemo()
                  setConnection(false)
                  setPage("board")
                }}
              >
                Usar ejemplos
              </Button>
              <button
                type="submit"
                className="button primary"
                disabled={!hasNativeShell() || workspace.mode === "connecting"}
              >
                {workspace.mode === "connecting" ? "Connecting…" : "Connect"}
              </button>
              <Button onClick={() => setConnection(false)}>Cerrar</Button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  )
}
/** Rama, adelanto o atraso y cambios del repo del proyecto activo. */
function RepoBadge({
  git,
}: {
  git: {
    branch: string | null
    head: string | null
    ahead: number
    behind: number
    changed: number
  }
}) {
  return (
    <span className="repo-badge" data-testid="repo-badge" title={git.head ?? "sin commits"}>
      <GitBranch size={12} />
      {git.branch ?? `HEAD ${git.head?.slice(0, 7) ?? "—"}`}
      {git.ahead > 0 && <span>↑{git.ahead}</span>}
      {git.behind > 0 && <span>↓{git.behind}</span>}
      {git.changed > 0 && <span className="amber">{git.changed} cambios</span>}
    </span>
  )
}

/** Último segmento de la carpeta que sirve el daemon, con `/` o `\\`. */
function repoName(root: string | undefined) {
  if (!root) return "daemon"
  return root.split(/[\\/]/).filter(Boolean).pop() ?? root
}
function GitIcon() {
  return <FileText size={11} aria-hidden="true" />
}
