/**
 * GitHub en el daemon (ADR-0043): la sesión de `gh`, su inicio de sesión y lo que ven
 * las tarjetas (PRs, runs). Todo pasa por `@keel/git/github`; el daemon sólo decide
 * cuándo preguntar y guarda lo justo en memoria.
 *
 * El inicio de sesión es el de `gh` (ADR-0002 §1): Keel lo lanza sin terminal, `gh`
 * imprime su código de un solo uso y espera a que el humano autorice en el navegador;
 * el token queda en el almacén de `gh`. El código no va al store de eventos: la GUI lo
 * consulta mientras el diálogo está abierto.
 */
import { type ChildProcess, spawn, spawnSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import type { GithubPr, GithubRun, GithubRunDetail } from "@keel/core"
import {
  type GhStatus,
  ghStatus,
  type PullRequest,
  type RunDetail,
  realDate,
  type WorkflowRun,
} from "@keel/git/github"

export type LoginState = {
  state: "idle" | "waiting" | "done" | "failed" | "cancelled"
  /** El código que `gh` pide escribir en github.com/login/device. */
  code: string | null
  url: string | null
  message: string | null
}

const STATUS_TTL_MS = 30_000

export class GithubService {
  private cached: { at: number; status: GhStatus } | null = null
  private login: { proc: ChildProcess; state: LoginState } | null = null
  private last: LoginState = { state: "idle", code: null, url: null, message: null }

  private readonly gh: () => string | null
  constructor(gh: () => string | null) {
    this.gh = gh
  }

  /** La sesión de `gh`, con caché corta: la consultan todas las tarjetas. */
  async status(fresh = false): Promise<GhStatus> {
    if (!fresh && this.cached && Date.now() - this.cached.at < STATUS_TTL_MS)
      return this.cached.status
    const bin = this.gh()
    const status = bin
      ? await ghStatus({ gh: bin })
      : { installed: false, version: null, accounts: [], ready: false }
    this.cached = { at: Date.now(), status }
    return status
  }

  /** Lanza `gh auth login --web`; si ya hay uno esperando, devuelve ese. */
  startLogin(protocol: "ssh" | "https"): LoginState {
    if (this.login?.state.state === "waiting") return this.login.state
    const bin = this.gh()
    if (!bin) {
      this.last = {
        state: "failed",
        code: null,
        url: null,
        message: "gh no está instalado: instálalo y vuelve a intentar",
      }
      return this.last
    }
    const state: LoginState = { state: "waiting", code: null, url: null, message: null }
    const proc = spawn(
      bin,
      [
        "auth",
        "login",
        "--hostname",
        "github.com",
        "--web",
        "--git-protocol",
        protocol,
        "--skip-ssh-key",
      ],
      {
        // Sin TTY: `gh` no espera Enter ni abre el navegador; imprime el código y la URL.
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1", BROWSER: "" },
        windowsHide: true,
      },
    )
    let tail = ""
    const read = (chunk: Buffer) => {
      const text = chunk.toString()
      tail = `${tail}${text}`.slice(-2000)
      const code = /one-time code:\s*([A-Z0-9]{4}-[A-Z0-9]{4})/.exec(text)?.[1]
      if (code) state.code = code
      const url = /(https:\/\/github\.com\/login\/device)/.exec(text)?.[1]
      if (url) state.url = url
    }
    proc.stdout?.on("data", read)
    proc.stderr?.on("data", read)
    proc.on("close", (code) => {
      if (state.state !== "waiting") return
      state.state = code === 0 ? "done" : "failed"
      state.code = null
      state.message =
        code === 0
          ? null
          : tail
              .split("\n")
              .map((l) => l.trim())
              .filter((l) => l && !/one-time code/.test(l))
              .slice(-2)
              .join(" ") || `gh auth login terminó con ${code}`
      this.cached = null
      this.last = { ...state }
      this.login = null
    })
    this.login = { proc, state }
    return state
  }

  loginState(): LoginState {
    return this.login ? { ...this.login.state } : this.last
  }

  cancelLogin(): LoginState {
    if (this.login) {
      this.login.state.state = "cancelled"
      this.login.state.code = null
      this.login.proc.kill()
      this.last = { ...this.login.state }
      this.login = null
    }
    return this.last
  }

  close(): void {
    this.login?.proc.kill()
  }
}

/**
 * Abre una URL de GitHub en el navegador del humano con lo que su sistema ya tiene:
 * `open` en macOS, `start` en Windows y en WSL (por cmd.exe), `xdg-open` en Linux.
 */
export function openInBrowser(url: string): { opened: boolean; how: string | null } {
  if (!/^https:\/\/github\.com\//.test(url)) return { opened: false, how: null }
  const wsl =
    process.platform === "linux" &&
    existsSync("/proc/version") &&
    /microsoft/i.test(readFileSync("/proc/version", "utf8"))
  const tries: [string, string[]][] =
    process.platform === "darwin"
      ? [["open", [url]]]
      : process.platform === "win32"
        ? [["cmd", ["/c", "start", "", url]]]
        : wsl
          ? [
              ["/mnt/c/Windows/System32/cmd.exe", ["/c", "start", "", url.replace(/&/g, "^&")]],
              ["wslview", [url]],
            ]
          : [["xdg-open", [url]]]
  for (const [cmd, args] of tries) {
    const r = spawnSync(cmd, args, { stdio: "ignore", timeout: 10_000, windowsHide: true })
    if (!r.error && r.status === 0) return { opened: true, how: cmd.split("/").at(-1) ?? cmd }
  }
  return { opened: false, how: null }
}

// --- vistas del protocolo -------------------------------------------------------------

const lower = (s: string | null | undefined) => (s ? s.toLowerCase() : null)

export function prView(pr: PullRequest): GithubPr {
  return {
    number: pr.number,
    title: pr.title,
    url: pr.url,
    state: pr.state.toLowerCase() as GithubPr["state"],
    draft: pr.isDraft,
    base: pr.baseRefName,
    head: pr.headRefName,
    head_sha: pr.headRefOid,
    mergeable: pr.mergeable.toLowerCase(),
    merge_state: pr.mergeStateStatus.toLowerCase(),
    review_decision: pr.reviewDecision ? pr.reviewDecision.toLowerCase() : null,
    additions: pr.additions,
    deletions: pr.deletions,
    author: pr.author?.login ?? null,
    merged_at: pr.mergedAt,
    merged_by: pr.mergedBy?.login ?? null,
    merge_sha: pr.mergeCommit?.oid ?? null,
    body: pr.body,
    // Un CheckRun trae status y conclusion; un StatusContext, sólo state.
    checks: (pr.statusCheckRollup ?? []).map((c) => ({
      name: c.name ?? c.context ?? "check",
      workflow: c.workflowName ?? null,
      status: lower(c.status) ?? (c.state && c.state !== "PENDING" ? "completed" : "in_progress"),
      conclusion: lower(c.conclusion) || (c.state && c.state !== "PENDING" ? lower(c.state) : null),
      started_at: realDate(c.startedAt),
      completed_at: realDate(c.completedAt),
      url: c.detailsUrl ?? c.targetUrl ?? null,
    })),
    files: pr.files ?? [],
  }
}

export function runView(r: WorkflowRun): GithubRun {
  return {
    id: r.databaseId,
    workflow: r.workflowName,
    title: r.displayTitle ?? null,
    status: r.status,
    conclusion: r.conclusion || null,
    event: r.event,
    branch: r.headBranch,
    sha: r.headSha,
    url: r.url,
    created_at: r.createdAt,
    updated_at: r.updatedAt,
    attempt: r.attempt ?? null,
  }
}

export function runDetailView(r: RunDetail, typical_ms: number | null): GithubRunDetail {
  return {
    ...runView(r),
    jobs: r.jobs.map((j) => ({
      id: j.databaseId ?? null,
      name: j.name,
      status: j.status,
      conclusion: j.conclusion || null,
      started_at: realDate(j.startedAt),
      completed_at: realDate(j.completedAt),
      url: j.url ?? null,
      steps: j.steps.map((st) => ({
        number: st.number ?? null,
        name: st.name,
        status: st.status,
        conclusion: st.conclusion || null,
        started_at: realDate(st.startedAt),
        completed_at: realDate(st.completedAt),
      })),
    })),
    typical_ms,
  }
}

/** Mediana de las corridas verdes: la referencia de «suele tardar». */
export function typicalMs(runs: WorkflowRun[]): number | null {
  const ms = runs
    .filter((r) => r.conclusion === "success")
    .map((r) => Date.parse(r.updatedAt) - Date.parse(r.createdAt))
    .filter((x) => x > 0)
    .sort((a, b) => a - b)
  return ms.length ? (ms[Math.floor(ms.length / 2)] ?? null) : null
}

/** Una línea de log sin su hora, sin colores ANSI ni BOM; los grupos de Actions, legibles. */
export function cleanLogLine(line: string): string {
  return (
    line
      .replace(/^\uFEFF/, "")
      .replace(/^\uFEFF?\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z ?/, "")
      // biome-ignore lint/suspicious/noControlCharactersInRegex: colores ANSI del log
      .replace(/\u001b\[[0-9;]*m/g, "")
      // `gh` escribe el ESC como «^[».
      .replace(/\^\[\[[0-9;]*m/g, "")
      .replace(/^##\[group\]/, "▸ ")
      .replace(/^##\[endgroup\]/, "")
  )
}

/**
 * El paso que corre, dentro del log del job en curso: desde su inicio, empezando en su
 * encabezado `##[group]Run …` si lo hay (al mismo segundo suele quedar la cola del
 * anterior). Sólo para un paso sin terminar: uno terminado sale exacto de `gh`.
 */
export function runningStepSlice(log: string, startedAt: string): string {
  const from = Date.parse(startedAt)
  const lines = log.split("\n").filter((raw) => {
    const m = /^\uFEFF?(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)/.exec(raw)
    return m ? Date.parse(m[1] as string) >= from : false
  })
  const head = lines.findIndex((l) => /##\[group\]Run /.test(l))
  return (head >= 0 ? lines.slice(head) : lines).map(cleanLogLine).join("\n")
}
