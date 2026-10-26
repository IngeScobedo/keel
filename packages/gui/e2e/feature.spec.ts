/**
 * ADR-0022 desde la GUI contra un daemon real: el gate (b) muestra el árbol que va a
 * nacer; con la integración automática, las subtareas se trabajan e integran solas y
 * el tablero muestra el avance de la feature con sus hijas plegadas.
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

test("feature: el gate (b) muestra el árbol, las subtareas se integran solas y el tablero lleva el avance", async ({
  page,
}) => {
  test.setTimeout(90_000)
  await nativeShell(page, daemon)
  await page.goto("/")
  await expect(page.locator(".header-status")).toContainText("keeld", { timeout: 15_000 })
  await page.getByRole("button", { name: "New task", exact: false }).click()
  await page.getByLabel("Title", { exact: true }).fill("feature: capítulos en el detalle")
  await page.getByRole("button", { name: "Create task", exact: true }).click()
  await page.getByRole("button", { name: "Trabajar", exact: true }).click()

  const brief = page.getByTestId("chat-gate").filter({ hasText: "Aprobar el brief" })
  await expect(brief).toBeVisible()
  await brief.getByRole("button", { name: /Aprobar/ }).click()

  const design = page.getByTestId("chat-gate").filter({ hasText: "Congelar el contrato" })
  const tree = design.getByTestId("feature-tree")
  await expect(tree).toContainText("3 subtareas")
  await expect(tree).toContainText("Fase 2 — Backoffice")
  await expect(tree).toContainText("después de T1, T2")
  if (shots) await page.screenshot({ path: join(shots, "feature-gate.png") })
  await design.getByRole("checkbox").check()
  await design.getByRole("button", { name: /Aprobar/ }).click()

  await expect(page.getByTestId("chat-feature").first()).toContainText("Nacieron 3 subtareas")
  await page.getByRole("button", { name: "Board", exact: true }).click()
  const progress = page.getByTestId("feature-progress")
  await expect(progress).toContainText("3/3 subtareas", { timeout: 30_000 })
  // Las hijas no ocupan columnas: van plegadas bajo el padre.
  await expect(page.locator(".task-card")).toHaveCount(1)
  const fold = page.getByTestId("subtask-fold")
  await fold.locator("summary").click()
  await expect(fold).toContainText("Tarjeta por capítulos")
  if (shots) await page.screenshot({ path: join(shots, "feature-board.png") })
})
