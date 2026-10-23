/**
 * La GUI contra un daemon real (SQLite, git y socket reales; proveedores
 * dobles). El shell de Tauri se sustituye por un puente en el proceso de
 * Playwright que abre el mismo socket y reenvía las mismas tramas que
 * `src-tauri/src/transport.rs`; la GUI no nota la diferencia.
 */
import { type ChildProcess, spawn } from "node:child_process"
import { createConnection, type Socket } from "node:net"
import { join } from "node:path"
import { createInterface } from "node:readline"
import { expect, type Page, test } from "@playwright/test"

const FIXTURE = join(import.meta.dirname, "..", "..", "daemon", "test", "fixtures", "e2e-daemon.ts")

type Daemon = { proc: ChildProcess; socket: string; project_id: string; other_repo: string }
async function bootDaemon(): Promise<Daemon> {
  const proc = spawn("bun", [FIXTURE], { stdio: ["pipe", "pipe", "inherit"] })
  const line = await new Promise<string>((resolve, reject) => {
    const rl = createInterface({ input: proc.stdout as NodeJS.ReadableStream })
    rl.once("line", resolve)
    proc.once("exit", (code) => reject(new Error(`el daemon salió con ${code}`)))
  })
  return {
    proc,
    ...(JSON.parse(line) as { socket: string; project_id: string; other_repo: string }),
  }
}

/** Cliente NDJSON mínimo: el mismo que usa el shell nativo, sin lógica. */
class Line {
  private buf = ""
  private waiting = new Map<string, (m: Record<string, unknown>) => void>()
  readonly sock: Socket
  constructor(sock: Socket, onNotification: (m: unknown) => void) {
    this.sock = sock
    sock.setEncoding("utf8")
    sock.on("data", (chunk: string) => {
      this.buf += chunk
      for (let i = this.buf.indexOf("\n"); i >= 0; i = this.buf.indexOf("\n")) {
        const raw = this.buf.slice(0, i)
        this.buf = this.buf.slice(i + 1)
        if (!raw.trim()) continue
        const m = JSON.parse(raw) as Record<string, unknown>
        const id = m.id as string | undefined
        if (id !== undefined && this.waiting.has(id)) {
          this.waiting.get(id)?.(m)
          this.waiting.delete(id)
        } else onNotification(m)
      }
    })
  }
  static open(path: string, onNotification: (m: unknown) => void = () => {}) {
    return new Promise<Line>((resolve, reject) => {
      const sock = createConnection(path, () => resolve(new Line(sock, onNotification)))
      sock.once("error", reject)
    })
  }
  send(frame: { id: string }) {
    const p = new Promise<Record<string, unknown>>((r) => this.waiting.set(frame.id, r))
    this.sock.write(`${JSON.stringify(frame)}\n`)
    return p
  }
  async call(method: string, params: Record<string, unknown> = {}) {
    const m = await this.send({
      jsonrpc: "2.0",
      keel_protocol: 1,
      id: crypto.randomUUID(),
      method,
      params,
    } as { id: string })
    if (m.error) throw new Error((m.error as { message: string }).message)
    return m.result as Record<string, unknown>
  }
}
const meta = () => ({ request_id: crypto.randomUUID(), idempotency_key: crypto.randomUUID() })

/** Sustituye `__TAURI_INTERNALS__` por un puente hacia el socket real. */
async function nativeShell(page: Page, daemon: Daemon) {
  let line: Line | null = null
  await page.exposeFunction(
    "__keelNative",
    async (command: string, args: { path?: string; frame?: { id: string } }) => {
      if (command === "ipc_default_path") return daemon.socket
      if (command === "daemon_ensure") return "running"
      if (command === "ipc_connect") {
        line?.sock.destroy()
        line = await Line.open(args.path as string, (frame) => {
          void page.evaluate(
            (f) => (window as unknown as { __keelPush(f: unknown): void }).__keelPush(f),
            frame,
          )
        })
        return null
      }
      if (command === "ipc_disconnect") {
        line?.sock.destroy()
        line = null
        return null
      }
      if (command === "ipc_request") {
        if (!line) throw new Error("Daemon no conectado")
        return line.send(args.frame as { id: string })
      }
      throw new Error(`comando desconocido ${command}`)
    },
  )
  await page.addInitScript(() => {
    const callbacks = new Map<number, (event: unknown) => void>()
    let handler = 0
    let next = 0
    const native = window as unknown as { __keelNative(c: string, a: unknown): Promise<unknown> }
    Object.assign(window, {
      isTauri: true,
      __keelPush(frame: unknown) {
        callbacks.get(handler)?.({ payload: frame })
      },
      __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener() {} },
      __TAURI_INTERNALS__: {
        transformCallback(callback: (event: unknown) => void) {
          const id = ++next
          callbacks.set(id, callback)
          return id
        },
        async invoke(command: string, args: Record<string, unknown>) {
          if (command === "plugin:event|listen") {
            handler = Number(args.handler)
            return 1
          }
          if (command === "plugin:event|unlisten") return undefined
          return native.__keelNative(command, args)
        },
      },
    })
  })
}

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
  await page.locator(".live-actions").getByRole("button", { name: "Planear" }).click()
  await expect(page.locator(".run-page .toolbar")).toContainText("Succeeded", { timeout: 20_000 })
  // El run se lee como conversación: instrucción, herramientas y respuesta, lo nuevo abajo.
  await expect(page.getByTestId("chat-tool").first()).toBeVisible()
  await expect(page.getByTestId("chat-agent").last()).toBeVisible()
  await expect(page.locator(".run-summary")).toContainText("raíz del repo")

  // 2. Pasarla a planned y ejecutar con Codex: el comando pide aprobación.
  await page.locator(".run-page .toolbar .text-link").click()
  await page.getByRole("button", { name: "Mover a planned" }).click()
  await page.getByLabel("Proveedor").selectOption("codex")
  if (process.env.KEEL_E2E_SHOTS)
    await page.screenshot({ path: join(process.env.KEEL_E2E_SHOTS, "start.png") })
  await page.getByLabel("Instrucción para el agente").fill("approval")
  await page.locator(".live-actions").getByRole("button", { name: "Ejecutar" }).click()
  await expect(page.locator(".run-page .toolbar")).toContainText("Waiting for you", {
    timeout: 20_000,
  })
  // La aprobación aparece dentro de la conversación del run; también en el Inbox.
  await expect(page.getByTestId("chat-approval")).toContainText("pide permiso")
  await expect(page.locator(".chat-approval-input")).not.toBeEmpty()
  await expect(page.locator(".run-summary")).toContainText("keel/")
  if (process.env.KEEL_E2E_SHOTS)
    await page.screenshot({ path: join(process.env.KEEL_E2E_SHOTS, "run.png") })
  // El Inbox la muestra con las mismas opciones; se decide desde el chat con «Siempre».
  await page.getByRole("button", { name: "Inbox", exact: true }).click()
  await expect(page.getByTestId("approval")).toContainText("touch x")
  await page.getByRole("button", { name: "Runs", exact: true }).click()
  await page.locator("tbody tr").last().getByRole("button").click()
  const chatApproval = page.getByTestId("chat-approval")
  await chatApproval.getByRole("button", { name: /Siempre: Bash\(touch x:\*\)/ }).click()
  await expect(chatApproval).toContainText("aprobado")
  await expect(page.locator(".run-page .toolbar")).toContainText("Succeeded", { timeout: 20_000 })
  await expect(page.locator(".mode-badge")).toHaveText("ask")

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
  await expect(page.locator("tbody tr")).toHaveCount(2)

  // 3. Una sesión externa pide entrar; se aprueba desde el Inbox con tarea y scopes.
  const external = await Line.open(daemon.socket)
  const pairing = await external.call("session.pair", { client_name: "codex a mano", cwd: "/x" })
  await page.getByRole("button", { name: "Inbox", exact: true }).click()
  const card = page.getByTestId("pairing")
  await expect(card).toContainText(`código ${pairing.code}`)
  await card.getByRole("button", { name: "Revisar y aprobar" }).click()
  await page.getByLabel("Tarea vinculada").selectOption({ label: "KEEL-1 · Retry con backoff" })
  await page.getByRole("checkbox", { name: /Crear tareas/ }).uncheck()
  await page.getByRole("button", { name: "Aprobar sesión" }).click()
  await expect(card).toHaveCount(0)
  expect(await external.call("session.pair_status")).toMatchObject({
    state: "approved",
    scopes: ["tasks:read", "notes:write", "runs:request"],
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
})
