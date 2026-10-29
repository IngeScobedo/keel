/**
 * Los controles de `ui/` (ADR-0034 §2) no son `<select>` nativos: se abren con un clic y
 * la opción se elige por su texto, en la lista que se monta encima de la página.
 */
import type { Locator, Page } from "@playwright/test"

export async function pick(page: Page, trigger: Locator, option: string | RegExp) {
  await trigger.click()
  await page
    .getByRole(
      "option",
      typeof option === "string" ? { name: option, exact: true } : { name: option },
    )
    .click()
}
