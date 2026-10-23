/**
 * Dónde corre un run y cómo se rescata (ADR-0010, aceptado). El daemon elige el
 * driver por `projects.vcs` y lee sus garantías; ninguna regla supone
 * aislamiento sin preguntarlo. Los drivers no publican eventos: devuelven lo
 * que pasó y el daemon lo emite en su unidad de trabajo.
 */
import type { RunRow, WorkItemRow } from "./store/repo.js"

export type WorkspaceKind = "git_worktree" | "direct_fs"

/** Lo que el scheduler y la UI pueden dar por cierto de un driver (ADR-0010 §4). */
export type WorkspaceGuarantees = {
  isolation: "worktree" | "none"
  rescue: "git_ref" | "snapshot"
  parallel: boolean
}

/** Un evento que el daemon emite tal cual, con el run como agregado. */
export type WorkspaceEvent = { kind: string; payload: unknown }

export type Provisioned =
  | { ok: true; cwd: string; events: WorkspaceEvent[] }
  | { ok: false; message: string }

export interface WorkspaceDriver {
  readonly kind: WorkspaceKind
  readonly guarantees: WorkspaceGuarantees
  /** Prepara el espacio del run. Un problema esperable es `ok: false`, no una excepción. */
  provision(run: RunRow, item: WorkItemRow): Promise<Provisioned>
  /** Cambios del run respecto a su punto de partida. Sin nada registrado, `[]`. */
  capture(runId: string): Promise<WorkspaceEvent[]>
  /** Libera lo del run, rescatando antes. Idempotente; sin nada registrado, `[]`. */
  release(runId: string): Promise<WorkspaceEvent[]>
}
