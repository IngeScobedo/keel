/**
 * ADR-0035, ADR-0040 y ADR-0042 desde la GUI contra un daemon real: adjuntas una lista
 * de tareas en la conversación, explicas qué quieres, el orquestador la lee y propone el
 * lote; corriges la tarjeta y arrancas lo listo. Nace la feature con sus subtareas.
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

const TASKS = `# Pendientes de la tienda

- Proyectos arriba de Mis pedidos en el menú.
- El diseñador no ve los pines del Lab.
- Aviso de ronda nueva en la tienda.
`

test("orquestador: adjuntar una lista, explicarla, corregir el plan y arrancar", async ({
  page,
}) => {
  test.setTimeout(90_000)
  await nativeShell(page, daemon)
  await page.goto("/")
  await expect(page.locator(".header-status")).toContainText("keeld", { timeout: 15_000 })
  await page.getByRole("button", { name: "Conversación", exact: true }).click()
  const conv = page.getByTestId("project-conversation")

  // Adjuntar: la fuente queda en el proyecto, partida en pasajes, y va con el mensaje.
  await page.getByLabel("Archivo para la conversación").setInputFiles({
    name: "pendientes.md",
    mimeType: "text/markdown",
    buffer: Buffer.from(TASKS),
  })
  await expect(conv.getByTestId("sources")).toContainText("S-1")
  await expect(conv.getByTestId("sources")).toContainText("3 pasajes")
  await expect(conv.getByTestId("pending-sources")).toContainText("pendientes.md")

  // Explicar: los chips del primer corte aparecen mientras escribes, sin tokens.
  await conv
    .getByLabel("Pregunta al proyecto")
    .fill(
      "Te paso los pendientes de la tienda. Arregla los pines del Lab y mueve Proyectos arriba en el menú; al final despliega.",
    )
  await expect(conv.getByTestId("intent-chips")).toContainText("bugfix")
  await expect(conv.getByTestId("intent-chips")).toContainText("al final")
  if (shots) await page.screenshot({ path: join(shots, "orq-compose.png") })
  await conv.getByRole("button", { name: /Preguntar/ }).click()

  // El orquestador propone; Keel decide qué está listo y abre la tarjeta.
  const card = page.getByTestId("batch-plan")
  await expect(card).toContainText("2 de 3 listos", { timeout: 20_000 })
  await expect(card).toContainText("¿Cómo sabremos que «Aviso de ronda nueva» quedó?")
  await card.getByLabel("Título de T1").fill("Proyectos primero en el menú")
  if (shots) await page.screenshot({ path: join(shots, "orq-plan.png") })
  await card.getByRole("button", { name: "Arrancar 2 listos" }).click()

  // Nace el lote: la feature con sus subtareas; lo no listo va al backlog.
  await expect(page.getByTestId("chat-feature").filter({ hasText: "Nació el lote" })).toContainText(
    "2 subtareas arrancan · 1 al backlog",
  )
  // CTO / 04: con el lote andando, el hilo vuelve al centro y el lote en vivo a la derecha.
  await expect(conv).toHaveAttribute("data-stage", "batch")
  await expect(conv.getByTestId("feature-plan")).toBeVisible()
  if (shots) await page.screenshot({ path: join(shots, "orq-live.png") })
  const born = conv.getByTestId("conv-born")
  await expect(born.filter({ hasText: "feature: pendientes de la tienda" })).toBeVisible()
  await expect(born.filter({ hasText: "Aviso de ronda nueva" })).toBeVisible()
  await born
    .filter({ hasText: "feature: pendientes de la tienda" })
    .getByRole("button", { name: "Abrir" })
    .click()
  // CTO / 06: la tarea se abre como panel junto al hilo; el hilo no se va.
  await expect(conv).toHaveAttribute("data-stage", "focus")
  const focus = conv.getByTestId("task-focus")
  await expect(focus.getByRole("navigation", { name: "Foco" })).toContainText("Chat")
  // El título corregido en el plan es el de la subtarea; los agentes de prueba terminan al
  // instante, así que el plan ya las lista integradas (sólo por clave).
  const plan = focus.getByTestId("feature-plan")
  await expect(plan).toContainText("2/2 integradas", { timeout: 20_000 })
  await plan
    .getByTestId("subtask-done")
    .getByRole("button", { name: /Integradas/ })
    .click()
  await expect(plan.getByTestId("subtask-done")).toContainText("Proyectos primero en el menú")
  if (shots) await page.screenshot({ path: join(shots, "orq-focus.png") })
  // Esc cierra el foco y vuelve al lote en vivo.
  await page.keyboard.press("Escape")
  await expect(conv).toHaveAttribute("data-stage", "batch")
  if (shots) await page.screenshot({ path: join(shots, "orq-batch.png") })
})

test("CTO / 05: sin integración automática, lo que te espera se resuelve desde su foco", async ({
  page,
}) => {
  test.setTimeout(90_000)
  await nativeShell(page, daemon)
  await page.goto("/")
  await expect(page.locator(".header-status")).toContainText("keeld", { timeout: 15_000 })
  await page.getByRole("button", { name: "Conversación", exact: true }).click()
  const conv = page.getByTestId("project-conversation")
  await page.getByLabel("Archivo para la conversación").setInputFiles({
    name: "pendientes.md",
    mimeType: "text/markdown",
    buffer: Buffer.from(TASKS),
  })
  await expect(conv.getByTestId("pending-sources")).toContainText("pendientes.md")
  await conv
    .getByLabel("Pregunta al proyecto")
    .fill("Arregla los pines del Lab y mueve Proyectos arriba en el menú.")
  await conv.getByRole("button", { name: /Preguntar/ }).click()
  const plan = page.getByTestId("batch-plan")
  await expect(plan).toContainText("2 de 3 listos", { timeout: 20_000 })
  // Cada integración te pregunta: los commits de las subtareas te esperan.
  await plan.getByText("Integrar solas con QA PASS").click()
  await plan.getByRole("button", { name: "Arrancar 2 listos" }).click()
  await expect(conv).toHaveAttribute("data-stage", "batch")
  const needs = conv.getByTestId("lb-needs")
  await expect(needs).toBeVisible({ timeout: 30_000 })
  await needs.click()
  await expect(conv).toHaveAttribute("data-stage", "needs")
  const surface = conv.getByTestId("needs-you")
  await expect(surface).toContainText("Commit")
  await expect(surface).toContainText("Destraba integrar la subtarea a la feature")
  if (shots) await page.screenshot({ path: join(shots, "orq-needs.png") })
  await surface.getByRole("button", { name: "Aprobar plan" }).click()
  // Lo aprobado sale de la lista; Esc vuelve al lote.
  await expect(conv.getByTestId("feature-plan")).toContainText("integradas")
  await page.keyboard.press("Escape")
  await expect(conv).toHaveAttribute("data-stage", "batch")
})
