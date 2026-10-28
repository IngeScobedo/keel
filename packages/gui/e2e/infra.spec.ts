/**
 * ADR-0031 contra un daemon real: el humano revisa y despliega un playbook desde
 * Conexiones y lo ve en vivo como tarjeta (host × tarea), no como texto. Ansible es un
 * doble lento a propósito; el resto (broker, ssh de Keel, eventos) es real.
 */
import { join } from "node:path"
import { expect, test } from "@playwright/test"
import { bootDaemon, type Daemon, nativeShell } from "./daemon-bridge.js"

let daemon: Daemon
test.beforeEach(async () => {
  daemon = await bootDaemon({ KEEL_E2E_ANSIBLE: "1" })
})
test.afterEach(async () => {
  daemon.proc.stdin?.end()
  await new Promise((r) => daemon.proc.once("exit", r))
})

const shots = process.env.KEEL_E2E_SHOTS

test("Ansible: check con su matriz en vivo y despliegue de lo revisado", async ({ page }) => {
  test.setTimeout(60_000)
  await nativeShell(page, daemon)
  await page.goto("/")
  await expect(page.locator(".header-status")).toContainText("keeld", { timeout: 15_000 })
  await page.getByRole("button", { name: "Connections", exact: true }).click()
  await page.locator(".conn-page aside").getByText("despliegue", { exact: true }).click()
  const deploy = page.getByTestId("deploy")
  // Sin check no hay despliegue.
  await expect(deploy.getByRole("button", { name: "Desplegar" })).toBeDisabled()
  await deploy.getByRole("button", { name: "Check" }).click()

  const card = deploy.getByTestId("infra-card")
  // En vivo: la tarjeta aparece mientras corre, con el host y la tarea en curso.
  await expect(card).toHaveAttribute("data-state", "running")
  await expect(card).toContainText("ANSIBLE CHECK")
  await expect(card.locator("tr", { hasText: "web" })).toBeVisible()
  await expect(card).toHaveAttribute("data-state", "done", { timeout: 20_000 })
  await expect(card).toContainText("1 cambio")
  await expect(card).toContainText("El check no corre comandos: 1 tarea")
  await expect(card).toContainText("✓ Completado")
  if (shots) await page.screenshot({ path: join(shots, "ansible-check.png") })

  await deploy.getByRole("button", { name: "Desplegar" }).click()
  await page.getByRole("dialog").getByRole("button", { name: "Desplegar" }).click()
  const applied = deploy.getByTestId("infra-card")
  await expect(applied).toContainText("ANSIBLE DEPLOY")
  await expect(applied).toHaveAttribute("data-state", "done", { timeout: 20_000 })
  await expect(applied).toContainText("2 cambios")
  if (shots) await page.screenshot({ path: join(shots, "ansible-deploy.png") })
})

test("Ansible: el destino se crea desde el formulario, sobre una conexión SSH", async ({
  page,
}) => {
  test.setTimeout(45_000)
  await nativeShell(page, daemon)
  await page.goto("/")
  await expect(page.locator(".header-status")).toContainText("keeld", { timeout: 15_000 })
  await page.getByRole("button", { name: "Connections", exact: true }).click()
  await page.getByRole("button", { name: "Nueva conexión" }).click()
  const form = page.getByTestId("new-connection")
  await form.getByLabel("Nombre de la conexión").fill("casamatte")
  await form.getByLabel("Tipo", { exact: true }).selectOption("ansible")
  await form.getByLabel("Entorno", { exact: true }).selectOption("prod")
  await form.getByLabel("Carpeta del playbook (en el proyecto)").fill("infra/ansible")
  await form.getByLabel("Playbook", { exact: true }).fill("site.yml")
  await form.getByLabel("Hosts (host=conexión, separados por coma)").fill("web=prod-web")
  await form.getByLabel("Tags por defecto (separados por coma)").fill("deploy")
  await form.getByRole("button", { name: "Añadir", exact: true }).click()
  const conn = page.getByTestId("connection")
  await expect(conn).toContainText("casamatte")
  await expect(conn).toContainText("web → prod-web")
  await expect(conn).toContainText("Contraseña de ansible-vault")
  await expect(conn.getByTestId("deploy").getByRole("button", { name: "Check" })).toBeVisible()
})
