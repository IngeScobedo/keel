/**
 * Abre un link o un archivo en el navegador del humano con lo que su sistema ya tiene:
 * `open` en macOS, `start` en Windows, el Windows de fuera en WSL y `xdg-open` en Linux.
 * Quien llama decide qué se puede abrir (GitHub, claude.ai, un artefacto exportado).
 */
import { spawnSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"

const isWsl = () =>
  process.platform === "linux" &&
  existsSync("/proc/version") &&
  /microsoft/i.test(readFileSync("/proc/version", "utf8"))

export function openUrl(url: string): { opened: boolean; how: string | null } {
  const tries: [string, string[]][] =
    process.platform === "darwin"
      ? [["open", [url]]]
      : process.platform === "win32"
        ? [["cmd", ["/c", "start", "", url]]]
        : isWsl()
          ? [
              ["/mnt/c/Windows/System32/cmd.exe", ["/c", "start", "", url.replace(/&/g, "^&")]],
              ["wslview", [url]],
            ]
          : [["xdg-open", [url]]]
  return run(tries)
}

/** Un archivo local con la app que su sistema tenga para él (un `.html`, el navegador). */
export function openFile(path: string): { opened: boolean; how: string | null } {
  if (isWsl()) {
    const win = spawnSync("wslpath", ["-w", path], { encoding: "utf8", timeout: 5_000 })
    const target = win.status === 0 ? win.stdout.trim() : null
    // `explorer.exe` sale con 1 aunque haya abierto: vale que haya corrido.
    if (target) {
      const r = spawnSync("/mnt/c/Windows/explorer.exe", [target], {
        stdio: "ignore",
        timeout: 10_000,
      })
      if (!r.error) return { opened: true, how: "explorer.exe" }
    }
  }
  return run(
    process.platform === "darwin"
      ? [["open", [path]]]
      : process.platform === "win32"
        ? [["cmd", ["/c", "start", "", path]]]
        : [["xdg-open", [path]]],
  )
}

function run(tries: [string, string[]][]): { opened: boolean; how: string | null } {
  for (const [cmd, args] of tries) {
    const r = spawnSync(cmd, args, { stdio: "ignore", timeout: 10_000, windowsHide: true })
    if (!r.error && r.status === 0) return { opened: true, how: cmd.split("/").at(-1) ?? cmd }
  }
  return { opened: false, how: null }
}
