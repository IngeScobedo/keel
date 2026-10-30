/**
 * ADR-0043 contra un daemon real con un `gh` doble: la PR viva en el chat con su merge
 * humano, el deploy que disparó la promoción paso a paso, y el inicio de sesión de gh
 * desde Ajustes (Keel sólo muestra el código que imprime gh).
 */
import { join } from "node:path"
import { expect, test } from "@playwright/test"
import { advanced, bootDaemon, type Daemon, nativeShell } from "./daemon-bridge.js"
import { openLatestRun } from "./ui.js"

let daemon: Daemon
test.afterEach(async () => {
  daemon.proc.stdin?.end()
  await new Promise((r) => daemon.proc.once("exit", r))
})

const shots = process.env.KEEL_E2E_SHOTS

test("la PR vive en el chat: checks, squash and merge y el deploy paso a paso", async ({
  page,
}) => {
  test.setTimeout(90_000)
  daemon = await bootDaemon()
  await nativeShell(page, daemon)
  await page.goto("/")
  await expect(page.locator(".header-status")).toContainText("keeld", { timeout: 15_000 })
  await page.getByRole("button", { name: "New task", exact: false }).click()
  await page.getByLabel("Title", { exact: true }).fill("github: portada de Pre Purchase")
  await page.getByRole("button", { name: "Create task", exact: true }).click()
  await advanced(page)
  await page.getByRole("button", { name: "Mover a planned" }).click()
  await page.getByLabel("Instrucción para el agente").fill("abre la PR")
  await page.locator(".live-actions").getByRole("button", { name: "Ejecutar" }).click()
  await openLatestRun(page)

  const pr = page.getByTestId("github-pr")
  await expect(pr).toContainText("#51")
  await expect(pr).toContainText("abierta")
  await expect(pr).toContainText("CI · main")
  await expect(pr).toContainText("aprobada")
  await expect(pr).toContainText("development ← fix/api-pre-purchase-cover-layout")
  // El deploy que disparó la promoción avanza solo, paso a paso.
  const run = page.getByTestId("github-run").first()
  await expect(run).toContainText("Deploy · stage")
  await expect(run).toContainText("Build + push")
  await expect(run).toHaveAttribute("data-tone", "running")
  if (shots) await page.screenshot({ path: join(shots, "github-pr.png") })

  await pr.getByRole("button", { name: "Squash and merge", exact: true }).first().click()
  await expect(pr.getByLabel("Título del commit de merge")).toHaveValue(
    "fix(api): corrige la portada de Pre Purchase (#51)",
  )
  await pr
    .getByTestId("github-merge")
    .getByRole("button", { name: "Squash and merge" })
    .last()
    .click()
  await expect(pr).toContainText("mergeada")
  await expect(pr).toContainText("Mergeada en development por IngeScobedo")
  // En development no corre ningún workflow: la tarjeta lo dice en vez de buscar siempre.
  await expect(pr).toContainText("Ningún workflow de GitHub Actions corre por esto.", {
    timeout: 45_000,
  })
  await expect(run).toHaveAttribute("data-tone", "succeeded", { timeout: 20_000 })
  await expect(run).toContainText("verde")
  if (shots) await page.screenshot({ path: join(shots, "github-merged.png") })
})

test("sin sesión: Ajustes inicia la de gh y muestra su código", async ({ page }) => {
  test.setTimeout(60_000)
  daemon = await bootDaemon({ KEEL_E2E_GH_LOGGED_OUT: "1" })
  await nativeShell(page, daemon)
  await page.goto("/")
  await expect(page.locator(".header-status")).toContainText("keeld", { timeout: 15_000 })
  await page.getByRole("button", { name: "Project setup", exact: true }).click()
  const gh = page.getByTestId("github-settings")
  await expect(gh.getByTestId("github-account")).toHaveText("sin sesión")
  await gh.getByRole("button", { name: "Iniciar sesión en GitHub" }).click()
  const login = page.getByTestId("github-login")
  await expect(login.getByTestId("github-login-code")).toHaveText("KEEL-2026")
  await expect(login).toContainText("gh espera a que autorices")
  if (shots) await page.screenshot({ path: join(shots, "github-login.png") })
  // Al terminar gh, Keel relee su estado: la cuenta aparece sin recargar.
  await expect(gh.getByTestId("github-account")).toHaveText("IngeScobedo · github.com", {
    timeout: 15_000,
  })
  await expect(login).toHaveCount(0)
})

test("Entregas: el flujo detectado, promover a stage con su deploy y a prod con confirmación", async ({
  page,
}) => {
  test.setTimeout(120_000)
  daemon = await bootDaemon({ KEEL_E2E_DELIVERY: "1" })
  await nativeShell(page, daemon)
  await page.goto("/")
  await expect(page.locator(".header-status")).toContainText("keeld", { timeout: 15_000 })
  await page.getByRole("button", { name: "Entregas", exact: true }).click()
  const delivery = page.getByTestId("delivery")
  await expect(delivery).toContainText("development → stage → main")
  // Detectado de la historia y de los workflows; el humano lo confirma.
  await expect(page.getByTestId("delivery-detected")).toContainText("PRs mergeadas en development")
  await page.getByRole("button", { name: "Confirmar flujo" }).click()
  await expect(page.getByTestId("delivery-detected")).toHaveCount(0)

  const dev = page.getByTestId("delivery-development")
  await expect(dev).toContainText("#51 fix(api): corrige la portada de Pre Purchase")
  await expect(dev).toContainText("#3 fix(api): cambio 3")
  if (shots) await page.screenshot({ path: join(shots, "delivery.png") })

  await page.getByTestId("promote-development-stage").getByRole("button").click()
  const dialog = page.getByTestId("promote-dialog")
  await expect(dialog).toContainText("#3 fix(api): cambio 3")
  await expect(dialog).toContainText("corre Deploy · stage")
  await dialog.getByRole("button", { name: "Promover a stage" }).click()
  const after = page.getByTestId("delivery-promoted")
  await expect(after).toContainText("Promoviste development → stage")
  await expect(after.getByTestId("github-run")).toContainText("Deploy · stage")

  // A prod: el gate espera el deploy de stage en verde; luego pide escribir «main».
  const toMain = page.getByTestId("promote-stage-main")
  await expect(async () => {
    await page.getByRole("button", { name: /Actualizar/ }).click()
    await expect(toMain.getByRole("button")).toBeEnabled({ timeout: 2_000 })
  }).toPass({ timeout: 40_000 })
  await toMain.getByRole("button").click()
  const prod = page.getByTestId("promote-dialog")
  const go = prod.getByRole("button", { name: "Promover a main" })
  await expect(go).toBeDisabled()
  await prod.getByLabel("Confirmar rama de producción").fill("main")
  await go.click()
  await expect(page.getByTestId("delivery-promoted")).toContainText("Promoviste stage → main")
  if (shots) await page.screenshot({ path: join(shots, "delivery-promoted.png") })
})
