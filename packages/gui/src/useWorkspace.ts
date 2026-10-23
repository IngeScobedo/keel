import type { EventNotification, MethodName, Methods } from "@keel/core"
import { useCallback, useEffect, useRef, useState } from "react"
import {
  defaultSocketPath,
  ensureDaemon,
  hasNativeShell,
  KeelClient,
  mutationMeta,
  NativeWire,
} from "./client.js"
import { DEMO_PROJECT, demoRuns, demoTasks } from "./fixtures.js"
import { applyEvent, mergeReplay, type Snapshot, touchesInbox, type WorkItem } from "./model.js"

type ProjectView = ReturnType<(typeof Methods)["projects.open"]["result"]["parse"]>
type RepoState = ReturnType<(typeof Methods)["projects.status"]["result"]["parse"]>

const SOCKET_KEY = "keel-socket"
function rememberedSocket(): string | null {
  try {
    return localStorage.getItem(SOCKET_KEY)
  } catch {
    return null
  }
}

export function useWorkspace() {
  const [snapshot, setSnapshot] = useState<Snapshot>({ work_items: demoTasks, runs: demoRuns })
  const [mode, setMode] = useState<"demo" | "connecting" | "live" | "offline">("demo")
  /** Qué hace la ventana mientras no hay conexión: arrancar el daemon o conectar. */
  const [phase, setPhase] = useState("")
  const [projects, setProjects] = useState<ProjectView[]>([])
  const [repo, setRepo] = useState<RepoState | null>(null)
  const [events, setEvents] = useState<EventNotification[]>([])
  const [error, setError] = useState("")
  /** Sube con cada evento que cambia aprobaciones, emparejamientos o peticiones de run. */
  const [inboxTick, setInboxTick] = useState(0)
  const [socketPath, setSocketPath] = useState(rememberedSocket() ?? "")
  const [health, setHealth] = useState<{
    event_loop_lag_ms: number
    rss_bytes: number
    project?: { id: string; root_path: string } | undefined
  } | null>(null)
  const project = useRef(DEMO_PROJECT)
  const client = useRef<KeelClient | null>(null)
  const cleanup = useRef<(() => void) | null>(null)
  const generation = useRef(0)

  const disconnect = useCallback(async () => {
    generation.current++
    cleanup.current?.()
    cleanup.current = null
    const old = client.current
    client.current = null
    if (old) await old.disconnect().catch(() => {})
    setHealth(null)
  }, [])

  const connect = useCallback(
    async (path: string, projectId: string) => {
      await disconnect()
      const currentGeneration = generation.current
      setMode("connecting")
      setError("")
      setEvents([])
      setSnapshot({ work_items: [], runs: [] })
      const rpc = new KeelClient(new NativeWire())
      client.current = rpc
      project.current = projectId
      const buffered: EventNotification[] = []
      let ready = false
      try {
        // Listener antes de subscribe: el servidor hace replay antes de responder.
        cleanup.current = await rpc.subscribe((event) => {
          if (generation.current !== currentGeneration) return
          if (touchesInbox(event.kind)) setInboxTick((n) => n + 1)
          if (!ready) buffered.push(event)
          setEvents((old) =>
            [...old.filter((item) => item.event_seq !== event.event_seq), event].slice(-300),
          )
          if (ready) setSnapshot((old) => applyEvent(old, event, project.current))
        })
        await rpc.connect(path)
        // El proyecto pedido queda activo en esta conexión (ADR-0019 §2): lo que se cree
        // desde aquí va a él.
        if (projectId) await rpc.call("projects.use", { project_id: projectId })
        const daemonHealth = await rpc.call("daemon.health", {})
        if (generation.current !== currentGeneration) return
        setHealth(daemonHealth)
        // El daemon dice a qué proyecto sirve; un daemon viejo no lo dice y se
        // descubre del primer evento.
        const wanted = projectId || daemonHealth.project?.id || ""
        if (wanted) project.current = wanted
        let result = await rpc
          .call("events.subscribe", wanted ? { project_id: wanted } : {})
          .catch(async (e: { rpc?: { code: number; details?: { min_cursor?: number } } }) => {
            // ADR-0012 §8: la historia anterior se purgó; snapshot y replay desde el mínimo.
            const min = e.rpc?.code === -32009 ? e.rpc.details?.min_cursor : undefined
            if (min === undefined) throw e
            return rpc.call("events.subscribe", {
              ...(wanted ? { project_id: wanted } : {}),
              after_event_seq: min,
            })
          })
        const discovered = wanted || buffered[0]?.project_id
        if (discovered && !wanted) {
          project.current = discovered
          await rpc.call("events.unsubscribe", { subscription_id: result.subscription_id })
          result = await rpc.call("events.subscribe", { project_id: discovered })
        }
        if (generation.current !== currentGeneration) return
        setSnapshot(mergeReplay(result.snapshot, buffered, project.current))
        ready = true
        setMode("live")
        setPhase("")
        void rpc
          .call("projects.list", {})
          .then((r) => setProjects(r.projects))
          .catch(() => setProjects([]))
        void rpc
          .call("projects.status", {})
          .then(setRepo)
          .catch(() => setRepo(null))
        setSocketPath(path)
        try {
          localStorage.setItem(SOCKET_KEY, path)
        } catch {
          /* Preferencia no crítica. */
        }
      } catch (e) {
        if (generation.current !== currentGeneration) return
        setError(e instanceof Error ? e.message : "No se pudo conectar al daemon")
        setMode("offline")
        await disconnect()
      }
    },
    [disconnect],
  )

  // Health es lectura y detecta sockets cerrados sin reenviar mutaciones.
  useEffect(() => {
    if (mode !== "live") return
    const timer = setInterval(() => {
      const rpc = client.current
      if (!rpc) return
      void rpc
        .call("projects.status", {})
        .then(setRepo)
        .catch(() => {})
      void rpc
        .call("daemon.health", {})
        .then(setHealth)
        .catch((e: unknown) => {
          setMode("offline")
          setError(e instanceof Error ? e.message : "Daemon desconectado")
          void disconnect()
        })
    }, 5000)
    return () => clearInterval(timer)
  }, [mode, disconnect])
  useEffect(
    () => () => {
      void disconnect()
    },
    [disconnect],
  )
  // En la ventana nativa se conecta solo al daemon por defecto (o al último usado).
  useEffect(() => {
    if (!hasNativeShell()) return
    void (async () => {
      // Siempre el daemon por defecto (o KEEL_SOCKET): el último socket usado sólo
      // rellena el formulario. Reusarlo conectaba a un daemon que ya no era el tuyo.
      const path = await defaultSocketPath().catch(() => "")
      if (!path) return
      setSocketPath(path)
      // Si nadie escucha, la ventana arranca el daemon (ADR-0019 §1); cerrarla no lo detiene.
      setMode("connecting")
      setPhase("Arrancando el daemon…")
      try {
        await ensureDaemon(path)
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
      }
      setPhase("Conectando…")
      await connect(path, "")
    })()
  }, [connect])

  /** Llamada al daemon en modo live; los errores del daemon llegan con su mensaje. */
  const call = useCallback(
    async <M extends MethodName>(
      method: M,
      params: unknown,
    ): Promise<ReturnType<(typeof Methods)[M]["result"]["parse"]>> => {
      if (mode !== "live" || !client.current) throw new Error("Conecta el daemon primero")
      return client.current.call(method, params)
    },
    [mode],
  )

  /** Cambia de proyecto: la conexión nueva se suscribe a él y lo deja activo. */
  const switchProject = useCallback(
    async (projectId: string) => {
      if (socketPath) await connect(socketPath, projectId)
    },
    [connect, socketPath],
  )
  /** Abre una carpeta como proyecto (o la reabre) y cambia a él. */
  const openProject = useCallback(
    async (path: string) => {
      if (!client.current) throw new Error("Conecta el daemon primero")
      const opened = await client.current.call("projects.open", { path })
      await switchProject(opened.id)
      return opened
    },
    [switchProject],
  )
  // Rama y cambios del repo: al terminar un run o tocar un worktree, se releen.
  const lastKind = events[events.length - 1]?.kind ?? ""
  useEffect(() => {
    if (mode !== "live" || !client.current) return
    if (!/^(worktree\.|workspace\.|run\.updated)/.test(lastKind)) return
    void client.current
      .call("projects.status", {})
      .then(setRepo)
      .catch(() => {})
  }, [lastKind, mode])

  async function create(title: string, spec: string, kind = "feature"): Promise<WorkItem> {
    if (mode === "demo") {
      const item: WorkItem = {
        id: `demo-${crypto.randomUUID()}`,
        project_id: DEMO_PROJECT,
        display_id: `KEEL-${Math.max(151, ...snapshot.work_items.map((w) => Number(w.display_id.split("-")[1]) || 0)) + 1}`,
        title,
        lifecycle: "triage",
        visual_state: "queued",
        board_status: "backlog",
        revision: 0,
      }
      setSnapshot((old) => ({ ...old, work_items: [...old.work_items, item] }))
      return item
    }
    if (mode !== "live" || !client.current)
      throw new Error("Conecta el daemon antes de crear tareas")
    const item = await client.current.call("work_items.create", {
      ...mutationMeta(),
      title,
      kind,
      spec_markdown: spec,
    })
    if (!project.current) project.current = item.project_id
    setSnapshot((old) => ({
      ...old,
      work_items: [...old.work_items.filter((w) => w.id !== item.id), item],
    }))
    return item
  }
  function updateDemo(item: WorkItem) {
    if (mode === "demo")
      setSnapshot((old) => ({
        ...old,
        work_items: old.work_items.map((w) => (w.id === item.id ? item : w)),
      }))
  }
  async function showDemo() {
    await disconnect()
    project.current = DEMO_PROJECT
    setSnapshot({ work_items: demoTasks, runs: demoRuns })
    setEvents([])
    setError("")
    setMode("demo")
  }
  return {
    ...snapshot,
    mode,
    error,
    health,
    events,
    inboxTick,
    socketPath,
    phase,
    projects,
    repo,
    switchProject,
    openProject,
    connect,
    create,
    showDemo,
    updateDemo,
    call,
  }
}
