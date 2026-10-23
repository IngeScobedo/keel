/**
 * Identidad de procesos de proveedor para reconciliar tras una caída (ADR-0003
 * §9, SDD 02 §2: «PID aislado no demuestra identidad de un proceso»).
 *
 * Un proceso se identifica por **pid + instante de arranque**, más el
 * ejecutable cuando se conoce. Un pid reutilizado por otro programa tiene otro
 * instante de arranque, así que Keel nunca termina un proceso ajeno, y nunca
 * busca por nombre. Sin instante registrado, no se termina nada.
 *
 * Tablas por plataforma: `/proc` en Linux (incluido WSL2) y CIM
 * (`Win32_Process`) en Windows. Ambas se midieron en su plataforma. En el resto
 * no hay tabla: la reconciliación marca los runs pero no termina procesos, y lo
 * dice.
 */
import { execFile } from "node:child_process"
import { readFileSync, readlinkSync } from "node:fs"
import { resolve } from "node:path"

export type ProcessInfo = {
  pid: number
  ppid: number | null
  exe: string | null
  cmdline: string | null
  /** Sólo en Linux; en Windows no se puede leer el cwd de otro proceso sin privilegios. */
  cwd: string | null
  /** Opaco y comparable por igualdad: `<boot_id>:<ticks>` en Linux, ISO UTC en Windows. */
  startedAt: string | null
}

/** Lo que el daemon guarda en el manifest del run al lanzar el proceso. */
export type RecordedProcess = {
  pid: number
  started_at: string | null
  exe: string | null
  cwd?: string | null
}

export interface ProcessTable {
  readonly kind: "linux-proc" | "windows-cim" | "none"
  get(pid: number): Promise<ProcessInfo | null>
  /** Termina el proceso. Sólo se llama tras comprobar la identidad con `sameProcess`. */
  terminate(pid: number): boolean
}

/** ¿Es `current` el mismo proceso que se registró? Conservador: ante la duda, no. */
export function sameProcess(
  recorded: RecordedProcess,
  current: ProcessInfo,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (recorded.pid !== current.pid) return false
  if (recorded.started_at === null || current.startedAt !== recorded.started_at) return false
  if (recorded.exe && current.exe && !samePath(recorded.exe, current.exe, platform)) return false
  return true
}

function samePath(a: string, b: string, platform: NodeJS.Platform): boolean {
  return platform === "win32"
    ? resolve(a).toLowerCase() === resolve(b).toLowerCase()
    : resolve(a) === resolve(b)
}

export function defaultProcessTable(platform: NodeJS.Platform = process.platform): ProcessTable {
  if (platform === "linux") return new LinuxProcTable()
  if (platform === "win32") return new WindowsCimTable()
  return { kind: "none", get: async () => null, terminate: () => false }
}

export class LinuxProcTable implements ProcessTable {
  readonly kind = "linux-proc"
  private bootId: string | null = null

  async get(pid: number): Promise<ProcessInfo | null> {
    let stat: string
    try {
      stat = readFileSync(`/proc/${pid}/stat`, "utf8")
    } catch {
      return null
    }
    // El nombre (campo 2) va entre paréntesis y puede contener espacios: se corta tras el último «)».
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ")
    const ppid = Number(fields[1])
    const ticks = fields[19] // campo 22, starttime en ticks desde el arranque del sistema
    this.bootId ??= tryRead("/proc/sys/kernel/random/boot_id")?.trim() ?? "unknown-boot"
    return {
      pid,
      ppid: Number.isFinite(ppid) ? ppid : null,
      exe: tryLink(`/proc/${pid}/exe`),
      cmdline: tryRead(`/proc/${pid}/cmdline`)?.split("\0").filter(Boolean).join(" ") ?? null,
      cwd: tryLink(`/proc/${pid}/cwd`),
      startedAt: ticks ? `${this.bootId}:${ticks}` : null,
    }
  }

  terminate(pid: number): boolean {
    try {
      return process.kill(pid, "SIGTERM")
    } catch {
      return false
    }
  }
}

export class WindowsCimTable implements ProcessTable {
  readonly kind = "windows-cim"

  async get(pid: number): Promise<ProcessInfo | null> {
    if (!Number.isInteger(pid) || pid <= 0) return null
    const script = [
      "[Console]::OutputEncoding = [Text.Encoding]::UTF8",
      `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}"`,
      "if ($p) { [pscustomobject]@{ ppid = $p.ParentProcessId; exe = $p.ExecutablePath; cmd = $p.CommandLine;",
      "  start = $p.CreationDate.ToUniversalTime().ToString('o') } | ConvertTo-Json -Compress }",
    ].join("\n")
    const out = await new Promise<string>((ok) =>
      execFile(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", script],
        { windowsHide: true, encoding: "utf8" },
        (err, stdout) => ok(err ? "" : stdout.trim()),
      ),
    )
    if (!out) return null
    const p = JSON.parse(out) as { ppid?: number; exe?: string; cmd?: string; start?: string }
    return {
      pid,
      ppid: p.ppid ?? null,
      exe: p.exe ?? null,
      cmdline: p.cmd ?? null,
      cwd: null,
      startedAt: p.start ?? null,
    }
  }

  terminate(pid: number): boolean {
    try {
      // En Windows, process.kill termina el proceso con TerminateProcess.
      return process.kill(pid)
    } catch {
      return false
    }
  }
}

function tryRead(path: string): string | null {
  try {
    return readFileSync(path, "utf8")
  } catch {
    return null
  }
}

function tryLink(path: string): string | null {
  try {
    return readlinkSync(path)
  } catch {
    return null
  }
}
