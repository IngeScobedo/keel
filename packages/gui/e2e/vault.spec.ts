/**
 * ADR-0025 desde la GUI contra un daemon real: el agente pide una conexión, la tarjeta
 * abre el alta llena, el humano elige cómo entra y el agente recibe qué quedó listo.
 * Una conexión con contraseña la guarda el vault; la pantalla nunca la muestra.
 */
import { join } from "node:path"
import { expect, test } from "@playwright/test"
import { bootDaemon, type Daemon, nativeShell } from "./daemon-bridge.js"
import { pick } from "./ui.js"

let daemon: Daemon
test.beforeEach(async () => {
  daemon = await bootDaemon()
})
test.afterEach(async () => {
  daemon.proc.stdin?.end()
  await new Promise((r) => daemon.proc.once("exit", r))
})

const shots = process.env.KEEL_E2E_SHOTS

test("el agente pide una conexión SSH; Configurar abre el alta llena y el agente sabe qué quedó", async ({
  page,
}) => {
  test.setTimeout(60_000)
  await nativeShell(page, daemon)
  await page.goto("/")
  await expect(page.locator(".header-status")).toContainText("keeld", { timeout: 15_000 })
  await page.getByRole("button", { name: "New task", exact: false }).click()
  await page.getByLabel("Title", { exact: true }).fill("desplegar la 1.8 a producción")
  await page.getByRole("button", { name: "Create task", exact: true }).click()
  await page.getByRole("button", { name: "Trabajar", exact: true }).click()

  const card = page.getByTestId("chat-setup")
  await expect(card).toContainText("Pide una conexión")
  await expect(card).toContainText("203.0.113.10")
  await expect(card).toContainText("infrastructure/scripts/deploy.sh:12")
  if (shots) await page.screenshot({ path: join(shots, "setup-card.png") })
  await card.getByRole("button", { name: /Configurar/ }).click()

  const form = page.getByTestId("new-connection")
  await expect(form.getByLabel("Nombre de la conexión")).toHaveValue("prod-ssh")
  await expect(form.getByLabel("Host")).toHaveValue("203.0.113.10")
  await expect(form.getByLabel("Usuario")).toHaveValue("deploy")
  await expect(form).toContainText("Producción: cada ejecución te pide permiso")
  await form.getByRole("button", { name: "agent", exact: true }).click()
  if (shots) await page.screenshot({ path: join(shots, "setup-form.png") })
  await form.getByRole("button", { name: "Guardar y avisar al agente" }).click()

  await expect(page.getByTestId("connection")).toContainText("prod-ssh")
  // De vuelta al chat del run: el agente dice qué quedó listo.
  await page.getByRole("button", { name: "Runs", exact: true }).click()
  await page.locator(".page button.text-link.mono").first().click()
  await expect(
    page.getByText("Listo: conexión prod-ssh lista (prod): command.run (ask)."),
  ).toBeVisible({
    timeout: 15_000,
  })
})

test("una conexión con contraseña: el vault la guarda y la pantalla no la vuelve a mostrar", async ({
  page,
}) => {
  test.setTimeout(45_000)
  await nativeShell(page, daemon)
  await page.goto("/")
  await expect(page.locator(".header-status")).toContainText("keeld", { timeout: 15_000 })
  await page.getByRole("button", { name: "Connections", exact: true }).click()
  await expect(page.locator(".conn-page")).toContainText("vault desbloqueado con tu llavero")
  await page.getByRole("button", { name: "Nueva conexión" }).click()
  const form = page.getByTestId("new-connection")
  await form.getByLabel("Nombre de la conexión").fill("pg-staging")
  await pick(page, form.getByLabel("Tipo", { exact: true }), "PostgreSQL")
  await pick(page, form.getByLabel("Entorno", { exact: true }), "staging")
  await form.getByLabel("Host").fill("db.staging.internal")
  await form.getByLabel("Contraseña").fill("centinela-e2e-31")
  await form.getByRole("button", { name: "Añadir", exact: true }).click()
  const conn = page.getByTestId("connection")
  await expect(conn).toContainText("pg-staging")
  await expect(conn.getByTestId("auth-card")).toContainText(
    "La contraseña vive cifrada en el vault",
  )
  await expect(conn.getByLabel("Contraseña")).toHaveAttribute("placeholder", /guardada en el vault/)
  await expect(page.locator("body")).not.toContainText("centinela-e2e-31")
  if (shots) await page.screenshot({ path: join(shots, "connections.png") })
})
