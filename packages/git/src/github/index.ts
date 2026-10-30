/**
 * @keel/git/github — GitHub como integración de primer nivel (ADR-0043 §1), sobre el
 * `gh` del humano: su sesión, el repo, las PRs con su merge y los runs de Actions con
 * sus pasos. El núcleo de `@keel/git` no importa este módulo (ADR-0015).
 *
 * Contrato: lee y opera con lo que `gh` ya puede; no guarda nada ni emite eventos.
 */
import { z } from "zod"
import { GhError, type GhOptions, gh, ghJson } from "./gh.js"

export { GhError, type GhErrorKind, type GhOptions, gh, ghJson } from "./gh.js"

// --- la sesión ----------------------------------------------------------------------

const AuthHostSchema = z.object({
  state: z.string(),
  active: z.boolean(),
  host: z.string(),
  login: z.string().optional(),
  scopes: z.string().optional(),
  gitProtocol: z.string().optional(),
  error: z.string().optional(),
})

export type GhAccount = {
  host: string
  login: string | null
  active: boolean
  ok: boolean
  scopes: string[]
  git_protocol: string | null
  error: string | null
}

export type GhStatus = {
  installed: boolean
  version: string | null
  accounts: GhAccount[]
  /** Hay una cuenta activa con sesión válida en github.com. */
  ready: boolean
}

/**
 * Si `gh` está y con qué cuenta. Nunca pide el token: `gh auth status --json hosts`
 * no lo incluye sin `--show-token`, y la ruta de su almacén se descarta.
 */
export async function ghStatus(opts: Partial<GhOptions> = {}): Promise<GhStatus> {
  const o = { cwd: opts.cwd ?? process.cwd(), ...opts }
  let version: string | null
  try {
    version = /gh version (\S+)/.exec(await gh(["--version"], o))?.[1] ?? null
  } catch (e) {
    if (e instanceof GhError && e.kind === "missing")
      return { installed: false, version: null, accounts: [], ready: false }
    throw e
  }
  let hosts: Record<string, z.infer<typeof AuthHostSchema>[]> = {}
  try {
    hosts = (
      await ghJson(
        z.object({ hosts: z.record(z.string(), z.array(AuthHostSchema)) }),
        ["auth", "status", "--json", "hosts"],
        o,
      )
    ).hosts
  } catch (e) {
    // Sin ninguna sesión `gh` sale con error y sin JSON: no hay cuentas.
    if (!(e instanceof GhError)) throw e
  }
  const accounts = Object.values(hosts)
    .flat()
    .map((h) => ({
      host: h.host,
      login: h.login ?? null,
      active: h.active,
      ok: h.state === "success",
      scopes: (h.scopes ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
      git_protocol: h.gitProtocol ?? null,
      error: h.error ?? null,
    }))
  return {
    installed: true,
    version,
    accounts,
    ready: accounts.some((a) => a.host === "github.com" && a.active && a.ok),
  }
}

// --- el repo ------------------------------------------------------------------------

export const RepoSettingsSchema = z.object({
  nameWithOwner: z.string(),
  url: z.string(),
  defaultBranchRef: z.object({ name: z.string() }).nullable(),
  mergeCommitAllowed: z.boolean(),
  squashMergeAllowed: z.boolean(),
  rebaseMergeAllowed: z.boolean(),
  deleteBranchOnMerge: z.boolean(),
})
export type RepoSettings = z.infer<typeof RepoSettingsSchema>

export function repoSettings(opts: GhOptions): Promise<RepoSettings> {
  return ghJson(
    RepoSettingsSchema,
    [
      "repo",
      "view",
      "--json",
      "nameWithOwner,url,defaultBranchRef,mergeCommitAllowed,squashMergeAllowed,rebaseMergeAllowed,deleteBranchOnMerge",
    ],
    opts,
  )
}

// --- las PRs --------------------------------------------------------------------------

const CheckSchema = z.object({
  __typename: z.string().optional(),
  name: z.string().optional(),
  context: z.string().optional(),
  workflowName: z.string().optional(),
  status: z.string().optional(),
  conclusion: z.string().nullable().optional(),
  state: z.string().optional(),
  startedAt: z.string().nullable().optional(),
  completedAt: z.string().nullable().optional(),
  detailsUrl: z.string().nullable().optional(),
  targetUrl: z.string().nullable().optional(),
})

export const PullRequestSchema = z.object({
  number: z.number().int(),
  title: z.string(),
  url: z.string(),
  state: z.enum(["OPEN", "CLOSED", "MERGED"]),
  isDraft: z.boolean(),
  baseRefName: z.string(),
  headRefName: z.string(),
  headRefOid: z.string(),
  mergeable: z.string(),
  mergeStateStatus: z.string(),
  reviewDecision: z.string().nullable(),
  additions: z.number().int(),
  deletions: z.number().int(),
  author: z.object({ login: z.string() }).nullable(),
  mergedAt: z.string().nullable(),
  mergedBy: z.object({ login: z.string() }).nullable(),
  body: z.string(),
  statusCheckRollup: z.array(CheckSchema).nullable(),
  files: z
    .array(
      z.object({
        path: z.string(),
        additions: z.number().int(),
        deletions: z.number().int(),
      }),
    )
    .nullable(),
})
export type PullRequest = z.infer<typeof PullRequestSchema>

const PR_FIELDS =
  "number,title,url,state,isDraft,baseRefName,headRefName,headRefOid,mergeable,mergeStateStatus,reviewDecision,additions,deletions,author,mergedAt,mergedBy,body,statusCheckRollup,files"

/** Una PR por número, URL o rama. */
export function pullRequest(opts: GhOptions, ref: number | string): Promise<PullRequest> {
  return ghJson(PullRequestSchema, ["pr", "view", String(ref), "--json", PR_FIELDS], opts)
}

export function pullRequests(
  opts: GhOptions,
  q: { state?: "open" | "closed" | "merged" | "all"; base?: string; head?: string; limit?: number } = {},
): Promise<PullRequest[]> {
  return ghJson(
    z.array(PullRequestSchema),
    [
      "pr",
      "list",
      "--state",
      q.state ?? "open",
      "--limit",
      String(q.limit ?? 30),
      ...(q.base ? ["--base", q.base] : []),
      ...(q.head ? ["--head", q.head] : []),
      "--json",
      PR_FIELDS,
    ],
    opts,
  )
}

export type MergeMethod = "merge" | "squash" | "rebase"

/**
 * Mergea atado a la cabeza que vio el humano: si alguien empujó después, GitHub lo
 * rechaza (`rejected`). Borrar la rama se hace en el remoto por la API; `gh pr merge
 * --delete-branch` tocaría además el checkout local.
 */
export async function mergePullRequest(
  opts: GhOptions,
  number: number,
  m: {
    method: MergeMethod
    headSha: string
    subject?: string
    body?: string
    deleteBranch?: string | null
  },
): Promise<void> {
  await gh(
    [
      "pr",
      "merge",
      String(number),
      `--${m.method}`,
      "--match-head-commit",
      m.headSha,
      ...(m.subject !== undefined && m.method !== "rebase" ? ["--subject", m.subject] : []),
      ...(m.body !== undefined && m.method !== "rebase" ? ["--body", m.body] : []),
    ],
    opts,
  )
  if (m.deleteBranch)
    await gh(
      [
        "api",
        "-X",
        "DELETE",
        `repos/{owner}/{repo}/git/refs/heads/${encodeURIComponent(m.deleteBranch).replace(/%2F/g, "/")}`,
      ],
      opts,
    ).catch(() => {
      // La rama ya no estaba o el repo la borra solo al mergear: el merge es lo que cuenta.
    })
}

export async function closePullRequest(opts: GhOptions, number: number): Promise<void> {
  await gh(["pr", "close", String(number)], opts)
}

// --- Actions -------------------------------------------------------------------------

export const WorkflowRunSchema = z.object({
  databaseId: z.number().int(),
  workflowName: z.string(),
  displayTitle: z.string().optional(),
  status: z.string(),
  conclusion: z.string().nullable(),
  event: z.string(),
  headBranch: z.string(),
  headSha: z.string(),
  url: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  attempt: z.number().int().optional(),
})
export type WorkflowRun = z.infer<typeof WorkflowRunSchema>

const RUN_FIELDS =
  "databaseId,workflowName,displayTitle,status,conclusion,event,headBranch,headSha,url,createdAt,updatedAt,attempt"

export function workflowRuns(
  opts: GhOptions,
  q: { commit?: string; branch?: string; workflow?: string; limit?: number } = {},
): Promise<WorkflowRun[]> {
  return ghJson(
    z.array(WorkflowRunSchema),
    [
      "run",
      "list",
      "--limit",
      String(q.limit ?? 20),
      ...(q.commit ? ["--commit", q.commit] : []),
      ...(q.branch ? ["--branch", q.branch] : []),
      ...(q.workflow ? ["--workflow", q.workflow] : []),
      "--json",
      RUN_FIELDS,
    ],
    opts,
  )
}

const StepSchema = z.object({
  name: z.string(),
  number: z.number().int().optional(),
  status: z.string(),
  conclusion: z.string().nullable(),
  startedAt: z.string().nullable().optional(),
  completedAt: z.string().nullable().optional(),
})
const JobSchema = z.object({
  databaseId: z.number().int().optional(),
  name: z.string(),
  status: z.string(),
  conclusion: z.string().nullable(),
  startedAt: z.string().nullable().optional(),
  completedAt: z.string().nullable().optional(),
  url: z.string().optional(),
  steps: z.array(StepSchema),
})
export const RunDetailSchema = WorkflowRunSchema.extend({ jobs: z.array(JobSchema) })
export type RunDetail = z.infer<typeof RunDetailSchema>

/** Un run con sus jobs y pasos: el avance paso a paso (los logs llegan al terminar). */
export function workflowRun(opts: GhOptions, id: number): Promise<RunDetail> {
  return ghJson(RunDetailSchema, ["run", "view", String(id), "--json", `${RUN_FIELDS},jobs`], opts)
}

/** Las últimas líneas del log de los pasos fallidos. */
export async function failedLogTail(opts: GhOptions, id: number, lines = 60): Promise<string> {
  const out = await gh(["run", "view", String(id), "--log-failed"], opts)
  // Cada línea viene como «job\tpaso\tfecha mensaje»: queda el mensaje.
  return out
    .split("\n")
    .map((l) => l.split("\t").slice(2).join("\t").replace(/^\S+Z\s/, ""))
    .filter((l) => l.trim())
    .slice(-lines)
    .join("\n")
}

export async function rerunWorkflow(
  opts: GhOptions,
  id: number,
  q: { failedOnly?: boolean } = {},
): Promise<void> {
  await gh(["run", "rerun", String(id), ...(q.failedOnly ? ["--failed"] : [])], opts)
}
