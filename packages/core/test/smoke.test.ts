import { expect, test } from "bun:test"
import * as pkg from "../src/index.ts"

test("el modulo carga", () => {
  expect(pkg).toBeDefined()
})
