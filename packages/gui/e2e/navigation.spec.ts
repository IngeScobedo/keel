/**
 * ADR-0034 §4 y §5 contra un daemon real: el Markdown de una nota se ve renderizado y
 * cortado, «ver detalle» lo abre encima, una referencia abre otra tarea, y «atrás»
 * regresa en orden inverso al lugar exacto: misma pestaña y mismo scroll.
 */
import { expect, type Page, test } from "@playwright/test"
import { bootDaemon, type Daemon, nativeShell } from "./daemon-bridge.js"

let daemon: Daemon
test.beforeEach(async () => {
  daemon = await bootDaemon()
})
test.afterEach(async () => {
  daemon.proc.stdin?.end()
  await new Promise((r) => daemon.proc.once("exit", r))
})

async function newTask(page: Page, title: string): Promise<string> {
  await page.getByRole("button", { name: "New task", exact: false }).click()
  await page.getByLabel("Title", { exact: true }).fill(title)
  await page.getByRole("button", { name: "Create task", exact: true }).click()
  const key = page.locator(".breadcrumbs [aria-current=page]")
  await expect(key).toHaveText(/^[A-Z]+-\d+$/)
  return (await key.textContent()) as string
}

test("navegación: referencias, detalle y «atrás» exacto", async ({ page }) => {
  test.setTimeout(60_000)
  await nativeShell(page, daemon)
  await page.goto("/")
  await expect(page.locator(".header-status")).toContainText("keeld", { timeout: 15_000 })

  const target = await newTask(page, "la subtarea referida")
  const rail = page.getByRole("navigation", { name: "Navegación principal" })
  await rail.getByRole("button", { name: "Board", exact: true }).click()
  const origin = await newTask(page, "la tarea que refiere")

  // Notas antes, para que la de Markdown quede abajo y la página tenga scroll.
  for (let i = 0; i < 6; i++) {
    await page.getByLabel("Nota para la tarea").fill(`relleno ${i}\n\n${"línea\n\n".repeat(8)}`)
    await page.getByRole("button", { name: "Post", exact: true }).click()
    await expect(page.getByTestId("note")).toHaveCount(i + 1)
  }
  const long = [
    `## Hallazgos`,
    ``,
    `Revisé **${target}** y dejé esto:`,
    ``,
    `- [x] leer el detalle`,
    `- [ ] probar en el navegador`,
    ``,
    ...Array.from({ length: 40 }, (_, i) => `${i + 1}. paso con \`código\` número ${i + 1}`),
  ].join("\n")
  await page.getByLabel("Nota para la tarea").fill(long)
  await page.getByRole("button", { name: "Post", exact: true }).click()

  const note = page.getByTestId("note").filter({ hasText: "Hallazgos" })
  await expect(note.locator(".md-h")).toHaveText("Hallazgos")
  await expect(note.locator(".md-task[data-done]")).toHaveCount(1)
  await expect(note.locator(".md-preview[data-cut]")).toBeVisible()

  const scroller = page.locator(".task-main")
  const top = () => scroller.evaluate((el) => el.scrollTop)

  // «Ver detalle» abre encima; «atrás» lo cierra sin salir de la tarea ni moverla.
  const original = page.getByTestId("note").filter({ hasText: "Hallazgos" })
  const more = original.getByRole("button", { name: "Ver detalle" })
  await more.scrollIntoViewIfNeeded()
  const atDetail = await top()
  expect(atDetail).toBeGreaterThan(100)
  await more.click()
  const detail = page.getByRole("dialog")
  await expect(detail).toContainText("número 40")
  await page.keyboard.press("Alt+ArrowLeft")
  await expect(detail).toBeHidden()
  await expect(page.locator(".breadcrumbs [aria-current=page]")).toHaveText(origin)
  await expect.poll(top).toBe(atDetail)

  // La referencia abre la otra tarea; «atrás» vuelve a la de origen con su scroll.
  const ref = original.getByRole("button", { name: target, exact: true })
  await ref.scrollIntoViewIfNeeded()
  const before = await top()
  expect(before).toBeGreaterThan(100)
  await ref.click()
  await expect(page.locator(".breadcrumbs [aria-current=page]")).toHaveText(target)
  await expect(page.locator(".breadcrumbs")).toContainText(origin)
  await page.goBack()
  await expect(page.locator(".breadcrumbs [aria-current=page]")).toHaveText(origin)
  await expect.poll(top).toBe(before)

  // Pestaña recordada: en Notes, ir y volver deja Notes.
  await page.getByRole("tab", { name: "Notes" }).click()
  await rail.getByRole("button", { name: "Inbox", exact: true }).click()
  await page.goBack()
  await expect(page.locator(".breadcrumbs [aria-current=page]")).toHaveText(origin)
  await expect(page.getByRole("tab", { name: "Notes" })).toHaveAttribute("aria-selected", "true")

  // Una miga del camino regresa a ese punto: el tablero.
  await page.locator(".breadcrumbs .crumb button").first().click()
  await expect(page.locator(".task-card").first()).toBeVisible()
})
