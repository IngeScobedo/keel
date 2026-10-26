/**
 * ADR-0021 desde la GUI contra un daemon real: una tarea se trabaja con un solo
 * «Trabajar». El agente (guion `methodQuery`) sigue el ciclo formal y el humano
 * sólo decide los gates en el chat.
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

test("trabajar una tarea: etapas, gates en el chat, documentos y cierre sin elegir pasos", async ({
  page,
}) => {
  test.setTimeout(90_000)
  await nativeShell(page, daemon)
  await page.goto("/")
  await expect(page.locator(".header-status")).toContainText("keeld", { timeout: 15_000 })
  await page.getByRole("button", { name: "New task", exact: false }).click()
  await page.getByLabel("Title", { exact: true }).fill("método: capítulos en el detalle")
  await page.getByRole("button", { name: "Create task", exact: true }).click()
  await page.getByLabel("Qué necesitas").fill("Que el detalle muestre los capítulos")
  await page.getByRole("button", { name: "Trabajar", exact: true }).click()

  // Gate (a): el brief se lee en la tarjeta y se aprueba con Y.
  const brief = page.getByTestId("chat-gate").filter({ hasText: "Aprobar el brief" })
  await expect(brief).toContainText("ciclo formal")
  await expect(brief).toContainText("cambia el contrato del detalle")
  await expect(brief.locator(".rc-doc-body")).toContainText("El detalle no muestra capítulos")
  await expect(page.locator(".rc-ledger")).toContainText("Aprobar el brief")
  await expect(page.getByTestId("stage-track").first()).toContainText("espera tu gate")
  if (shots) await page.screenshot({ path: join(shots, "method-brief.png") })
  await page.locator(".rc-scroll").click({ position: { x: 5, y: 5 } })
  await page.keyboard.press("y")

  // Keel abre el siguiente run solo y la vista lo sigue; gate (b) con spec y diseño.
  const design = page.getByTestId("chat-gate").filter({ hasText: "Congelar el contrato" })
  await expect(design).toContainText("Spec v1")
  await expect(design.locator(".rc-doc-body").last()).toContainText("chapters: Chapter[]")
  await expect(page.getByTestId("chat-method").filter({ hasText: "Pasó a Diseño" })).toBeVisible()
  if (shots) await page.screenshot({ path: join(shots, "method-design.png") })
  await design.getByRole("button", { name: /Aprobar/ }).click()

  // Implementación, revisión y cierre los lleva el agente; la tarea espera la revisión humana.
  await expect(page.getByTestId("chat-method").filter({ hasText: "Pasó a Cierre" })).toBeVisible({
    timeout: 20_000,
  })
  await expect(page.getByTestId("chat-method").filter({ hasText: "QA v1" })).toContainText("valida")
  await expect(page.locator(".rc-branch")).toContainText("keel/KEEL-1/")
  await page
    .locator(".rc-ledger")
    .getByRole("button", { name: /Diseño v1/ })
    .click()
  await expect(page.getByTestId("doc-peek")).toContainText("Contrato congelado")
  if (shots) await page.screenshot({ path: join(shots, "method-close.png") })

  // En el tablero la tarjeta está en In Review con su etapa.
  await page.getByRole("button", { name: "Board", exact: true }).click()
  const card = page.locator(".board-column", { hasText: "In Review" }).locator(".task-card")
  await expect(card).toContainText("método: capítulos")
  await expect(card.getByTestId("card-stage")).toHaveText("Cierre · formal")
})
