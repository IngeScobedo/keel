/**
 * Terraform por el broker (ADR-0013) con salida para máquinas: `plan -json` y
 * `apply -json` en stream (cada recurso llega en vivo), `show -json` para el árbol de
 * cambios. Sin bloquear el daemon: un plan o un apply pueden tardar minutos.
 *
 * `show -json` trae los valores sensibles en claro aunque los marque en
 * `after_sensitive` (medido con Terraform 1.9): la tarjeta sólo lleva atributos que no
 * son sensibles, y todo pasa además por la redacción del broker.
 */
import { spawn } from "node:child_process"

export type TfAction = "create" | "update" | "delete" | "replace" | "read" | "no-op"

export type TfResource = {
  address: string
  action: TfAction
  /** Atributos que cambian y no son sensibles; los valores, recortados. */
  attrs: { key: string; before: string | null; after: string | null }[]
  sensitive_changed: number
}

export type TfDetails = {
  tool: "terraform"
  mode: "plan" | "apply"
  counts: { add: number; change: number; remove: number; replace: number }
  resources: TfResource[]
  /** Lo que borra o reemplaza: la tarjeta lo marca en rojo. */
  destructive: string[]
  outputs: Record<string, string>
  errors: string[]
  duration_ms: number
}

/** Un evento en vivo para la tarjeta: un recurso planeado o en curso. */
export type TfLive = {
  address: string
  action: TfAction
  status: "planned" | "started" | "progress" | "complete" | "errored"
  elapsed: number | null
  message: string | null
}

export class TerraformError extends Error {}

/** Corre terraform sin bloquear; con `onJson`, cada línea JSON se entrega al llegar. */
export function terraform(
  bin: string,
  dir: string,
  args: string[],
  env: Record<string, string>,
  onJson?: (msg: Record<string, unknown>) => void,
  timeoutMs = 10 * 60_000,
): Promise<{ status: number | null; out: string }> {
  return new Promise((done, fail) => {
    const child = spawn(bin, [`-chdir=${dir}`, ...args], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    })
    let out = ""
    let rest = ""
    child.stdout.on("data", (d: Buffer) => {
      const s = d.toString("utf8")
      if (out.length < 8_000_000) out += s
      if (!onJson) return
      const lines = (rest + s).split("\n")
      rest = lines.pop() ?? ""
      for (const l of lines) {
        if (!l.startsWith("{")) continue
        try {
          onJson(JSON.parse(l) as Record<string, unknown>)
        } catch {
          // Una línea que no es JSON no corta el stream.
        }
      }
    })
    child.stderr.on("data", (d: Buffer) => {
      if (out.length < 8_000_000) out += d.toString("utf8")
    })
    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs)
    child.on("error", (e) => {
      clearTimeout(timer)
      fail(new TerraformError(`terraform no disponible: ${e.message}`))
    })
    child.on("close", (c) => {
      clearTimeout(timer)
      done({ status: c, out })
    })
  })
}

type Hook = { resource?: { addr?: string }; action?: string; elapsed_seconds?: number }

/** De una línea de `plan -json` o `apply -json` a un evento de la tarjeta. */
export function liveEvent(msg: Record<string, unknown>): TfLive | null {
  const type = String(msg.type ?? "")
  if (type === "planned_change") {
    const c = msg.change as { resource?: { addr?: string }; action?: string } | undefined
    if (!c?.resource?.addr) return null
    return {
      address: c.resource.addr,
      action: normalize(c.action),
      status: "planned",
      elapsed: null,
      message: null,
    }
  }
  const status = (
    {
      apply_start: "started",
      apply_progress: "progress",
      apply_complete: "complete",
      apply_errored: "errored",
    } as const
  )[type as "apply_start"]
  if (!status) return null
  const hook = (msg.hook ?? {}) as Hook
  if (!hook.resource?.addr) return null
  return {
    address: hook.resource.addr,
    action: normalize(hook.action),
    status,
    elapsed: typeof hook.elapsed_seconds === "number" ? hook.elapsed_seconds : null,
    message: type === "apply_errored" ? String(msg["@message"] ?? "") : null,
  }
}

function normalize(a: string | undefined): TfAction {
  if (a === "create" || a === "update" || a === "delete" || a === "replace" || a === "read")
    return a
  return "no-op"
}

/** `["delete","create"]` y similares de `show -json`, en una acción. */
function actionOf(actions: string[]): TfAction {
  if (actions.includes("delete") && actions.includes("create")) return "replace"
  return normalize(actions[0])
}

const short = (v: unknown): string | null => {
  if (v === null || v === undefined) return null
  const s = typeof v === "string" ? v : JSON.stringify(v)
  return s.length > 120 ? `${s.slice(0, 117)}…` : s
}

/** El árbol de cambios de `show -json`, sin valores sensibles. */
export function changesFromShow(show: {
  resource_changes?: {
    address: string
    change: {
      actions: string[]
      before?: Record<string, unknown> | null
      after?: Record<string, unknown> | null
      before_sensitive?: unknown
      after_sensitive?: unknown
    }
  }[]
}): TfResource[] {
  const out: TfResource[] = []
  for (const rc of show.resource_changes ?? []) {
    const action = actionOf(rc.change.actions)
    if (action === "no-op" || action === "read") continue
    const before = rc.change.before ?? {}
    const after = rc.change.after ?? {}
    const sensitive = new Set<string>()
    for (const s of [rc.change.before_sensitive, rc.change.after_sensitive])
      if (s && typeof s === "object")
        for (const [k, v] of Object.entries(s as Record<string, unknown>))
          if (v === true || (v && typeof v === "object")) sensitive.add(k)
    const attrs: TfResource["attrs"] = []
    let sensitiveChanged = 0
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
      const b = before[key]
      const a = after[key]
      if (JSON.stringify(b) === JSON.stringify(a)) continue
      if (sensitive.has(key)) {
        sensitiveChanged++
        continue
      }
      attrs.push({ key, before: short(b), after: short(a) })
    }
    out.push({
      address: rc.address,
      action,
      attrs: attrs.slice(0, 12),
      sensitive_changed: sensitiveChanged,
    })
  }
  return out
}

export function countsOf(resources: TfResource[]): TfDetails["counts"] {
  const c = { add: 0, change: 0, remove: 0, replace: 0 }
  for (const r of resources)
    if (r.action === "create") c.add++
    else if (r.action === "update") c.change++
    else if (r.action === "delete") c.remove++
    else if (r.action === "replace") c.replace++
  return c
}

/** El resumen corto: lo que lee el agente y la cabecera de la tarjeta. */
export function planSummary(c: TfDetails["counts"]): string {
  const parts = [
    c.add && `+${c.add} crear`,
    c.change && `~${c.change} cambiar`,
    c.replace && `±${c.replace} reemplazar`,
    c.remove && `-${c.remove} destruir`,
  ].filter(Boolean)
  return parts.length ? `Plan: ${parts.join(", ")}` : "Sin cambios"
}

/** Las salidas no sensibles de `apply -json` (mensaje `outputs`). */
export function outputsOf(msg: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {}
  const o = (msg.outputs ?? {}) as Record<string, { sensitive?: boolean; value?: unknown }>
  for (const [k, v] of Object.entries(o))
    out[k] = v.sensitive ? "(sensible)" : (short(v.value) ?? "")
  return out
}
