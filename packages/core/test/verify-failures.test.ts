import { describe, expect, test } from "bun:test"
import { failureKeys } from "../src/index.ts"

// Fragmentos de las salidas reales de KEEL-13 y KEEL-24 en Casa Matte (2026-11-02).
const WT = "/home/u/.local/state/keel/worktrees/P/casa-matte-monorepo/KEEL-13/R/root"

describe("ADR-0021 §4: la huella de cada falla", () => {
  test("tsc: sin línea ni ruta del worktree, y repetidas cuentan", () => {
    const out = [
      "$ bun run typecheck",
      "src/G/Galleries.tsx(120,5): error TS6133: 'hasChapters' is declared but its value is never read.",
      `src/C.test.tsx(10,27): error TS6305: Output file '${WT}/apps/store/dist/C.d.ts' has not been built from source file '${WT}/apps/store/src/C.tsx'.`,
      "src/P.test.tsx(27,23): error TS7031: Binding element 'item' implicitly has an 'any' type.",
      "src/P.test.tsx(73,25): error TS7031: Binding element 'item' implicitly has an 'any' type.",
    ].join("\n")
    expect(failureKeys(out, WT)).toEqual([
      "src/G/Galleries.tsx TS6133: 'hasChapters' is declared but its value is never read.",
      "src/C.test.tsx TS6305: Output file '<wt>/apps/store/dist/C.d.ts' has not been built from source file '<wt>/apps/store/src/C.tsx'.",
      "src/P.test.tsx TS7031: Binding element 'item' implicitly has an 'any' type.",
      "src/P.test.tsx TS7031: Binding element 'item' implicitly has an 'any' type. (#2)",
    ])
    // Otro worktree, otra línea: la misma huella.
    const other = "/tmp/wt/base-1"
    expect(
      failureKeys(
        `src/C.test.tsx(11,27): error TS6305: Output file '${other}/apps/store/dist/C.d.ts' has not been built from source file '${other}/apps/store/src/C.tsx'.`,
        other,
      ),
    ).toEqual([
      "src/C.test.tsx TS6305: Output file '<wt>/apps/store/dist/C.d.ts' has not been built from source file '<wt>/apps/store/src/C.tsx'.",
    ])
  })

  test("vitest: el resumen final, con proyecto, archivo y test", () => {
    const out = [
      " ❯ |@casamatte/store| src/pay/PayPalCheckout.test.tsx (26 tests | 1 failed) 15830ms",
      "     × pinta PayPal y los cuatro card fields 1594ms",
      "⎯⎯⎯⎯⎯⎯ Failed Suites 1 ⎯⎯⎯⎯⎯⎯⎯",
      " FAIL  |@casamatte/store| src/shop/ProductsGrid.test.tsx [ src/shop/ProductsGrid.test.tsx ]",
      "⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯",
      " FAIL  |@casamatte/store| src/pay/PayPalCheckout.test.tsx > PayPalCheckout · métodos > pinta PayPal y los cuatro card fields",
      " Test Files  1 failed | 42 passed (43)",
    ].join("\n")
    expect(failureKeys(out)).toEqual([
      "|@casamatte/store| src/shop/ProductsGrid.test.tsx",
      "|@casamatte/store| src/pay/PayPalCheckout.test.tsx > PayPalCheckout · métodos > pinta PayPal y los cuatro card fields",
    ])
  })

  test("bun test y jest", () => {
    expect(
      failureKeys(
        [
          "test/a.test.ts:",
          "(pass) A > bien [0.10ms]",
          "(fail) A > mal [1.23ms]",
          " 1 pass",
          " 1 fail",
        ].join("\n"),
      ),
    ).toEqual(["test/a.test.ts > A > mal"])
    expect(failureKeys("  ● Suite › falla\n")).toEqual(["Suite › falla"])
  })

  test("verde conocido: sin huellas; formato desconocido: null", () => {
    expect(failureKeys(" Test Files  43 passed (43)\n      Tests  323 passed (323)")).toEqual([])
    expect(failureKeys('error: Script not found "nx"')).toBeNull()
  })
})
