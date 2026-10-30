/**
 * ADR-0044 contra un daemon real con un `claude` interactivo falso en tmux: el humano
 * abre la sesión de diseño de una tarea, contesta la confianza en la carpeta desde la
 * terminal de Keel, le escribe un encargo y el diseño publicado aparece con «Abrir».
 */
import { join } from "node:path"
import { expect, test } from "@playwright/test"
import { bootDaemon, type Daemon, nativeShell } from "./daemon-bridge.js"

let daemon: Daemon
test.afterEach(async () => {
  daemon.proc.stdin?.end()
  await new Promise((r) => daemon.proc.once("exit", r))
})

const shots = process.env.KEEL_E2E_SHOTS

test("la sesión de Claude Design se abre, se contesta desde Keel y publica su diseño", async ({
  page,
}) => {
  test.setTimeout(60_000)
  daemon = await bootDaemon()
  await nativeShell(page, daemon)
  await page.goto("/")
  await expect(page.locator(".header-status")).toContainText("keeld", { timeout: 15_000 })
  await page.getByRole("button", { name: "New task", exact: false }).click()
  await page.getByLabel("Title", { exact: true }).fill("Propuesta visual de descuentos")
  await page.getByRole("button", { name: "Create task", exact: true }).click()

  await page.getByRole("button", { name: "Abrir sesión de diseño" }).click()
  const card = page.getByTestId("design-session")
  // El diálogo de confianza es del humano: la terminal se abre sola y Keel no lo contesta.
  await expect(card).toHaveAttribute("data-state", "waiting")
  await expect(card.getByTestId("design-waiting")).toContainText("confías en la carpeta")
  await expect(card.getByTestId("design-screen")).toContainText("trust this folder")
  await expect(card).toContainText("tmux attach -t keel-design-")
  if (shots) await card.screenshot({ path: join(shots, "design-trust.png") })
  await card.getByRole("button", { name: "Enter", exact: true }).click()
  await expect(card.getByTestId("design-screen")).toContainText("? for shortcuts")

  await card
    .getByPlaceholder("Escribir en la sesión y Enter")
    .fill("Diseña la tarjeta. Al terminar responde con el link")
  await card.getByPlaceholder("Escribir en la sesión y Enter").press("Enter")
  await expect(card.locator(".ds-designs")).toContainText("Tarjeta")
  await expect(card.locator(".ds-designs")).toContainText("claude.ai/artifact/DISENO1")
  await expect(card.getByRole("button", { name: "Abrir", exact: true })).toBeVisible()
  if (shots) await card.screenshot({ path: join(shots, "design-published.png") })

  await card.getByRole("button", { name: "Cerrar sesión" }).click()
  await expect(card).toHaveAttribute("data-state", "closed")
})
