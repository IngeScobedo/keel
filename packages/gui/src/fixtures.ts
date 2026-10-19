import { type Lifecycle, type RunStatus, visualForRun, visualForWorkItem } from "@keel/core"
import {
  type BoardColumn,
  type Run,
  registerDemoRepo,
  type TaskDetails,
  type WorkItem,
} from "./model.js"

export const DEMO_PROJECT = "demo-keel-api"
const rows: [number, string, Lifecycle, BoardColumn, string, string, number, number][] = [
  [151, "Add OpenTelemetry spans to job runner", "triage", "backlog", "backend", "AM", 0, 0],
  [149, "Deprecate /v1/legacy-export endpoint", "triage", "backlog", "backend", "KL", 0, 0],
  [147, "Webhook retries duplicate deliveries on 5xx", "triage", "backlog", "backend", "JR", 0, 0],
  [146, "Bump pnpm to 9.12 in CI image", "triage", "backlog", "docs", "AM", 0, 0],
  [144, "Checkout summary: surface tax breakdown", "triage", "backlog", "frontend", "SP", 0, 0],
  [143, "Add rate-limit headers on public API", "triage", "todo", "backend", "AM", 0, 4],
  [140, "Index sessions(user_id, expires_at)", "planned", "todo", "backend", "AM", 0, 0],
  [
    139,
    "Collapse duplicated fetch wrappers in src/http",
    "planned",
    "todo",
    "frontend",
    "AM",
    0,
    0,
  ],
  [
    142,
    "Retry token refresh on 401 in auth client",
    "running",
    "in_progress",
    "frontend",
    "AM",
    3,
    7,
  ],
  [
    138,
    "Migrate sessions table to composite primary key",
    "running",
    "in_progress",
    "backend",
    "AM",
    5,
    9,
  ],
  [
    137,
    "Rotate S3 credentials for asset uploader",
    "waiting_human",
    "in_progress",
    "backend",
    "AM",
    2,
    3,
  ],
  [
    135,
    "Build checkout UI against the shared contract",
    "blocked",
    "in_progress",
    "frontend",
    "JR",
    1,
    6,
  ],
  [
    131,
    "Flaky e2e: checkout spec times out on CI",
    "needs_review",
    "in_review",
    "frontend",
    "JR",
    4,
    4,
  ],
  [
    130,
    "Stream job logs over SSE instead of polling",
    "needs_review",
    "in_review",
    "backend",
    "AM",
    6,
    6,
  ],
  [
    128,
    "Fix timezone drift in invoice due dates",
    "needs_review",
    "in_review",
    "backend",
    "KL",
    2,
    2,
  ],
  [126, "Add idempotency keys to payment intents", "done", "completed", "backend", "AM", 5, 5],
  [125, "Upgrade Prisma to 6.3", "done", "completed", "backend", "KL", 3, 3],
  [124, "Experiment: edge-cache product pages", "done", "completed", "frontend", "SP", 1, 4],
]

export const demoDetails: Record<string, TaskDetails> = {}
export const demoTasks: WorkItem[] = rows.map(
  ([number, title, lifecycle, board_status, repo, assignee, done, total]) => {
    const id = `demo-task-${number}`
    registerDemoRepo(id, repo)
    demoDetails[id] = {
      repo,
      assignee,
      labels: repo === "docs" ? ["infra"] : ["auth", repo],
      role: repo === "frontend" ? "fe-implement" : "be-implement",
      spec:
        number === 142
          ? "When the access token expires mid-request the client gets a 401 and surfaces it to the user instead of refreshing. Wrap refreshToken() with bounded retry (3 attempts, jittered backoff) and replay the original request once. Keep /oauth/token hits idempotent."
          : "Implement this change in an isolated worktree. Keep the public contract explicit, validate the affected paths and attach reproducible evidence before requesting human review.",
      steps: [done, total],
      ...(number === 135 ? { contract: { name: "checkout_api", version: 1, state: "draft" } } : {}),
    }
    return {
      id,
      project_id: DEMO_PROJECT,
      display_id: `KEEL-${number}`,
      title,
      lifecycle,
      board_status,
      visual_state: visualForWorkItem(
        lifecycle,
        number === 143 ? { status: "running", purpose: "plan" } : null,
      ),
      revision: 1,
    }
  },
)
const runRows: [string, number, RunStatus, number][] = [
  ["8f2c1a", 142, "running", 1_840_000],
  ["4eb092", 138, "running", 4_900_000],
  ["7a65b1", 138, "running", 1_220_000],
  ["3b9e07", 142, "failed", 920_000],
  ["c71d44", 142, "cancelled", 110_000],
  ["93cf11", 131, "completed", 3_120_000],
  ["dab893", 130, "completed", 4_770_000],
  ["c96287", 126, "completed", 2_310_000],
]
export const demoRuns: Run[] = runRows.map(([id, task, status, cost]) => ({
  id: `run_${id}`,
  work_item_id: `demo-task-${task}`,
  purpose: "execute",
  status,
  end_reason: status === "failed" ? "rate_limit" : null,
  cost_kind: "estimated",
  total_cost_micro_usd: cost,
  visual_state: visualForRun(status, "execute"),
  revision: 1,
}))

export const demoActivity = [
  {
    role: "implementer",
    actor: "agent_9b04d",
    text: "is editing src/auth/client.ts — wrapping refreshToken() in withRetry().",
    time: "now",
  },
  {
    role: "orchestrator",
    actor: "agent_7c21e",
    text: "found technical debt: duplicated fetch wrapper in src/http/fetch.ts. Proposed subtask KEEL-142.4.",
    time: "14:11",
  },
  {
    role: "tester",
    actor: "agent_c4e10",
    text: "attached evidence: vitest — 21 passed, 0 failed · src/auth (1.94s).",
    time: "14:09",
  },
  {
    role: "orchestrator",
    actor: "agent_7c21e",
    text: "changed status: Planning → Running. Plan revision 2 approved.",
    time: "14:05",
  },
  {
    role: "human",
    actor: "Alana M.",
    text: "Keep retries at 3 with jittered backoff; anything more hides real outages. Escalation to Opus for the planner is fine.",
    time: "14:04",
  },
  {
    role: "keeld",
    actor: "workspace",
    text: "spawned isolated worktree .keel/worktrees/KEEL-142-a9 on keel/KEEL-142-auth-retry (base 3e1d9c0).",
    time: "14:04",
  },
]
export const demoTools = [
  {
    id: "tool-1",
    name: "read_file",
    label: "Read src/auth/client.ts",
    state: "succeeded",
    wall: "0.2s",
    duration: "0.18s",
    input: '{"path":"src/auth/client.ts"}',
    output: "212 lines · token refresh handler located at line 41",
  },
  {
    id: "tool-2",
    name: "read_file",
    label: "Read src/auth/__tests__/client.test.ts",
    state: "succeeded",
    wall: "0.3s",
    duration: "0.25s",
    input: '{"path":"src/auth/__tests__/client.test.ts"}',
    output: "21 tests · refresh behavior and network failures",
  },
  {
    id: "tool-3",
    name: "grep",
    label: "Find callers of refreshToken()",
    state: "succeeded",
    wall: "0.4s",
    duration: "0.32s",
    input: '{"pattern":"refreshToken","path":"src/"}',
    output: "src/auth/client.ts:41 · src/http/interceptor.ts:28",
  },
  {
    id: "tool-4",
    name: "edit_file",
    label: "Add retry wrapper to auth client",
    state: "succeeded",
    wall: "1.8s",
    duration: "0.9s",
    input:
      '{"path":"src/auth/client.ts","range":[41,58],"replace":"return withRetry({ attempts: 3, backoff: jitter })"}',
    output: "Applied 1 hunk · +14 −3 · file now 212 lines",
  },
  {
    id: "tool-5",
    name: "write_file",
    label: "Create src/http/retry.ts with withRetry()",
    state: "succeeded",
    wall: "0.6s",
    duration: "0.48s",
    input: '{"path":"src/http/retry.ts"}',
    output: "Created bounded retry helper, 48 lines",
  },
  {
    id: "tool-6",
    name: "run_tests",
    label: "Run vitest src/auth",
    state: "failed",
    wall: "24.1s",
    duration: "22.4s",
    input: '{"command":"vitest run src/auth"}',
    output: "20 passed · 1 failed: jitter bounds assertion",
  },
  {
    id: "tool-7",
    name: "edit_file",
    label: "Fix jitter bounds assertion in client.test.ts",
    state: "succeeded",
    wall: "1.1s",
    duration: "0.86s",
    input: '{"path":"src/auth/__tests__/client.test.ts"}',
    output: "Updated upper bound for exponential backoff",
  },
  {
    id: "tool-8",
    name: "run_tests",
    label: "Run vitest src/auth (retry)",
    state: "succeeded",
    wall: "22.8s",
    duration: "21.2s",
    input: '{"command":"vitest run src/auth"}',
    output: "21 passed · 0 failed",
  },
]

export type Approval = {
  id: string
  title: string
  tool: string
  target: string
  task: string
  hash: string
  scope: string
  expiresAt: number
  operation: string | null
  state: "pending" | "approved" | "denied" | "expired"
  impact: string
}
export function makeDemoApprovals(): Approval[] {
  return [
    {
      id: "approval-terraform",
      title: "Apply terraform plan: add read replica for keel-prod",
      tool: "Terraform",
      target: "aws:terraform/prod",
      task: "KEEL-137",
      hash: "sha256:72d409bf",
      scope: "keel-prod · replica only",
      expiresAt: Date.now() + 42 * 60_000,
      operation:
        "Plan: 1 to add, 1 to change, 0 to destroy.\n  + aws_db_instance.keel_replica (db.r6g.large, eu-west-1b)\n  ~ aws_security_group.db_ingress (5432 from 10.0.3.0/24)",
      state: "pending",
      impact: "+1 read replica · ~1 security group · no downtime expected",
    },
    {
      id: "approval-sql",
      title: "Run migration 0042_sessions_composite_pk on keel-staging",
      tool: "Postgres",
      target: "postgres:keel-staging",
      task: "KEEL-138",
      hash: "sha256:94f71c00",
      scope: "schema public · table sessions",
      expiresAt: Date.now() + 14 * 60_000,
      operation:
        "BEGIN;\nALTER TABLE public.sessions DROP CONSTRAINT sessions_pkey;\nALTER TABLE public.sessions ADD PRIMARY KEY (user_id, session_id);\nCOMMIT;",
      state: "pending",
      impact: "2 tables · ~48,200 rows · exclusive lock during migration",
    },
    {
      id: "approval-bash",
      title: "Restart nginx on edge-01 after cert rotation",
      tool: "Bash",
      target: "ssh:edge-01",
      task: "KEEL-137",
      hash: "sha256:c3ff246e",
      scope: "service nginx · edge-01",
      expiresAt: Date.now() + 9 * 60_000,
      operation: "nginx -t && systemctl reload nginx",
      state: "pending",
      impact: "1 host · nginx · 3 upstreams",
    },
  ]
}

export const demoProfiles = [
  {
    name: "Frontend engineer",
    discipline: "React / UI",
    role: "Worker",
    version: 4,
    state: "Publicado",
    scope: "src/ui/**, tests/ui/**",
    description:
      "Implementa interfaces accesibles. Entrega código, pruebas y evidencia visual; no aprueba su propio trabajo.",
  },
  {
    name: "Backend engineer",
    discipline: "Rust / API",
    role: "Worker",
    version: 3,
    state: "Publicado",
    scope: "src/api/**, migrations/**",
    description:
      "Implementa endpoints y contratos versionados. Valida compatibilidad antes de desbloquear consumidores.",
  },
  {
    name: "Staff engineer",
    discipline: "arquitectura",
    role: "Reasoner",
    version: 6,
    state: "Publicado",
    scope: "docs/specs/**",
    description:
      "Analiza requisitos, justifica el plan y define fronteras disjuntas para cada worker.",
  },
  {
    name: "Product designer",
    discipline: "UX / visual",
    role: "Worker",
    version: 2,
    state: "Publicado",
    scope: "design/**",
    description: "Itera flujos y estados con evidencia visual ligada a la tarea.",
  },
  {
    name: "Security reviewer",
    discipline: "auditoría",
    role: "Reviewer",
    version: 5,
    state: "Publicado",
    scope: "read-only",
    description: "Auditoría adversarial, permisos mínimos y hallazgos con evidencia verificable.",
  },
  {
    name: "QA engineer",
    discipline: "pruebas / E2E",
    role: "Reviewer",
    version: 3,
    state: "Publicado",
    scope: "tests/**",
    description: "Verifica criterios de aceptación con pruebas independientes.",
  },
  {
    name: "Release integrator",
    discipline: "Git",
    role: "Integrator",
    version: 2,
    state: "Publicado",
    scope: "integration branch",
    description: "Integra diffs aprobados y valida el estado final de la rama.",
  },
  {
    name: "Orchestrator",
    discipline: "delegación",
    role: "Orchestrator",
    version: 7,
    state: "Publicado",
    scope: "plan only",
    description: "Coordina lanes, dependencias y gates sin reemplazar la revisión humana.",
  },
]
export const demoDiff = `diff --git a/src/auth/client.ts b/src/auth/client.ts
--- a/src/auth/client.ts
+++ b/src/auth/client.ts
@@ -41,6 +41,12 @@ async function refreshToken() {
-  const response = await fetch('/oauth/token', options)
+  const response = await withRetry(
+    () => fetch('/oauth/token', options),
+    { attempts: 3, backoff: jitter }
+  )
   return response.json()
 }`
