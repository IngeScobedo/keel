/**
 * La pila de lugares conectada al WebView (ADR-0034 §4): `history.pushState` guarda el
 * índice, así «atrás» funciona con el botón de la vista, `Alt+←`, el botón lateral del
 * mouse y el gesto del trackpad, igual en Tauri y en el navegador.
 */
import { ChevronRight } from "lucide-react"
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react"
import {
  captureScroll,
  current,
  type Detail,
  go,
  type Nav,
  type Place,
  patch,
  push,
  replace,
  restoreScroll,
  startNav,
  trail,
} from "./nav.js"

type To = Omit<Place, "state"> & { state?: Place["state"] }

function editable(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false
  return t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)
}

export function useNavigation(root: () => Element | null) {
  const [nav, setNav] = useState<Nav>(() => startNav("board"))
  const ref = useRef(nav)
  const commit = useCallback((next: Nav) => {
    ref.current = next
    setNav(next)
  }, [])
  const marked = useCallback(
    () => patch(ref.current, (p) => ({ ...p, scroll: captureScroll(root()) })),
    [root],
  )
  const navigate = useCallback(
    (to: To) => {
      const before = marked()
      const next = push(before, to)
      if (next === before) return
      commit(next)
      history.pushState({ keel: next.index }, "")
    },
    [commit, marked],
  )
  const replaceTo = useCallback((to: To) => commit(replace(ref.current, to)), [commit])
  const back = useCallback(() => {
    if (ref.current.index > 0) history.back()
  }, [])
  const goBack = useCallback((steps: number) => {
    if (steps > 0 && steps <= ref.current.index) history.go(-steps)
  }, [])
  const setPlaceState = useCallback(
    (key: string, value: unknown) =>
      commit(patch(ref.current, (p) => ({ ...p, state: { ...p.state, [key]: value } }))),
    [commit],
  )
  useEffect(() => {
    history.replaceState({ keel: 0 }, "")
    const onPop = (e: PopStateEvent) => {
      const i = (e.state as { keel?: unknown } | null)?.keel
      commit(go(marked(), typeof i === "number" ? i : 0))
    }
    const onKey = (e: KeyboardEvent) => {
      if (!e.altKey || e.ctrlKey || e.metaKey || editable(e.target)) return
      if (e.key === "ArrowLeft") {
        e.preventDefault()
        history.back()
      } else if (e.key === "ArrowRight") {
        e.preventDefault()
        history.forward()
      }
    }
    // Botones laterales del mouse; preventDefault evita que el WebView también navegue.
    const onMouse = (e: MouseEvent) => {
      if (e.button !== 3 && e.button !== 4) return
      e.preventDefault()
      if (e.button === 3) history.back()
      else history.forward()
    }
    window.addEventListener("popstate", onPop)
    window.addEventListener("keydown", onKey)
    window.addEventListener("mouseup", onMouse)
    return () => {
      window.removeEventListener("popstate", onPop)
      window.removeEventListener("keydown", onKey)
      window.removeEventListener("mouseup", onMouse)
    }
  }, [commit, marked])
  // Sólo al cambiar de lugar: cambiar la pestaña del lugar actual no mueve el scroll.
  // biome-ignore lint/correctness/useExhaustiveDependencies: el índice es el disparador.
  useLayoutEffect(() => restoreScroll(root(), current(ref.current).scroll ?? []), [nav.index])
  return {
    nav,
    place: current(nav),
    trail: trail(nav),
    navigate,
    replace: replaceTo,
    back,
    goBack,
    setPlaceState,
  }
}

export type Crumb = { label: string; back: number }

type PlaceApi = {
  place: Place
  setPlaceState: (key: string, value: unknown) => void
  navigate: (to: To) => void
  goBack: (steps: number) => void
  /** El camino de referencias hasta aquí (ADR-0034 §4). */
  crumbs: Crumb[]
}

const PlaceContext = createContext<PlaceApi | null>(null)

export function PlaceProvider({ value, children }: { value: PlaceApi; children: ReactNode }) {
  return <PlaceContext.Provider value={value}>{children}</PlaceContext.Provider>
}

/**
 * Estado que el lugar recuerda: al volver con «atrás», la vista lo encuentra como lo
 * dejó. Fuera de un `PlaceProvider` (tests, vistas sueltas) es un `useState`.
 */
export function usePlaceState<T>(key: string, initial: T): [T, (v: T) => void] {
  const api = useContext(PlaceContext)
  const [local, setLocal] = useState(initial)
  if (!api) return [local, setLocal]
  const v = api.place.state[key]
  return [v === undefined ? initial : (v as T), (next: T) => api.setPlaceState(key, next)]
}

/** Abre un detalle encima del lugar actual; «atrás» o `Esc` lo cierran. */
export function useOpenDetail(): ((d: Detail) => void) | null {
  const api = useContext(PlaceContext)
  if (!api) return null
  const { place, navigate } = api
  return (detail) => {
    const { state: _s, scroll: _sc, ...rest } = place
    navigate({ ...rest, detail })
  }
}

/** Las migas del camino: cada una regresa a ese punto de la pila. */
export function Trail() {
  const api = useContext(PlaceContext)
  if (!api || api.crumbs.length === 0) return null
  const last = api.crumbs.length - 1
  return (
    <nav className="breadcrumbs" aria-label="Camino">
      {api.crumbs.map((c, i) =>
        i === last ? (
          <span key={c.back} className="mono" aria-current="page">
            {c.label}
          </span>
        ) : (
          <span key={c.back} className="crumb">
            <button type="button" onClick={() => api.goBack(c.back)}>
              {c.label}
            </button>
            <ChevronRight size={12} aria-hidden />
          </span>
        ),
      )}
    </nav>
  )
}
