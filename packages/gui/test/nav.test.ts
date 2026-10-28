/** ADR-0034 §4: abrir apila, «atrás» devuelve el lugar exacto en orden inverso. */
import { describe, expect, test } from "bun:test"
import { current, go, type Nav, patch, push, replace, startNav, trail } from "../src/nav.ts"

const back = (nav: Nav) => go(nav, nav.index - 1)

describe("pila de lugares", () => {
  test("KEEL-3 → KEEL-1 → run → detalle; «atrás» regresa en orden inverso", () => {
    let nav = startNav("board")
    nav = push(nav, { page: "task", task: "k3" })
    nav = patch(nav, (p) => ({
      ...p,
      state: { tab: "Plan" },
      scroll: [{ path: [0], top: 420, left: 0 }],
    }))
    nav = push(nav, { page: "task", task: "k1" })
    nav = push(nav, { page: "run", run: "r1" })
    nav = push(nav, { page: "run", run: "r1", detail: { kind: "markdown", title: "t", text: "x" } })
    expect(current(nav).detail?.title).toBe("t")
    nav = back(nav)
    expect(current(nav)).toMatchObject({ page: "run", run: "r1" })
    expect(current(nav).detail).toBeUndefined()
    nav = back(nav)
    expect(current(nav).task).toBe("k1")
    nav = back(nav)
    expect(current(nav)).toMatchObject({ task: "k3", state: { tab: "Plan" } })
    expect(current(nav).scroll).toEqual([{ path: [0], top: 420, left: 0 }])
    nav = back(nav)
    expect(current(nav).page).toBe("board")
    expect(back(nav)).toBe(nav)
  })

  test("abrir algo después de «atrás» descarta lo que estaba adelante", () => {
    let nav = push(push(startNav("board"), { page: "task", task: "a" }), {
      page: "task",
      task: "b",
    })
    nav = push(back(nav), { page: "task", task: "c" })
    expect(nav.stack.map((p) => p.task ?? p.page)).toEqual(["board", "a", "c"])
  })

  test("abrir el lugar actual no apila", () => {
    const nav = push(startNav("board"), { page: "task", task: "a" })
    expect(push(nav, { page: "task", task: "a" })).toBe(nav)
  })

  test("seguir a un run hijo reemplaza: «atrás» no vuelve al padre que reenvía", () => {
    let nav = push(push(startNav("board"), { page: "task", task: "a" }), { page: "run", run: "p" })
    nav = replace(nav, { page: "run", run: "hijo" })
    expect(current(nav).run).toBe("hijo")
    expect(current(back(nav)).task).toBe("a")
  })

  test("el camino de referencias empieza en la última sección", () => {
    let nav = startNav("board")
    nav = push(nav, { page: "inbox" })
    nav = push(nav, { page: "task", task: "k3" })
    nav = push(nav, { page: "task", task: "k1" })
    nav = push(nav, { page: "run", run: "r1" })
    nav = push(nav, { page: "run", run: "r1", detail: { kind: "markdown", title: "t", text: "x" } })
    expect(trail(nav).map((c) => [c.place.task ?? c.place.run ?? c.place.page, c.back])).toEqual([
      ["inbox", 4],
      ["k3", 3],
      ["k1", 2],
      // Con el detalle abierto, la miga del run lo cierra.
      ["r1", 1],
    ])
  })
})
