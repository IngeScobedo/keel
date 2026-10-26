/** ADR-0006 §4 desde la GUI: arrastrar pide la transición; lo que no existe se explica. */
import { expect, test } from "@playwright/test"
import { bootDaemon, type Daemon, nativeShell } from "./daemon-bridge.js"

let daemon: Daemon
test.beforeEach(async () => {
  daemon = await bootDaemon()
})
test.afterEach(async () => {
  daemon.proc.stdin?.end()
  await new Promise((r) => daemon.proc.once("exit", r))
})

test("arrastrar de Backlog a Ready la planifica; a Done se explica por qué no", async ({
  page,
}) => {
  test.setTimeout(45_000)
  await nativeShell(page, daemon)
  await page.goto("/")
  await expect(page.locator(".header-status")).toContainText("keeld", { timeout: 15_000 })
  await page.getByRole("button", { name: "New task", exact: false }).click()
  await page.getByLabel("Title", { exact: true }).fill("mover esta tarjeta")
  await page.getByRole("button", { name: "Create task", exact: true }).click()
  await page
    .getByRole("navigation", { name: "Navegación principal" })
    .getByRole("button", { name: "Board", exact: true })
    .click()
  const card = page.locator(".task-card", { hasText: "mover esta tarjeta" })
  const column = (name: string) => page.locator(".board-column", { hasText: name }).first()
  await expect(column("Backlog")).toContainText("mover esta tarjeta")
  await card.dragTo(column("Ready"))
  await expect(column("Ready")).toContainText("mover esta tarjeta")
  await card.dragTo(column("Done"))
  await expect(page.getByTestId("move-note")).toContainText("plan de cierre")
  await expect(column("Ready")).toContainText("mover esta tarjeta")
})
