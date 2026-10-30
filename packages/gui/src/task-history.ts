/**
 * La GUI guarda sólo los últimos eventos del proyecto (`EVENT_WINDOW`). Una tarea vieja
 * quedaba sin chat cuando otras tareas llenaban la ventana (KEEL-12 tras el lote de
 * KEEL-13): su historia se pide al daemon al abrirla y se junta con lo que llega en vivo.
 */
import type { EventNotification } from "@keel/core"
import { useCallback, useEffect, useMemo, useState } from "react"
import type { useWorkspace } from "./useWorkspace.js"

type Call = ReturnType<typeof useWorkspace>["call"]

const PAGE = 5000

export function useTaskHistory(call: Call | undefined, taskId: string, live: EventNotification[]) {
  const [older, setOlder] = useState<EventNotification[]>([])
  const [more, setMore] = useState(false)
  const [loading, setLoading] = useState(false)
  // El borde de la ventana: lo anterior no está en memoria. Se fija al abrir la tarea.
  const [edge] = useState(() =>
    live.length ? Math.min(...live.map((e) => e.event_seq)) : Number.MAX_SAFE_INTEGER,
  )

  const load = useCallback(
    async (before: number) => {
      if (!call) return
      setLoading(true)
      try {
        const r = await call("events.history", {
          work_item_id: taskId,
          before_event_seq: before,
          limit: PAGE,
        })
        setOlder((old) => [...r.events, ...old])
        setMore(r.more)
      } catch {
        // Sin la historia vieja la tarea se ve como antes: con lo que hay en la ventana.
      } finally {
        setLoading(false)
      }
    },
    [call, taskId],
  )

  useEffect(() => {
    void load(edge)
  }, [load, edge])

  const events = useMemo(() => {
    if (older.length === 0) return live
    const seen = new Set(live.map((e) => e.event_seq))
    return [...older.filter((e) => !seen.has(e.event_seq)), ...live]
  }, [older, live])

  const loadOlder = useCallback(() => {
    const first = older[0]?.event_seq
    if (first !== undefined) void load(first)
  }, [older, load])

  return { events, more, loading, loadOlder }
}
