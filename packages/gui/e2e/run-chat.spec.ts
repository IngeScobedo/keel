/**
 * ADR-0020 contra un daemon real: el chat del run como superficie de foco. El
 * proveedor es el guion `chatQuery` (explora, edita, crea una tarea, pregunta y
 * pide permiso para dos comandos); lo demás es real.
 */
import { join } from "node:path"
import { expect, test } from "@playwright/test"
import { advanced, bootDaemon, type Daemon, nativeShell } from "./daemon-bridge.js"
import { openLatestRun } from "./ui.js"

let daemon: Daemon
test.beforeEach(async () => {
  daemon = await bootDaemon()
})
test.afterEach(async () => {
  daemon.proc.stdin?.end()
  await new Promise((r) => daemon.proc.once("exit", r))
})

const shots = process.env.KEEL_E2E_SHOTS

test("chat de foco: diff, tarea de Keel, pregunta contestada, permiso por patrón, modo en vivo y sugerencia", async ({
  page,
}) => {
  test.setTimeout(90_000)
  await nativeShell(page, daemon)
  await page.goto("/")
  await expect(page.locator(".header-status")).toContainText("keeld", { timeout: 15_000 })
  await page.getByRole("button", { name: "New task", exact: false }).click()
  await page.getByLabel("Title", { exact: true }).fill("Capítulos en el detalle del proyecto")
  await page.getByRole("button", { name: "Create task", exact: true }).click()
  await advanced(page)
  await page.getByRole("button", { name: "Mover a planned" }).click()
  await page.getByLabel("Instrucción para el agente").fill("chat: agrega capítulos al detalle")
  await page.locator(".live-actions").getByRole("button", { name: "Ejecutar" }).click()
  await openLatestRun(page)

  // La pregunta del agente se ve con sus opciones, no como un permiso (§7).
  const question = page.getByTestId("chat-question")
  await expect(question).toContainText("¿Cómo cargo los capítulos")
  await expect(question).toContainText("recomendada")
  await expect(question).toContainText("no es un permiso")
  await expect(page.locator(".rc-ledger")).toContainText("Pregunta: Paginación")

  // Tarjetas por intención (§1): exploración agrupada, diff de la edición, acciones de Keel.
  await expect(page.getByTestId("chat-explore")).toContainText("Exploró el código")
  const edit = page.getByTestId("chat-tool").filter({ hasText: "DesignProjectDetailPage.spec.tsx" })
  await expect(edit).toContainText("+2")
  await expect(edit.getByTestId("diff")).toContainText("chapterCount: 0,")
  await expect(page.getByTestId("chat-keel").filter({ hasText: "Creó una tarea" })).toContainText(
    "KEEL-9",
  )
  await expect(page.getByTestId("chat-keel").filter({ hasText: "checklist" })).toContainText(
    "2 / 4",
  )
  await expect(page.locator(".rc-ledger")).toContainText("DesignProjectDetailPage.spec.tsx")
  // Modelo a la vista (§5) y modo en vivo con su registro (§4).
  await expect(page.getByRole("button", { name: "Modelo y esfuerzo" })).toContainText(
    "Opus 5.5 · alto",
  )
  await page.getByRole("button", { name: "Modo del run" }).click()
  await page.getByRole("button", { name: /Aceptar ediciones/ }).click()
  await expect(page.getByTestId("run-mode")).toHaveText("Aceptar ediciones")
  await expect(page.getByTestId("chat-status").last()).toContainText(
    "Modo: Preguntar → Aceptar ediciones",
  )
  if (shots) await page.screenshot({ path: join(shots, "chat-question.png") })
  // La lista de modelos sale del proveedor; bypass pide confirmación y no se aplica sin ella.
  await page.getByRole("button", { name: "Modelo y esfuerzo" }).click()
  await expect(page.getByRole("dialog", { name: "Modelo" })).toContainText(
    "los que tu cuenta ofrece",
  )
  if (shots) await page.screenshot({ path: join(shots, "chat-model.png") })
  await page.keyboard.press("Escape")
  await page.getByRole("button", { name: "Modo del run" }).click()
  await page.getByRole("button", { name: /Bypass/ }).click()
  await expect(page.getByRole("dialog", { name: "Modo del run" })).toContainText(
    "¿Pasar a bypass a mitad del run?",
  )
  if (shots) await page.screenshot({ path: join(shots, "chat-mode.png") })
  await page.keyboard.press("Escape")
  await expect(page.getByTestId("run-mode")).toHaveText("Aceptar ediciones")

  // Contestar con el teclado: 2 elige la recomendada, Enter responde. El agente la recibe.
  await page.locator(".rc-scroll").click({ position: { x: 5, y: 5 } })
  await page.keyboard.press("2")
  await page.keyboard.press("Enter")
  await expect(page.getByTestId("chat-agent").filter({ hasText: "Elegiste" })).toContainText(
    "Paginado de 50 en 50",
  )

  // Permiso con patrón (§2): «bun run *» en la sesión deja pasar el siguiente sin preguntar.
  const approval = page.getByTestId("chat-approval")
  await expect(approval).toContainText("sin límite")
  await expect(approval.getByLabel("Patrón a aprobar")).toHaveValue("bun run *")
  await approval.getByLabel("Patrón a aprobar").fill("bun run && *")
  await expect(approval).toContainText("patrón no válido")
  await approval.getByLabel("Patrón a aprobar").fill("bun run *")
  await expect(approval).toContainText("cubre esta orden")
  if (shots) await page.screenshot({ path: join(shots, "chat-approval.png") })
  await approval.getByRole("button", { name: /El patrón en la sesión/ }).click()
  await expect(page.locator(".rc-head")).toContainText("Succeeded", { timeout: 20_000 })
  const tests = page.getByTestId("chat-tool").filter({ hasText: "Corre las pruebas" })
  await expect(tests).toContainText("0 fail")
  await expect(page.getByTestId("chat-approval")).toHaveCount(0)

  // La sugerencia de Claude (§6): texto fantasma que → acepta.
  const input = page.getByLabel("Mensaje al agente")
  await expect(input).toHaveAttribute("placeholder", "corre también las pruebas del API")
  await input.focus()
  await page.keyboard.press("ArrowRight")
  await expect(input).toHaveValue("corre también las pruebas del API")
  if (shots) await page.screenshot({ path: join(shots, "chat-done.png") })

  // Historia (§1): una línea por grupo; las densidades no recargan el run.
  await page.getByRole("button", { name: "Historia", exact: true }).click()
  await expect(page.getByTestId("chat-story").first()).toBeVisible()
  await expect(page.getByTestId("chat-explore")).toHaveCount(0)
  if (shots) await page.screenshot({ path: join(shots, "chat-story.png") })
  await page.getByRole("button", { name: "Cruda", exact: true }).click()
  await expect(page.getByTestId("diff").first()).toBeVisible()
})
