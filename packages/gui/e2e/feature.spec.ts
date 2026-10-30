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
  await page
    .getByRole("navigation", { name: "Navegación principal" })
    .getByRole("button", { name: "Board", exact: true })
    .click()
  const progress = page.getByTestId("feature-progress")
  await expect(progress).toContainText("3/3 subtareas", { timeout: 30_000 })
  // Las hijas no ocupan columnas: van plegadas bajo el padre.
  await expect(page.locator(".task-card")).toHaveCount(1)
  const fold = page.getByTestId("subtask-fold")
  await fold.locator("summary").click()
  await expect(fold).toContainText("Tarjeta por capítulos")
  if (shots) await page.screenshot({ path: join(shots, "feature-board.png") })

  // La vista unificada de cambios: la rama de la feature, por subtarea.
  await page.locator(".task-card").first().click()
  await page
    .getByRole("navigation", { name: "Contexto" })
    .getByRole("button", { name: "Cambios" })
    .click()
  const changes = page.getByTestId("task-changes")
  await expect(changes).toHaveAttribute("data-source", "branch")
  const subs = changes.getByTestId("feature-subtasks")
  await expect(subs).toContainText("T1")
  await expect(subs).toContainText("Tarjeta por capítulos")
  await expect(subs.locator("li")).toHaveCount(3)
  await expect(changes).toContainText("3 de 3 integradas")
  // Filtrar por una subtarea deja sólo lo suyo.
  await changes
    .getByRole("group", { name: "Ver cambios de" })
    .getByRole("button", { name: "T3" })
    .click()
  await expect(changes).toContainText("Historia de T3")
  await expect(changes.locator(".tf-file")).toHaveCount(1)
  if (shots) await page.screenshot({ path: join(shots, "feature-changes.png") })
})

test("feature: la vista de la tarea dibuja el plan, marca la checklist y pide el plan de git en su panel", async ({
  page,
}) => {
  test.setTimeout(90_000)
  await nativeShell(page, daemon)
  await page.goto("/")
  await expect(page.locator(".header-status")).toContainText("keeld", { timeout: 15_000 })
  await page.getByRole("button", { name: "New task", exact: false }).click()
  await page.getByLabel("Title", { exact: true }).fill("feature: capítulos sin integrar solos")
  await page.getByRole("button", { name: "Create task", exact: true }).click()
  await page.getByRole("button", { name: "Trabajar", exact: true }).click()
  const brief = page.getByTestId("chat-gate").filter({ hasText: "Aprobar el brief" })
  await brief.getByRole("button", { name: /Aprobar/ }).click()
  // Sin la casilla: cada integración le pregunta al humano.
  const design = page.getByTestId("chat-gate").filter({ hasText: "Congelar el contrato" })
  await design.getByRole("button", { name: /Aprobar/ }).click()
  await expect(page.getByTestId("chat-feature").first()).toContainText("Nacieron 3 subtareas")

  // ADR-0034 §5: la tarea padre, con su plan como DAG y la checklist del spec.
  await page
    .getByRole("navigation", { name: "Navegación principal" })
    .getByRole("button", { name: "Board", exact: true })
    .click()
  await page.locator(".task-card").first().click()
  await expect(page.getByTestId("task-focus")).toBeVisible()
  await page.getByRole("tab", { name: "Plan", exact: true }).click()
  const dag = page.getByTestId("plan-dag")
  await expect(dag.locator("[data-node]")).toHaveCount(3)
  // Fase 2 depende de toda la fase 1: dos flechas hacia T3.
  await expect(dag.locator(".tf-dag-edges path")).toHaveCount(2)
  if (shots) await page.screenshot({ path: join(shots, "task-focus-dag.png") })
  await page.getByRole("tab", { name: /Checklist/ }).click()
  const checklist = page.getByTestId("checklist")
  await expect(checklist).toContainText("R1")
  await expect(checklist).toContainText("Capítulos en el backoffice")
  if (shots) await page.screenshot({ path: join(shots, "task-focus-plan.png") })

  // Una subtarea espera que el humano apruebe su plan: el panel «Por decidir» se abre solo.
  const waiting = page.getByTestId("feature-plan").getByText("espera tu decisión").first()
  await expect(waiting).toBeVisible({ timeout: 30_000 })
  await waiting.click()
  const panel = page.getByRole("complementary", { name: "Por decidir" })
  await expect(panel).toBeVisible()
  await expect(panel.getByRole("button", { name: "Aprobar plan" })).toBeVisible()
  if (shots) await page.screenshot({ path: join(shots, "task-focus-decide.png") })
  // Cerrado a mano, no se vuelve a abrir por el mismo plan.
  await panel.getByRole("button", { name: "Cerrar el panel" }).click()
  await expect(panel).toBeHidden()
  await page.getByRole("tab", { name: "Actividad", exact: true }).click()
  await page.getByRole("tab", { name: "Conversación", exact: true }).click()
  await expect(panel).toBeHidden()
  // «Atrás» vuelve a la feature, en su pestaña.
  await page.goBack()
  await expect(page.getByRole("tab", { name: /Checklist/ })).toHaveAttribute(
    "aria-selected",
    "true",
  )
})
