/**
 * Piezas del flujo de una tarea (ADR-0021) que no tocan el store: vistas,
 * contexto de validación, instrucciones por etapa y las reglas `allow` del
 * harness del proyecto. La orquestación vive en el daemon.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import {
  type Ceremony,
  type DocReport,
  isReadOnlyStage,
  matchesPattern,
  type PermissionPattern,
  type ProjectProfile,
  type Stage,
  shellCommand,
  type TaskDocKind,
  type TaskDocView,
  type TaskFlowView,
  type ValidationContext,
  type VerifyResult,
} from "@keel/core"
import type { TaskDocRow, TaskFlowRow, WorkItemRow } from "./store/repo.js"

export function flowView(
  f: TaskFlowRow,
  pendingGate: TaskFlowView["pending_gate"] = null,
  gitPlan: TaskFlowView["git_plan"] = null,
): TaskFlowView {
  return {
    work_item_id: f.work_item_id,
    stage: f.stage,
    ceremony: f.ceremony,
    ceremony_reason: f.ceremony_reason,
    contract_sha256: f.contract_sha256,
    baseline: f.baseline_json ? (JSON.parse(f.baseline_json) as VerifyResult[]) : null,
    started_by: f.started_by,
    updated_at: f.updated_at,
    pending_gate: pendingGate,
    git_plan: gitPlan,
  }
}

export function docView(d: TaskDocRow, report: DocReport, content?: string): TaskDocView {
  return {
    id: d.id,
    work_item_id: d.work_item_id,
    kind: d.kind,
    version: d.version,
    sha256: d.sha256,
    size: d.size,
    author: d.author,
    created_at: d.created_at,
    report,
    ...(content === undefined ? {} : { content_markdown: content }),
  }
}

export function validationContext(p: ProjectProfile | null): ValidationContext {
  return {
    invariants: p?.invariants ?? [],
    ...(p?.adr_pattern ? { adr: p.adr_pattern } : {}),
  }
}

/** Para qué es cada etapa, en una línea que el agente lee en cada turno. */
const STAGE_GOAL: Record<Stage, string> = {
  brief:
    "aclara el pedido con grilling (una pregunta a la vez, con tu recomendación; lee el repo antes de preguntar) y guarda el brief con task_doc_put. Al cerrarlo declara la ceremonia: direct si es trabajo directo, formal si toca un contrato o invariante, paraleliza dos responsables o es un módulo grande sin SDD",
  design:
    "escribe la spec (requisitos con escenarios Dado/Cuando/Entonces) y el diseño (contrato congelado y fronteras de archivos disjuntas); si es una decisión de arquitectura, prepárala como ADR o SDD del proyecto",
  implement:
    "implementa contra el contrato en tu worktree; corre verify_run para ver el delta contra el baseline sin leer salidas enteras",
  review:
    "revisa de forma adversarial sólo correctness, el contrato y las convenciones; escribe el QA con su veredicto (PASS, CONCERNS, FAIL o WAIVED justificado). FAIL vuelve a implement",
  close:
    "prepara el cierre: lleva lo durable al canon del proyecto (ADR, SDD, roadmap) en tu worktree y propón el commit con git_propose; el humano aprueba el plan",
}

/** Las líneas de método que Keel añade al encabezado del prompt (ADR-0017 §1). */
export function stageInstructions(f: TaskFlowRow, profile: ProjectProfile | null): string {
  const lines = [
    `[Keel · método] Etapa ${f.stage}${f.ceremony ? ` · ceremonia ${f.ceremony}` : ""}${isReadOnlyStage(f.stage) ? " · sólo lectura: no edites ni corras comandos que cambien algo. Las tools de Keel (task_doc_put, stage_advance, verify_run) sí funcionan en modo plan: no tocan el repo" : ""}.`,
    `Objetivo: ${STAGE_GOAL[f.stage]}.`,
    "Avanza con la tool stage_advance (Keel valida la transición y los documentos y te dice qué falta); no uses ExitPlanMode. Los documentos de la tarea (brief, spec, design, tasks, story, qa) se leen y guardan con task_doc_get y task_doc_put; no los escribas en el repo.",
  ]
  if (profile?.verify.length)
    lines.push(
      `La verificación del proyecto (${profile.verify.map((v) => v.name).join(", ")}) la corre Keel con verify_run.`,
    )
  return lines.join(" ")
}

/** Lo que Keel le dice al agente que sigue vivo cuando su tarea cambia de etapa. */
export function stageMessage(stage: Stage, ceremony: Ceremony | null): string {
  return `[Keel · método] La tarea está ahora en la etapa ${stage}${ceremony ? ` (${ceremony})` : ""}${isReadOnlyStage(stage) ? "; es de sólo lectura para el repo, pero task_doc_put, stage_advance y verify_run de Keel sí funcionan" : ""}. Objetivo: ${STAGE_GOAL[stage]}.`
}

/** El mensaje con el que Keel retoma la conversación en otra etapa. */
export function continuationPrompt(
  item: WorkItemRow,
  stage: Stage,
  why: string,
  ceremony: Ceremony | null,
): string {
  return `${why} La tarea ${item.display_id} sigue en la etapa ${stage}${ceremony ? ` (${ceremony})` : ""}. Continúa desde donde quedó la conversación.`
}

/** La primera instrucción cuando el humano pide trabajar una tarea sin escribir nada. */
export function workPrompt(item: WorkItemRow, stage: Stage): string {
  return stage === "brief"
    ? `Trabaja la tarea ${item.display_id}: «${item.title}». Empieza por el brief.`
    : `Sigue con la tarea ${item.display_id} en la etapa ${stage}.`
}

/**
 * Las reglas `permissions.allow` del harness del proyecto. Claude Code las
 * aplica antes de `canUseTool`; Keel devuelve `ask` en su hook `PreToolUse`
 * para lo que casen, así ninguna se salta el gate (spike del 2026-10-26).
 */
export function projectAllowRules(cwd: string): PermissionPattern[] {
  const rules: string[] = []
  for (const file of ["settings.json", "settings.local.json"]) {
    try {
      const s = JSON.parse(readFileSync(join(cwd, ".claude", file), "utf8")) as {
        permissions?: { allow?: unknown }
      }
      if (Array.isArray(s.permissions?.allow))
        rules.push(...s.permissions.allow.filter((r): r is string => typeof r === "string"))
    } catch {
      // Sin archivo o JSON roto: no hay reglas que neutralizar.
    }
  }
  return rules.map(parseClaudeRule)
}

/** `Bash(git status:*)` → prefijo; `Bash(ls)` → exacto; `Edit` o `Read(src/**)` → la herramienta entera. */
function parseClaudeRule(rule: string): PermissionPattern {
  const m = /^([^(]+)\((.*)\)$/.exec(rule.trim())
  if (!m) return { tool: rule.trim(), prefix: null, exact: false }
  const tool = (m[1] as string).trim()
  const arg = (m[2] as string).trim()
  if (tool !== "Bash") return { tool, prefix: null, exact: false }
  if (arg.endsWith(":*")) return { tool, prefix: arg.slice(0, -2).trim(), exact: false }
  if (arg.endsWith(" *")) return { tool, prefix: arg.slice(0, -2).trim(), exact: false }
  return { tool, prefix: arg, exact: true }
}

/** ¿Una regla del proyecto auto-aprobaría esta herramienta? Entonces Keel la devuelve al gate. */
export function projectWouldAllow(
  rules: readonly PermissionPattern[],
  tool: string,
  input: unknown,
): boolean {
  const cmd = shellCommand(input)
  // Claude Code evalúa cada parte de una orden encadenada: aquí también, y de más.
  const segments =
    cmd === null
      ? []
      : cmd
          .split(/&&|\|\||;|\||\n/)
          .map((c) => c.trim())
          .filter(Boolean)
  return rules.some((r) => {
    if (r.prefix === null) return r.tool === tool || tool.startsWith(`${r.tool}__`)
    if (r.tool !== tool) return false
    return (
      matchesPattern(r, tool, input) ||
      segments.some((c) =>
        r.exact ? c === r.prefix : c === r.prefix || c.startsWith(`${r.prefix} `),
      )
    )
  })
}

/** Los documentos que la transición exige, con su contenido, para validarlos juntos. */
export type DocSet = Partial<Record<TaskDocKind, string>>
