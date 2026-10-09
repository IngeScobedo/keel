/**
 * Grabador NDJSON del spike. Una línea por mensaje del SDK y una por hook.
 * Las capturas van a captures/ (gitignored): contienen rutas de esta máquina y
 * texto de los agentes; se redactan antes de promoverlas a fixtures.
 */
import { appendFileSync, mkdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
export const capturesDir = join(here, "..", "captures")

export function openCapture(name: string): { path: string; write: (row: object) => void } {
  mkdirSync(capturesDir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, "-")
  const path = join(capturesDir, `${stamp}-${name}.ndjson`)
  return {
    path,
    write(row) {
      appendFileSync(path, `${JSON.stringify(row)}\n`)
    },
  }
}

/** Reloj de pared del spike: la autoridad de orden es el receptor, no la fuente (ADR-0002 de Mirador). */
export function now(): string {
  return new Date().toISOString()
}

export function writeReport(name: string, report: object): string {
  mkdirSync(capturesDir, { recursive: true })
  const path = join(capturesDir, `report-${name}.json`)
  appendFileSync(path, "")
  Bun.write(path, `${JSON.stringify(report, null, 2)}\n`)
  return path
}
