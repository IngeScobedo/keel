/**
 * ADR-0024 desde la GUI contra un daemon real: se le pregunta al proyecto, el agente
 * (guion `conversationQuery`) responde en sólo lectura y crea una tarea urgente, que
 * se trabaja desde la tarjeta del chat. ⌘K pregunta sin abrir la página antes.
 */
import { join } from "node:path"
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

const shots = process.env.KEEL_E2E_SHOTS

test("preguntar al proyecto: responde, nace una tarea urgente y se trabaja desde el chat", async ({
  page,
}) => {
  test.setTimeout(60_000)
  await nativeShell(page, daemon)
  await page.goto("/")
  await expect(page.locator(".header-status")).toContainText("keeld", { timeout: 15_000 })
  await page.getByRole("button", { name: "Conversación", exact: true }).click()
  const conv = page.getByTestId("project-conversation")
  await expect(conv).toContainText("sólo lectura")
  await conv.getByLabel("Pregunta al proyecto").fill("¿Quién puede exportar pedidos?")
  await conv.getByRole("button", { name: /Preguntar/ }).click()

  await expect(page.getByTestId("chat-agent").first()).toContainText("no pide rol")
  const card = page.getByTestId("chat-keel").filter({ hasText: "Creó una tarea" })
  await expect(card).toContainText("Export de pedidos sin requireRoles")
  await expect(card).toContainText("urgent")
  await expect(conv.getByTestId("conv-born")).toContainText("Export de pedidos sin requireRoles")
  if (shots) await page.screenshot({ path: join(shots, "conversation.png") })

  // La conversación no está en el tablero; la tarea que nació, sí.
  await card.getByRole("button", { name: /Trabajar/ }).click()
  await expect(card).toContainText("trabajando")
  await page.getByRole("button", { name: "Board", exact: true }).click()
  await expect(page.locator(".task-card")).toHaveCount(1)
  await expect(page.locator(".task-card")).toContainText("Export de pedidos")
  await expect(page.locator(".task-card")).not.toContainText("Conversación del proyecto")
})

test("⌘K pregunta al proyecto y la respuesta sigue la misma conversación", async ({ page }) => {
  test.setTimeout(60_000)
  await nativeShell(page, daemon)
  await page.goto("/")
  await expect(page.locator(".header-status")).toContainText("keeld", { timeout: 15_000 })
  await page.keyboard.press("Control+k")
  await page.getByLabel("Buscar comandos o tareas").fill("dónde se exportan los pedidos")
  await page.getByTestId("palette-ask").click()
  await expect(page.getByTestId("project-conversation")).toContainText(
    "dónde se exportan los pedidos",
  )
  await expect(page.getByTestId("chat-agent").first()).toContainText("no pide rol")
})
