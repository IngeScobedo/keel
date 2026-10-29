/**
 * La GUI contra un daemon real (SQLite, git y socket reales; proveedores
 * dobles), a través del puente de `daemon-bridge.ts`.
 */
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { expect, test } from "@playwright/test"
import { advanced, bootDaemon, type Daemon, Line, meta, nativeShell } from "./daemon-bridge.js"
import { pick } from "./ui.js"

let daemon: Daemon
test.beforeEach(async () => {
  daemon = await bootDaemon()
})
test.afterEach(async () => {
  daemon.proc.stdin?.end()
  await new Promise((r) => daemon.proc.once("exit", r))
})

test("ciclo real desde la GUI: tarea, plan, execute con aprobación, sesión externa y petición de run", async ({
  page,
}) => {
  test.setTimeout(90_000)
  await nativeShell(page, daemon)
  await page.goto("/")
  // Se conecta solo a la ruta por defecto que da el shell.
  await expect(page.locator(".header-status")).toContainText("keeld", { timeout: 15_000 })

  // 1. Crear la tarea y planearla con Claude (corrida grabada).
  await page.getByRole("button", { name: "New task", exact: false }).click()
  await page.getByLabel("Title", { exact: true }).fill("Retry con backoff")
  await page.getByLabel("Spec / acceptance criteria").fill("Reintentos acotados.")
  await page.getByRole("button", { name: "Create task", exact: true }).click()
  await expect(page.getByRole("heading", { name: "Retry con backoff" })).toBeVisible()
  await expect(page.locator(".task-spec")).toHaveText("Reintentos acotados.")
  await advanced(page)
  await page.locator(".live-actions").getByRole("button", { name: "Planear" }).click()
  await expect(page.locator(".rc-head")).toContainText("Succeeded", { timeout: 20_000 })
  // El run se lee como conversación: instrucción, herramientas y respuesta, lo nuevo abajo.
  await expect(page.getByTestId("chat-tool").first()).toBeVisible()
  await expect(page.getByTestId("chat-agent").last()).toBeVisible()
  await expect(page.locator(".rc-branch")).toContainText("raíz del repo")
  // Continuar la conversación desde el chat: nace un run hijo y la vista pasa a él.
  const planUrlRun = await page.getByTestId("run-id").textContent()
  await page.getByLabel("Mensaje al agente").fill("detalla los pasos")
  await page.getByRole("button", { name: "Continuar", exact: true }).click()
  await expect(page.getByTestId("run-id")).not.toHaveText(planUrlRun ?? "")
  await expect(page.getByTestId("chat-divider")).toBeVisible()
  await expect(page.getByTestId("chat-human").last()).toContainText("detalla los pasos")
  await expect(page.locator(".rc-head")).toContainText("Succeeded", { timeout: 20_000 })

  // 2. Pasarla a planned y ejecutar con Codex: el comando pide aprobación.
  await page.locator(".rc-head .text-link").click()
  await advanced(page)
  await page.getByRole("button", { name: "Mover a planned" }).click()
  await pick(page, page.getByLabel("Proveedor"), "Codex")
  if (process.env.KEEL_E2E_SHOTS)
    await page.screenshot({ path: join(process.env.KEEL_E2E_SHOTS, "start.png") })
  await page.getByLabel("Instrucción para el agente").fill("approval")
  await page.locator(".live-actions").getByRole("button", { name: "Ejecutar" }).click()
  await expect(page.locator(".rc-head")).toContainText("Waiting for you", {
    timeout: 20_000,
  })
  // La aprobación aparece dentro de la conversación del run; también en el Inbox.
  await expect(page.getByTestId("chat-approval")).toContainText("Pide permiso para ejecutar")
  await expect(page.getByTestId("chat-approval")).toContainText("sin límite")
  await expect(page.locator(".chat-approval-input")).not.toBeEmpty()
  await expect(page.locator(".rc-branch")).toContainText("keel/")
  if (process.env.KEEL_E2E_SHOTS)
    await page.screenshot({ path: join(process.env.KEEL_E2E_SHOTS, "run.png") })
  // El Inbox la muestra con las mismas opciones; se decide desde el chat con «Siempre».
  await page.getByRole("button", { name: "Inbox", exact: true }).click()
  await expect(page.getByTestId("approval")).toContainText("touch x")
  await page.getByRole("button", { name: "Runs", exact: true }).click()
  await page.locator("tbody tr").last().getByRole("button").click()
  const chatApproval = page.getByTestId("chat-approval")
  // ADR-0020 §2: Keel propone el patrón y dice si cubre la orden antes de elegir.
  await expect(chatApproval.getByLabel("Patrón a aprobar")).toHaveValue("touch x *")
  await expect(chatApproval).toContainText("cubre esta orden")
  await chatApproval.getByRole("button", { name: /Siempre en el proyecto/ }).click()
  // Resuelta, la tarjeta vuelve a ser la del comando y conserva la decisión.
  await expect(page.getByTestId("chat-tool").filter({ hasText: "touch x" })).toContainText(
    "aprobado",
  )
  await expect(page.locator(".rc-head")).toContainText("Succeeded", { timeout: 20_000 })
  await expect(page.getByTestId("run-mode")).toHaveText("Preguntar")
  // Operaciones (ADR-0011): el comando de Codex queda como lo que es, sin inventar.
  await page.getByRole("tab", { name: "Operaciones", exact: true }).click()
  await expect(page.getByText("Cobertura: instrumented")).toBeVisible()
  await page.getByRole("tab", { name: "Chat", exact: true }).click()
  // Codex corre en su propio sandbox, sin verificar contra la puerta humana (ADR-0018).
  await expect(page.getByTestId("isolation")).toHaveText("sandbox del proveedor")

  // Permisos: la regla creada y la decisión, con quién la tomó; revocar la desactiva.
  await page.getByRole("button", { name: "Permisos", exact: true }).click()
  const rule = page.getByTestId("rule")
  await expect(rule).toContainText("Bash(touch x:*)")
  await expect(rule).toContainText("desde una aprobación")
  await expect(page.getByTestId("decision").first()).toContainText("touch x")
  await expect(page.getByTestId("decision").first()).toContainText("Tú")
  if (process.env.KEEL_E2E_SHOTS)
    await page.screenshot({ path: join(process.env.KEEL_E2E_SHOTS, "permissions.png") })
  await rule.getByRole("button", { name: "Revocar" }).click()
  await expect(rule).toHaveCount(0)
  await page.getByRole("button", { name: "Runs", exact: true }).click()
  await expect(page.locator("tbody tr")).toHaveCount(3)

  // 3. Una sesión externa pide entrar; se aprueba desde el Inbox con tarea y scopes.
  const external = await Line.open(daemon.socket)
  const pairing = await external.call("session.pair", { client_name: "codex a mano", cwd: "/x" })
  await page.getByRole("button", { name: "Inbox", exact: true }).click()
  const card = page.getByTestId("pairing")
  await expect(card).toContainText(`código ${pairing.code}`)
  await card.getByRole("button", { name: "Revisar y aprobar" }).click()
  await pick(page, page.getByLabel("Tarea vinculada"), "KEEL-1 · Retry con backoff")
  await page.getByRole("checkbox", { name: /Crear tareas/ }).uncheck()
  await page.getByRole("button", { name: "Aprobar sesión" }).click()
  await expect(card).toHaveCount(0)
  expect(await external.call("session.pair_status")).toMatchObject({
    state: "approved",
    scopes: ["tasks:read", "notes:write", "runs:request", "resources:use"],
  })

  // Lo que escribe el agente aparece como agente, nunca como el humano.
  const items = (await external.call("work_items.list")) as { items: { id: string }[] }
  const taskId = items.items[0]?.id as string
  await external.call("notes.add", {
    ...meta(),
    work_item_id: taskId,
    content_markdown: "hola desde fuera",
  })
  await external.call("runs.request", {
    ...meta(),
    work_item_id: taskId,
    purpose: "plan",
    reason: "replanear tras el execute",
  })
  const request = page.getByTestId("run-request")
  await expect(request).toContainText("replanear tras el execute")
  await expect(request).toContainText("Agente externo")
  await request.getByRole("button", { name: "Rechazar" }).click()
  await expect(request).toHaveCount(0)

  await page.getByRole("button", { name: "Board", exact: true }).click()
  await page.locator(".task-card").first().click()
  const note = page.getByTestId("note").filter({ hasText: "hola desde fuera" })
  await expect(note).toContainText("Agente externo")
  // Evidencia propia del humano (ADR-0012): se adjunta, se lista con su hash y se ve.
  await page.getByRole("tab", { name: "Evidence", exact: true }).click()
  await page.getByLabel("Archivo de evidencia").setInputFiles({
    name: "resultado.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("12 pruebas en verde"),
  })
  const ev = page.getByTestId("evidence")
  await expect(ev).toContainText("resultado.txt")
  await ev.locator(".evidence-head").click()
  await expect(page.locator(".evidence-text")).toHaveText("12 pruebas en verde")
  // Un resultado tabular se ve como tabla y se grafica sin código (ADR-0014 nivel 1).
  await page.getByLabel("Archivo de evidencia").setInputFiles({
    name: "ventas.json",
    mimeType: "application/vnd.keel.table+json",
    buffer: Buffer.from(
      JSON.stringify({
        columns: [{ name: "mes" }, { name: "monto" }],
        rows: [
          ["ago", 10],
          ["sep", 30],
        ],
      }),
    ),
  })
  await page
    .getByTestId("evidence")
    .filter({ hasText: "ventas.json" })
    .locator(".evidence-head")
    .click()
  await expect(page.getByTestId("result-table")).toContainText("sep")
  await page.getByRole("button", { name: "Graficar", exact: true }).click()
  await expect(page.getByTestId("chart").locator("svg, canvas").first()).toBeVisible()
  await page.getByRole("tab", { name: "Activity", exact: true }).click()
  await page.getByLabel("Nota para la tarea").fill("revisado")
  await page.getByRole("button", { name: "Post", exact: true }).click()
  await expect(page.getByTestId("note").filter({ hasText: "revisado" })).toContainText("Tú")
  if (process.env.KEEL_E2E_SHOTS)
    await page.screenshot({ path: join(process.env.KEEL_E2E_SHOTS, "task.png"), fullPage: true })
  external.sock.destroy()

  // 4. Otro proyecto: abrirlo por ruta, ver su rama y que sus tareas no se mezclan.
  await page.getByRole("button", { name: "Proyecto" }).click()
  await page.getByLabel("Ruta de la carpeta").fill(daemon.other_repo)
  await page.getByRole("button", { name: "Abrir", exact: true }).click()
  await expect(page.getByRole("button", { name: "Proyecto" })).toContainText("otro")
  await expect(page.getByTestId("repo-badge")).toContainText("main")
  await expect(page.locator(".task-card")).toHaveCount(0)
  await page.getByRole("button", { name: "Proyecto" }).click()
  await page.locator(".workspace-popover").getByRole("button", { name: /^repo/ }).click()
  await expect(page.getByRole("button", { name: "Proyecto" })).toContainText("repo")
  await expect(page.locator(".task-card")).toHaveCount(1)

  // 5. Escribirle a Codex mientras trabaja: el mensaje entra en el turno (turn/steer).
  await page.getByRole("button", { name: "New task", exact: false }).click()
  await page.getByLabel("Title", { exact: true }).fill("Con Codex")
  await page.getByRole("button", { name: "Create task", exact: true }).click()
  await advanced(page)
  await page.getByRole("button", { name: "Mover a planned" }).click()
  await pick(page, page.getByLabel("Proveedor"), "Codex")
  await page.getByLabel("Instrucción para el agente").fill("wait")
  await page.locator(".live-actions").getByRole("button", { name: "Ejecutar" }).click()
  await expect(page.getByText("El agente está trabajando")).toBeVisible()
  await page.getByLabel("Mensaje al agente").fill("usa bun")
  await page.getByRole("button", { name: "Enviar", exact: true }).click()
  // La instrucción inicial y el mensaje, ambos tuyos y en orden.
  await expect(page.getByTestId("chat-human")).toHaveText(["wait", "usa bun"])
  await expect(page.getByTestId("chat-agent").last()).toContainText("recibido: usa bun")
  await expect(page.locator(".rc-head")).toContainText("Succeeded", { timeout: 20_000 })
  if (process.env.KEEL_E2E_SHOTS)
    await page.screenshot({ path: join(process.env.KEEL_E2E_SHOTS, "chat.png") })

  // 6. Plan de git (ADR-0015): se propone sobre el worktree del run y se aprueba en su tarjeta.
  const runId = (await page.getByTestId("run-id").textContent()) as string
  const human = await Line.open(daemon.socket)
  const st = (await human.call("git.status", { run_id: runId })) as { worktree: string }
  writeFileSync(join(st.worktree, "plan.txt"), "hola\n")
  const plan = await human.call("git.propose", {
    ...meta(),
    run_id: runId,
    message: "añade plan.txt",
  })
  const planCard = page.getByTestId("git-plan")
  await expect(planCard).toContainText("añade plan.txt")
  await expect(planCard).toContainText("plan.txt")
  await planCard.getByRole("button", { name: "Aprobar plan" }).click()
  await expect
    .poll(
      async () =>
        ((await human.call("git.plan_status", { plan_id: plan.plan_id })) as { state: string })
          .state,
    )
    .toBe("completed")
  human.sock.destroy()

  // 7. Conexiones (ADR-0013, ADR-0026): permiso por operación; en prod quitar la pregunta
  // pide escribir el nombre de la conexión.
  await page.getByRole("button", { name: "Connections", exact: true }).click()
  await page.getByRole("button", { name: "Nueva conexión" }).click()
  await page.getByLabel("Nombre de la conexión").fill("conta")
  await pick(page, page.getByLabel("Tipo", { exact: true }), "SQLite")
  await pick(page, page.getByLabel("Entorno", { exact: true }), "prod")
  await page.getByLabel("Ruta del archivo").fill("/tmp/conta.db")
  await page.getByRole("button", { name: "Añadir", exact: true }).click()
  const conn = page.getByTestId("connection")
  await expect(conn).toContainText("conta")
  await expect(conn).toContainText("mode=ro")
  await pick(page, page.getByLabel("Política de query.read en conta"), "sin preguntar")
  await expect(page.getByLabel("Política de query.read en conta")).toContainText("sin preguntar")
  await pick(page, page.getByLabel("Política de query.write en conta"), "sin preguntar")
  const risk = page.getByTestId("risk-modal")
  await expect(risk.getByRole("button", { name: "Dejar de preguntar" })).toBeDisabled()
  await risk.getByLabel("Nombre de la conexión para confirmar").fill("conta")
  await risk.getByRole("button", { name: "Dejar de preguntar" }).click()
  await expect(page.getByTestId("risk-accepted")).toContainText("prod sin preguntar")

  // 8. Investigación (ADR-0016): afirmaciones, decisión humana y reporte con hash.
  await page.getByRole("button", { name: "Board", exact: true }).click()
  await page.getByRole("button", { name: "New task", exact: false }).click()
  await page.getByLabel("Title", { exact: true }).fill("Faltan 30 mil")
  await pick(page, page.getByLabel("Tipo de tarea"), "investigación")
  await page.getByRole("button", { name: "Create task", exact: true }).click()
  await page.getByRole("tab", { name: "Investigación", exact: true }).click()
  await page.getByLabel("Afirmación", { exact: true }).fill("El depósito se duplicó")
  await page.getByRole("button", { name: "Añadir", exact: true }).click()
  const claim = page.getByTestId("claim")
  await expect(claim).toContainText("sin evidencia")
  await claim.getByRole("button", { name: "Verificar" }).click()
  await expect(claim).toContainText("verificado")
  await page.getByRole("button", { name: "Generar reporte" }).click()
  const report = page.getByTestId("report")
  await expect(report).toContainText("Versión 1")
  await report.getByRole("button", { name: "Leer" }).click()
  await expect(page.getByTestId("report-body")).toContainText("El depósito se duplicó")
})

test("Codex con la suscripción: el humano lo enciende en Ajustes y queda a su nombre", async ({
  page,
}) => {
  // Este daemon arranca sin --codex-subscription; el del beforeEach se cierra en afterEach.
  const off = await bootDaemon({ KEEL_E2E_CODEX_OFF: "1" })
  await nativeShell(page, off)
  await page.goto("/")
  await expect(page.locator(".header-status")).toContainText("keeld", { timeout: 15_000 })
  await page.getByRole("button", { name: "Project setup", exact: true }).click()
  const toggle = page.getByLabel("Usar Codex con mi suscripción de ChatGPT")
  await expect(toggle).not.toBeChecked()
  // El estado lo confirma el daemon: la casilla cambia cuando responde.
  await toggle.click()
  await expect(toggle).toBeChecked()
  await expect(page.locator(".plugins", { hasText: "Proveedores" })).toContainText("Encendido por")
  off.proc.stdin?.end()
  await new Promise((r) => off.proc.once("exit", r))
})

test("presupuesto: el humano pone 50 por run y quita el tope del día", async ({ page }) => {
  await nativeShell(page, daemon)
  await page.goto("/")
  await expect(page.locator(".header-status")).toContainText("keeld", { timeout: 15_000 })
  await page.getByRole("button", { name: "Project setup", exact: true }).click()
  const form = page.getByTestId("limits")
  // Con step 0.5 desde min 0.1, el navegador rechazaba 50 como «valor no válido».
  await form.getByLabel("Presupuesto por run", { exact: true }).fill("50")
  await form.getByLabel("Presupuesto por día: sin tope").check()
  await expect(form.getByLabel("Presupuesto por día", { exact: true })).toBeDisabled()
  await form.getByRole("button", { name: "Guardar" }).click()
  await expect(page.getByTestId("limits-off")).toContainText("Sin tope por día")
  await expect(form).toContainText("Los cambió")
  await expect(form.getByLabel("Presupuesto por run", { exact: true })).toHaveValue("50")
})

test("modelo al empezar una tarea: el humano lo elige en Ajustes y lo restablece", async ({
  page,
}) => {
  await nativeShell(page, daemon)
  await page.goto("/")
  await expect(page.locator(".header-status")).toContainText("keeld", { timeout: 15_000 })
  await page.getByRole("button", { name: "Project setup", exact: true }).click()
  const box = page.getByTestId("default-models")
  await expect(box).toContainText("Sin elegir")
  await box.getByRole("button", { name: "Modelo y esfuerzo" }).first().click()
  // Con el proveedor doble, la lista es sólo el modelo del perfil.
  await page.getByRole("dialog", { name: "Modelo" }).getByRole("button", { name: /haiku/ }).click()
  await expect(box).toContainText("Los eligió")
  await box.getByRole("button", { name: "Restablecer" }).click()
  await expect(box).toContainText("Sin elegir")
})
