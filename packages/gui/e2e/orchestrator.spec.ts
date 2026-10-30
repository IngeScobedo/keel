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
  const born = conv.getByTestId("conv-born")
  await expect(born.filter({ hasText: "feature: pendientes de la tienda" })).toBeVisible()
  await expect(born.filter({ hasText: "Aviso de ronda nueva" })).toBeVisible()
  await born
    .filter({ hasText: "feature: pendientes de la tienda" })
    .getByRole("button", { name: "Abrir" })
    .click()
  const focus = page.getByTestId("task-focus")
  await expect(focus.getByTestId("feature-plan")).toContainText("Proyectos primero en el menú", {
    timeout: 20_000,
  })
  if (shots) await page.screenshot({ path: join(shots, "orq-batch.png") })
})
