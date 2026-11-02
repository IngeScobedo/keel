/**
 * ADR-0021 §4, «verde es delta-verde»: un comando que ya estaba rojo esconde los
 * errores nuevos si se compara sólo su código de salida. En KEEL-13 el typecheck ya
 * fallaba por salidas viejas de `dist/` y el `hasChapters` sin uso de T7 entró como
 * «ya estaba rojo»; igual el test de PayPal de T9.
 *
 * Aquí se saca de la salida una huella por falla: cada error de `tsc` y cada test que
 * falla. Sin números de línea (el código se mueve) y sin la ruta del worktree (el
 * baseline se mide en otro). Si la salida no tiene un formato conocido, `null`: el
 * delta vuelve a comparar el comando entero.
 */

const TSC = [
  // tsc sin `--pretty`: `src/a.ts(12,5): error TS6133: …`
  /^(\S[^(]*?)\(\d+,\d+\): error (TS\d+): (.*)$/,
  // tsc con `--pretty`: `src/a.ts:12:5 - error TS6133: …`
  /^(\S.*?):\d+:\d+ - error (TS\d+): (.*)$/,
]
/** vitest, resumen final: ` FAIL  |proyecto| src/a.test.ts > describe > test`. */
const VITEST = /^\s*FAIL\s+(?:\|([^|]+)\|\s+)?(\S+\.\w+)(?:\s+>\s+(.*?))?(?:\s+\[ .* \])?\s*$/
/** bun test: `(fail) describe > test [1.23ms]`, bajo la línea `src/a.test.ts:`. */
const BUN_FAIL = /^\(fail\) (.*?)(?: \[[\d.]+m?s\])?$/
const BUN_FILE = /^(\S+\.(?:test|spec)\.[cm]?[jt]sx?):$/
/** jest: `  ● describe › test`. */
const JEST = /^\s*● (.+ › .+)$/

export function failureKeys(output: string, cwd?: string): string[] | null {
  const text = cwd ? output.split(cwd.replace(/\/+$/, "")).join("<wt>") : output
  const keys: string[] = []
  let bunFile = ""
  let known = false
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\s+$/, "")
    const tsc = TSC.map((r) => r.exec(line)).find((m) => m)
    if (tsc) {
      keys.push(`${tsc[1]} ${tsc[2]}: ${tsc[3]}`)
      continue
    }
    const v = VITEST.exec(line)
    if (v) {
      keys.push([`${v[1] ? `|${v[1].trim()}| ` : ""}${v[2]}`, v[3]].filter(Boolean).join(" > "))
      continue
    }
    const file = BUN_FILE.exec(line)
    if (file) {
      bunFile = file[1] as string
      known = true
      continue
    }
    const bun = BUN_FAIL.exec(line)
    if (bun) {
      keys.push(bunFile ? `${bunFile} > ${bun[1]}` : (bun[1] as string))
      continue
    }
    const jest = JEST.exec(line)
    if (jest) keys.push(jest[1] as string)
    else if (/^ ?(Test Files|Tests) +\d/.test(line) || /^Found \d+ errors?\b/.test(line))
      known = true
  }
  if (keys.length === 0 && !known) return null
  return numbered(keys)
}

/** La misma falla dos veces son dos huellas: una tercera ocurrencia es nueva. */
function numbered(keys: string[]): string[] {
  const seen = new Map<string, number>()
  return keys.map((k) => {
    const n = (seen.get(k) ?? 0) + 1
    seen.set(k, n)
    return n === 1 ? k : `${k} (#${n})`
  })
}
