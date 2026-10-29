/**
 * ADR-0034 §6 contra un daemon real: con la ventana en un proyecto, lo que pide al
 * humano en otro aparece como aviso. Se aprueba desde el aviso sin salir; «Ver» lleva a
 * la tarea en su proyecto y «atrás» regresa al proyecto y al lugar de antes.
 */
import { expect, test } from "@playwright/test"
import { bootDaemon, type Daemon, Line, meta, nativeShell } from "./daemon-bridge.js"

let daemon: Daemon
test.beforeEach(async () => {
  daemon = await bootDaemon()
})
test.afterEach(async () => {
  daemon.proc.stdin?.end()
  await new Promise((r) => daemon.proc.once("exit", r))
})

/** Otro cliente humano abre el segundo proyecto y lanza un run que pide permiso. */
async function askInOtherProject(title: string) {
  const other = await Line.open(daemon.socket)
  const project = (await other.call("projects.open", { path: daemon.other_repo })) as {
    id: string
  }
  const w = (await other.call("work_items.create", { ...meta(), title, kind: "chore" })) as {
    id: string
    revision: number
  }
  const planned = (await other.call("work_items.transition", {
    ...meta(),
    work_item_id: w.id,
    to: "planned",
  })) as { revision: number }
  void planned
  await other.call("runs.start", {
    ...meta(),
    work_item_id: w.id,
    purpose: "execute",
    profile: "codex",
    prompt: "approval",
  })
  return { other, project_id: project.id }
}

test("avisos entre proyectos: aprobar sin salir, «Ver» y «atrás» al proyecto de antes", async ({
  page,
}) => {
  test.setTimeout(60_000)
  await nativeShell(page, daemon)
  await page.goto("/")
  await expect(page.locator(".header-status")).toContainText("keeld", { timeout: 15_000 })
  await page.getByRole("button", { name: "New task", exact: false }).click()
  await page.getByLabel("Title", { exact: true }).fill("tarea del proyecto A")
  await page.getByRole("button", { name: "Create task", exact: true }).click()
  await expect(page.locator(".breadcrumbs [aria-current=page]")).toHaveText(/-1$/)

  // 1. Se aprueba desde el aviso: la ventana sigue donde estaba.
  const first = await askInOtherProject("desplegar en B")
  const toast = page.locator(".ui-toast").filter({ hasText: "desplegar en B" })
  await expect(toast).toBeVisible({ timeout: 20_000 })
  await expect(toast).toContainText("otro")
  await expect(toast.getByTestId("attention")).toContainText("touch x")
  await toast.getByRole("button", { name: "Aprobar", exact: true }).click()
  await expect(toast).toBeHidden()
  await expect(page.getByTestId("task-focus")).toContainText("tarea del proyecto A")
  first.other.sock.destroy()

  // 2. «Ver» abre la tarea en su proyecto; «atrás» vuelve al proyecto A y a su tarea.
  const second = await askInOtherProject("migrar en B")
  const toast2 = page.locator(".ui-toast").filter({ hasText: "migrar en B" })
  await expect(toast2).toBeVisible({ timeout: 20_000 })
  await toast2.getByRole("button", { name: "Ver", exact: true }).click()
  await expect(page.getByTestId("task-focus")).toContainText("migrar en B", { timeout: 15_000 })
  await expect(page.getByRole("button", { name: "Proyecto", exact: true })).toContainText("otro")
  await page.goBack()
  await expect(page.getByTestId("task-focus")).toContainText("tarea del proyecto A", {
    timeout: 15_000,
  })
  await expect(page.getByRole("button", { name: "Proyecto", exact: true })).toContainText("repo")
  // Lo que quedó esperando se niega: el run termina y el daemon puede salir.
  const left = (await second.other.call("approvals.list", { all_projects: true })) as {
    approvals: { id: string; operation_hash: string }[]
  }
  for (const a of left.approvals)
    await second.other.call("approvals.resolve", {
      ...meta(),
      approval_id: a.id,
      operation_hash: a.operation_hash,
      decision: "deny",
    })
  second.other.sock.destroy()
})
