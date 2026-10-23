import { expect, test } from "@playwright/test"

test("native boundary uses validated IPC and live data never mixes with demo tasks", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const callbacks = new Map<number, (event: unknown) => void>()
    let handler = 0
    let next = 0
    const methods: string[] = []
    const item = {
      id: "real-task",
      project_id: "real-project",
      display_id: "KEEL-1",
      title: "Real IPC fixture task",
      lifecycle: "triage",
      board_status: "backlog",
      visual_state: "queued",
      revision: 0,
    }
    Object.assign(window, {
      isTauri: true,
      __keelTestMethods: methods,
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
          if (["plugin:event|unlisten", "ipc_connect", "ipc_disconnect"].includes(command))
            return undefined
          const frame = args.frame as {
            id: string
            method: string
            params: Record<string, unknown>
          }
          if (frame.method) methods.push(frame.method)
          let result: unknown
          if (frame.method === "daemon.health")
            result = {
              version: "test",
              event_loop_lag_ms: 2,
              rss_bytes: 1024,
              ingest_queue: 0,
              wal_bytes: 0,
            }
          if (frame.method === "events.subscribe") {
            // Replay antes de la respuesta, como el servidor real.
            callbacks.get(handler)?.({
              payload: {
                jsonrpc: "2.0",
                keel_protocol: 1,
                method: "events.event",
                params: {
                  event_seq: 1,
                  project_id: "real-project",
                  run_id: null,
                  kind: "approval.requested",
                  received_at: "2026-10-14T00:00:00Z",
                  payload: {
                    approval_id: "approval-live",
                    operation_hash: "hash-live",
                    tool: "Bash",
                  },
                },
              },
            })
            result = {
              subscription_id: "sub-test",
              cursor: 1,
              snapshot: { work_items: [item], runs: [] },
            }
          }
          if (frame.method === "approvals.list")
            result = {
              approvals: [
                {
                  id: "approval-live",
                  run_id: "run-live",
                  work_item_id: "real-task",
                  operation_hash: "hash-live",
                  operation: { tool: "Bash", input: { command: "rm -rf build" } },
                  state: "pending",
                  expires_at: null,
                },
              ],
            }
          if (frame.method === "session.pairings_list") result = { pairings: [] }
          if (frame.method === "runs.requests_list") result = { requests: [] }
          if (frame.method === "work_items.create")
            result = {
              ...item,
              id: "new-real-task",
              display_id: "KEEL-2",
              title: frame.params.title,
            }
          return { jsonrpc: "2.0", keel_protocol: 1, id: frame.id, result }
        },
      },
    })
  })
  await page.goto("/")
  await page.getByRole("button", { name: "Project setup", exact: true }).click()
  await page.getByRole("button", { name: "Configurar conexión", exact: true }).click()
  await page.getByLabel("Socket del host").fill("/tmp/keel.sock")
  await page.getByLabel("Project ID (opcional)").fill("real-project")
  await page.getByRole("button", { name: "Connect", exact: true }).click()
  await expect(page.getByRole("dialog")).toContainText("Conectado · 1 tareas")
  await page.getByRole("button", { name: "Cerrar", exact: true }).click()
  await page.getByRole("button", { name: "Board", exact: true }).click()
  await expect(page.locator(".task-card")).toHaveCount(1)
  await expect(page.locator(".task-card")).toContainText("Real IPC fixture task")
  await expect(page.locator(".status-bar")).toContainText("Costo desconocido")
  await page.getByRole("button", { name: "Inbox", exact: true }).click()
  // El Inbox en vivo lee la lista durable del daemon, no los eventos sueltos.
  await expect(page.getByTestId("approval")).toContainText("rm -rf build")
  await expect(page.getByRole("button", { name: "Aprobar una vez", exact: true })).toBeEnabled()
  await page.getByRole("button", { name: "Board", exact: true }).click()
  await page.getByRole("button", { name: "New task", exact: false }).click()
  await page.getByLabel("Title", { exact: true }).fill("Created through native IPC")
  await page.getByRole("button", { name: "Create task", exact: true }).click()
  await expect(page.getByRole("heading", { name: "Created through native IPC" })).toBeVisible()
  const methods = await page.evaluate(
    () => (window as unknown as { __keelTestMethods: string[] }).__keelTestMethods,
  )
  expect(methods).toContain("work_items.create")
  expect(methods).not.toContain("runs.start")
  expect(methods).not.toContain("approvals.resolve")
})
