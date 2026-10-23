/**
 * Implementación del daemon de `RunContext` (adapters/provider.ts): los
 * eventos del proveedor se guardan en `events` con su fuente y versión de
 * adaptador y se publican en el bus; la proyección escribe por el `Repo`.
 */
import { isLive, REDACTION_RULES_VERSION, redact } from "@keel/core"
import type { RunContext, ToolGate } from "./adapters/provider.js"
import type { EventBus } from "./bus.js"
import { nowIso, ulid } from "./ids.js"
import type { Repo, RunRow } from "./store/repo.js"

export type RunContextDeps = {
  repo: Repo
  bus: EventBus
  run: RunRow
  gate: ToolGate
  /** `events.source` de lo que registra el adaptador, p. ej. `claude-sdk`. */
  source: string
  adapterVersion: string
}

export function createRunContext(deps: RunContextDeps): RunContext {
  const { repo, bus, run, source, adapterVersion } = deps
  const record = (
    kind: string,
    key: string,
    payload: unknown,
    occurredAt: string | null,
  ): string | null => {
    const e = repo.appendEvent({
      project_id: run.project_id,
      run_id: run.id,
      source,
      source_event_key: key,
      fidelity: "full",
      adapter_version: adapterVersion,
      kind,
      occurred_at: occurredAt,
      payload_json: JSON.stringify(payload),
    })
    if (e)
      bus.publish({
        event_seq: e.event_seq,
        kind: e.kind,
        project_id: e.project_id,
        run_id: e.run_id,
        received_at: e.received_at,
        payload,
      })
    return e?.id ?? null
  }
  const notifyRun = () => {
    const r = repo.getRun(run.id)
    if (r) record("run.updated", `run.updated:${run.id}:${ulid()}`, repo.runView(r), null)
  }
  const ctx: RunContext = {
    run,
    store: repo,
    decideTool: (req) => deps.gate.decide(ctx, req),
    record,
    ingest(kind, key, payload, occurredAt) {
      const { value, hits } = redact(payload)
      const id = record(kind, key, value, occurredAt)
      // Dónde y con qué regla, nunca el valor (best-effort, reglas versionadas).
      if (id && hits.length > 0)
        record(
          "ingest.redacted",
          `redacted:${id}`,
          { event_id: id, rules_version: REDACTION_RULES_VERSION, hits },
          null,
        )
      return { id, payload: value }
    },
    notifyRun,
    fail(message, kind = "run.failed") {
      const current = repo.getRun(run.id) ?? run
      if (!isLive(current.status)) return current
      const t = nowIso()
      const r = repo.updateRun(run.id, {
        status: "failed",
        end_reason: "fatal_error",
        started_at: current.started_at ?? t,
        ended_at: t,
      })
      record(kind, `${kind}:${run.id}:${ulid()}`, { message }, null)
      notifyRun()
      return r
    },
  }
  return ctx
}
