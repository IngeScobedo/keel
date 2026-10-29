/**
 * La pila de lugares (ADR-0034 §4): abrir algo apila, «atrás» desapila y devuelve el
 * lugar tal cual estaba. La historia del WebView sólo guarda el índice; los lugares
 * viven aquí, en la sesión de la ventana.
 */

/** Lo abierto encima de la vista: «atrás» lo cierra antes de salir de ella. */
export type Detail = { kind: "markdown"; title: string; text: string }

/** Dónde estaba el scroll de un contenedor, por su posición en el árbol. */
export type ScrollMark = { path: number[]; top: number; left: number }

export type Place = {
  page: string
  /** El proyecto del daemon donde está (ADR-0034 §6): «atrás» vuelve a él. */
  project?: string
  task?: string
  run?: string
  /** Lo que la vista quiere recordar al volver: la pestaña, un filtro. */
  state: Record<string, unknown>
  detail?: Detail
  scroll?: ScrollMark[]
}

export type Nav = { stack: Place[]; index: number }

export function startNav(page: string): Nav {
  return { stack: [{ page, state: {} }], index: 0 }
}

export function current(nav: Nav): Place {
  return nav.stack[nav.index] as Place
}

/** El mismo lugar no se apila dos veces: abrir lo que ya está abierto no hace nada. */
export function samePlace(a: Place, b: Omit<Place, "state">): boolean {
  return (
    a.page === b.page &&
    (a.task ?? "") === (b.task ?? "") &&
    (a.run ?? "") === (b.run ?? "") &&
    a.detail === b.detail
  )
}

/** Apila: lo que estaba adelante (después de un «atrás») se descarta, como en el navegador. */
export function push(nav: Nav, place: Omit<Place, "state"> & { state?: Place["state"] }): Nav {
  const next: Place = { ...place, state: place.state ?? {} }
  if (samePlace(current(nav), next)) return nav
  return { stack: [...nav.stack.slice(0, nav.index + 1), next], index: nav.index + 1 }
}

/** Reemplaza el lugar actual sin apilar: seguir a un run hijo no deja una trampa atrás. */
export function replace(nav: Nav, place: Omit<Place, "state"> & { state?: Place["state"] }): Nav {
  if (samePlace(current(nav), place)) return nav
  const stack = [...nav.stack]
  stack[nav.index] = { ...place, state: place.state ?? {} }
  return { stack, index: nav.index }
}

export function go(nav: Nav, index: number): Nav {
  if (index < 0 || index >= nav.stack.length || index === nav.index) return nav
  return { ...nav, index }
}

/** Cambia el lugar actual (su pestaña, su scroll) sin moverse de él. */
export function patch(nav: Nav, f: (p: Place) => Place): Nav {
  const stack = [...nav.stack]
  stack[nav.index] = f(current(nav))
  return { stack, index: nav.index }
}

/** Las vistas que son una entidad: lo que forma el camino de referencias. */
const ENTITY_PAGES = new Set(["task", "run"])

/**
 * El camino de referencias hasta el lugar actual (KEEL-3 › KEEL-1 › run): los lugares
 * de entidad seguidos, desde la última sección. Cada uno lleva cuántos pasos atrás está.
 * Un detalle abierto no es una miga: es parte del lugar que lo abrió.
 */
export function trail(nav: Nav): { place: Place; back: number }[] {
  const out: { place: Place; back: number }[] = []
  for (let i = nav.index; i >= 0; i--) {
    const p = nav.stack[i] as Place
    if (!ENTITY_PAGES.has(p.page)) {
      out.unshift({ place: p, back: nav.index - i })
      break
    }
    if (p.detail) continue
    const prev = out[0]?.place
    if (prev && prev.page === p.page && prev.task === p.task && prev.run === p.run) continue
    out.unshift({ place: p, back: nav.index - i })
  }
  return out
}

// --- scroll ------------------------------------------------------------------------

/** Los contenedores con scroll bajo `root`, por su camino de índices. */
export function captureScroll(root: Element | null): ScrollMark[] {
  const out: ScrollMark[] = []
  if (!root) return out
  const walk = (el: Element, path: number[]) => {
    if (el.scrollTop > 0 || el.scrollLeft > 0)
      out.push({ path, top: el.scrollTop, left: el.scrollLeft })
    for (let i = 0; i < el.children.length; i++) walk(el.children[i] as Element, [...path, i])
  }
  walk(root, [])
  return out
}

function at(root: Element, path: number[]): Element | null {
  let el: Element | undefined = root
  for (const i of path) {
    el = el?.children[i]
    if (!el) return null
  }
  return el ?? null
}

/**
 * Devuelve cada contenedor a su scroll. El contenido puede llegar después (una tarea
 * que se relee del daemon): se reintenta por cuadros hasta que cabe o pasa `ms`.
 */
export function restoreScroll(root: Element | null, marks: ScrollMark[], ms = 1500): () => void {
  if (!root || marks.length === 0) return () => {}
  let pending = [...marks]
  const until = performance.now() + ms
  let frame = 0
  const step = () => {
    pending = pending.filter((m) => {
      const el = at(root, m.path)
      if (!el) return true
      el.scrollTop = m.top
      el.scrollLeft = m.left
      return Math.abs(el.scrollTop - m.top) > 1
    })
    if (pending.length && performance.now() < until) frame = requestAnimationFrame(step)
  }
  step()
  return () => cancelAnimationFrame(frame)
}
