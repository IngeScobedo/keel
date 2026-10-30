/**
 * Los controles de `ui/` (ADR-0034 §2) no son `<select>` nativos: se abren con un clic y
 * la opción se elige por su texto, en la lista que se monta encima de la página.
 */
import { expect, type Locator, type Page } from "@playwright/test"

export async function pick(page: Page, trigger: Locator, option: string | RegExp) {
  // La lista anterior puede seguir cerrándose (animación de Base UI): se espera antes
  // de abrir otra, si no hay dos opciones con el mismo nombre.
  await expect(page.getByRole("listbox")).toHaveCount(0)
  await trigger.click()
  await page
    .getByRole("listbox")
    .getByRole(
      "option",
      typeof option === "string" ? { name: option, exact: true } : { name: option },
    )
    .click()
  await expect(page.getByRole("listbox")).toHaveCount(0)
}

/**
 * ADR-0034 §5: trabajar deja la vista en la tarea. Para la vista del run a pantalla
 * completa, se abre el más reciente desde el panel «Runs».
 */
export async function openLatestRun(page: Page) {
  const rail = page.getByRole("navigation", { name: "Contexto" })
  await rail.getByRole("button", { name: "Runs", exact: true }).click()
  await page.getByRole("complementary", { name: "Runs" }).locator(".run-card").first().click()
}
