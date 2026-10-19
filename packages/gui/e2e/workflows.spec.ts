import { expect, test } from "@playwright/test"

test.beforeEach(async ({ page }) => {
  await page.goto("/")
})
test("board filters, list and inspector preserve task identity", async ({ page }) => {
  await expect(page.locator(".task-card")).toHaveCount(18)
  await page.getByLabel("Filtrar tareas").fill("KEEL-142")
  await expect(page.locator(".task-card")).toHaveCount(1)
  await page.getByRole("button", { name: "List", exact: true }).click()
  await page
    .getByRole("button", { name: "Retry token refresh on 401 in auth client", exact: true })
    .click()
  await expect(
    page.getByRole("heading", { name: "Retry token refresh on 401 in auth client" }),
  ).toBeVisible()
  await page.getByRole("tab", { name: "Diff", exact: true }).click()
  await expect(page.locator(".diff")).toContainText("attempts: 3")
  await page.getByRole("tab", { name: "Notes", exact: true }).click()
  await page.getByLabel("Nueva nota").fill("Review contract before implementation")
  await page.getByRole("button", { name: "Add note", exact: true }).click()
  await expect(page.locator(".note")).toContainText("Review contract")
  await page.getByRole("button", { name: "Board", exact: true }).first().click()
  await page.getByRole("button", { name: /KEEL-142: Retry token refresh/ }).click()
  await page.getByRole("tab", { name: "Notes", exact: true }).click()
  await expect(page.locator(".note")).toContainText("Review contract")
})
test("Needs you is a filter and can be reset after an empty result", async ({ page }) => {
  await page.getByRole("button", { name: "Waiting for you", exact: true }).click()
  await expect(page.locator(".task-card")).toHaveCount(4)
  await page.getByLabel("Filtrar tareas").fill("nothing matches")
  await expect(page.getByText("No tasks match your filters")).toBeVisible()
  await page.getByRole("button", { name: "Clear filters", exact: true }).click()
  await expect(page.locator(".task-card")).toHaveCount(18)
})
test("create task via keyboard without launching an agent", async ({ page }) => {
  await page.keyboard.press("c")
  await page.getByLabel("Title", { exact: true }).fill("Validate shared contract revision")
  await page
    .getByLabel("Spec / acceptance criteria")
    .fill("Given a contract v2, reconcile the typed client.")
  await page.getByRole("button", { name: "Create task", exact: true }).click()
  await expect(
    page.getByRole("heading", { name: "Validate shared contract revision" }),
  ).toBeVisible()
  await expect(page.locator(".task-runs")).toContainText("Sin runs")
  await page.getByRole("button", { name: "Board", exact: true }).last().click()
  await expect(page.locator(".task-card")).toHaveCount(19)
})
test("command palette resolves task and respects keyboard modal focus", async ({ page }) => {
  await page.keyboard.press("Control+k")
  const dialog = page.getByRole("dialog")
  await expect(dialog).toBeVisible()
  await page.getByLabel("Buscar comandos o tareas").fill("KEEL-135")
  await dialog.getByRole("button", { name: /KEEL-135/ }).click()
  await expect(
    page.getByRole("heading", { name: "Build checkout UI against the shared contract" }),
  ).toBeVisible()
  await expect(page.getByText("Waiting for contract · checkout_api")).toBeVisible()
})
test("run tree expands tool details and separates wall from reported duration", async ({
  page,
}) => {
  await page.locator(".active-run").first().click()
  await expect(page.getByText("wall_ms: 1.8s")).toBeVisible()
  await expect(page.getByText("duration_ms: 0.9s")).toBeVisible()
  await page.getByLabel("Buscar tool calls").fill("vitest")
  await expect(page.locator(".tool-row")).toHaveCount(2)
  await page.getByRole("tab", { name: "Cost", exact: true }).click()
  await expect(page.locator(".cost-view")).toContainText("$1.84 estimado")
})
test("approval requires reviewing exact target and a second confirmation", async ({ page }) => {
  await page.getByRole("button", { name: "Inbox", exact: true }).click()
  await page.getByRole("button", { name: "Approve once", exact: true }).click()
  const dialog = page.getByRole("dialog")
  await expect(dialog).toContainText("aws:terraform/prod")
  await expect(dialog).toContainText("sha256:72d409bf")
  await page.getByRole("button", { name: "Confirmar approve once", exact: true }).click()
  await expect(page.locator(".approval").first()).toContainText("approved")
  await expect(
    page.locator(".approval").first().getByRole("button", { name: "Approve once", exact: true }),
  ).toBeDisabled()
})
test("approval that expires while confirmation is open cannot be approved", async ({ page }) => {
  await page.clock.install()
  await page.getByRole("button", { name: "Inbox", exact: true }).click()
  await page.getByRole("button", { name: "Approve once", exact: true }).click()
  await page.clock.fastForward(43 * 60_000)
  await page.getByRole("button", { name: "Confirmar approve once", exact: true }).click()
  await expect(page.getByRole("alert")).toContainText("expiró")
  await expect(page.locator(".approval").first()).toContainText("expired")
})
test("profile edits produce a local draft, routing and contracts can be inspected", async ({
  page,
}) => {
  await page.getByRole("button", { name: "Agent Control Plane", exact: true }).click()
  await page.getByRole("button", { name: "Editar perfil", exact: true }).click()
  await page.getByLabel("File scope").fill("packages/gui/src/**")
  await page.getByRole("button", { name: "Guardar borrador local", exact: true }).click()
  await expect(page.locator(".profile-detail")).toContainText("v5")
  await expect(page.locator(".profile-detail")).toContainText("packages/gui/src/**")
  await page.getByRole("tab", { name: "Model routing", exact: true }).click()
  await page.getByLabel("Complejidad de routing").selectOption("4")
  await expect(page.locator(".routing-panel")).toContainText("planned_workflow")
  await page.getByRole("button", { name: "Connections", exact: true }).click()
  await page.getByRole("tab", { name: "Contract hub", exact: true }).click()
  await page.getByLabel("Versión del contrato").selectOption("v2")
  await expect(page.getByText("Breaking change · reconciliation required")).toBeVisible()
})
test("human review closes only a reviewed demo task", async ({ page }) => {
  await page.getByRole("button", { name: /KEEL-131: Flaky e2e/ }).click()
  await page.getByRole("button", { name: "Approve & close", exact: true }).click()
  await page.getByRole("button", { name: "Confirmar cierre", exact: true }).click()
  await expect(page.locator(".task-properties")).toContainText("Succeeded")
})
test("light theme persists, small screen does not overflow the page, and web cannot connect a socket", async ({
  page,
}) => {
  await page.getByRole("button", { name: "Activar tema claro" }).click()
  await page.reload()
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light")
  await page.setViewportSize({ width: 700, height: 800 })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  )
  await page.getByRole("button", { name: "Project setup", exact: true }).click()
  await page.getByRole("button", { name: "Configurar conexión", exact: true }).click()
  await expect(page.getByRole("button", { name: "Connect", exact: true })).toBeDisabled()
  await expect(page.getByRole("dialog")).toContainText("preview del navegador")
})
