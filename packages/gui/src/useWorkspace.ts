import type { EventNotification } from "@keel/core"
import { useCallback, useEffect, useRef, useState } from "react"
import { KeelClient, mutationMeta, NativeWire } from "./client.js"
import { DEMO_PROJECT, demoRuns, demoTasks } from "./fixtures.js"
import { applyEvent, mergeReplay, type Snapshot, type WorkItem } from "./model.js"

export function useWorkspace() {
  const [snapshot, setSnapshot] = useState<Snapshot>({ work_items: demoTasks, runs: demoRuns })
  const [mode, setMode] = useState<"demo" | "connecting" | "live" | "offline">("demo")
  const [events, setEvents] = useState<EventNotification[]>([])
  const [error, setError] = useState("")
  const [health, setHealth] = useState<{ event_loop_lag_ms: number; rss_bytes: number } | null>(
    null,
  )
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
          if (!ready) buffered.push(event)
          setEvents((old) =>
            [...old.filter((item) => item.event_seq !== event.event_seq), event].slice(-300),
          )
          if (ready) setSnapshot((old) => applyEvent(old, event, project.current))
        })
        await rpc.connect(path)
        const daemonHealth = await rpc.call("daemon.health", {})
        if (generation.current !== currentGeneration) return
        setHealth(daemonHealth)
        let result = await rpc.call("events.subscribe", projectId ? { project_id: projectId } : {})
        // Hasta que exista projects.list, el primer evento descubre el proyecto default.
        const discovered = projectId || buffered[0]?.project_id
        if (discovered && !projectId) {
          project.current = discovered
          await rpc.call("events.unsubscribe", { subscription_id: result.subscription_id })
          result = await rpc.call("events.subscribe", { project_id: discovered })
        }
        if (generation.current !== currentGeneration) return
        setSnapshot(mergeReplay(result.snapshot, buffered, project.current))
        ready = true
        setMode("live")
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

  async function create(title: string, spec: string): Promise<WorkItem> {
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
      kind: "feature",
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
  return { ...snapshot, mode, error, health, events, connect, create, showDemo, updateDemo }
}
