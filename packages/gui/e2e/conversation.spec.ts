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

test("varias conversaciones: /clear empieza otra aislada y /resume retoma la anterior", async ({
  page,
}) => {
  test.setTimeout(90_000)
  await nativeShell(page, daemon)
  await page.goto("/")
  await expect(page.locator(".header-status")).toContainText("keeld", { timeout: 15_000 })
  await page.getByRole("button", { name: "Conversación", exact: true }).click()
  const conv = page.getByTestId("project-conversation")
  await conv.getByLabel("Pregunta al proyecto").fill("¿Quién puede exportar pedidos?")
  await conv.getByRole("button", { name: /Preguntar/ }).click()
  await expect(page.getByTestId("chat-agent").first()).toContainText("no pide rol")
  // El primer mensaje titula la conversación.
  await expect(conv.getByTestId("conv-title")).toHaveText("¿Quién puede exportar pedidos?")
  await expect(conv.getByTestId("conv-born")).toHaveCount(1)

  // /clear desde el chat: una conversación vacía, sin lo que nació en la otra.
  const composer = page.getByLabel("Mensaje al agente")
  await composer.fill("/cl")
  await expect(page.getByTestId("conv-commands")).toContainText("/clear")
  await composer.fill("/clear")
  await composer.press("Enter")
  await expect(conv.getByTestId("conv-title")).toHaveText("Nueva conversación")
  await conv.getByLabel("Pregunta al proyecto").fill("Precios de la tienda")
  await conv.getByRole("button", { name: /Preguntar/ }).click()
  await expect(conv.getByTestId("conv-title")).toHaveText("Precios de la tienda")
  await expect(conv).toContainText("CHAT-2")
  await expect(page.getByTestId("chat-agent").first()).toContainText("no pide rol")
  await expect(conv.getByTestId("conv-born")).toHaveCount(1)
  await expect(conv.getByTestId("conv-born")).toContainText("KEEL-2")

  // /resume: la lista, la más reciente arriba; retomar la primera trae su chat y lo suyo.
  await composer.fill("/resume")
  await composer.press("Enter")
  const history = page.getByTestId("conv-history")
  const items = history.getByTestId("conv-history-item")
  await expect(items).toHaveCount(2)
  await expect(items.first()).toContainText("Precios de la tienda")
  await expect(items.first()).toContainText("abierta")
  await expect(items.nth(1)).toContainText("¿Quién puede exportar pedidos?")
  if (shots) await page.screenshot({ path: join(shots, "conversation-history.png") })
  await page.getByLabel("Buscar conversación").press("ArrowDown")
  await page.getByLabel("Buscar conversación").press("Enter")
  await expect(conv.getByTestId("conv-title")).toHaveText("¿Quién puede exportar pedidos?")
  if (shots) await page.screenshot({ path: join(shots, "conversation-resumed.png") })
  // Cada una conserva lo suyo: aquí nació KEEL-1; en «Precios», KEEL-2.
  await expect(conv.getByTestId("conv-born")).toHaveCount(1)
  await expect(conv.getByTestId("conv-born")).toContainText("KEEL-1")
})
