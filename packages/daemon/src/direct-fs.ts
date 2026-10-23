/**
 * `DirectFsDriver` (ADR-0010 §1): el agente trabaja en la carpeta real, sin
 * copia, porque ése es el caso de uso (dotfiles, scratchpads, scripts del
 * sistema).
 *
 * - **Rescate:** antes de lanzar el proveedor, un snapshot de la carpeta en
 *   `<snapshotsDir>/<run>/`: `files.tar` más `manifest.json` con el hash de cada
 *   archivo. `restoreSnapshot` lo devuelve a su sitio.
 * - **Un escritor por carpeta:** el snapshot sin `released_at` es el candado
 *   (índice único por `root_path`, migración 0002); no hay paralelismo.
 * - **Sin diff de git:** la captura compara los hashes del manifest con el
 *   estado final.
 * - **Sólo con confirmación humana** del modo sin VCS (`projects.set_vcs`).
 *
 * Las carpetas vacías no entran al snapshot y los enlaces simbólicos se guardan
 * como enlaces, sin seguirlos.
 */
import { spawn } from "node:child_process"
import { realpathSync } from "node:fs"
import { lstat, mkdir, readdir, readFile, readlink, rm, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join, parse, relative, sep } from "node:path"
import { defaultStateDir } from "./state-dir.js"
import type { Repo, RunRow, RunSnapshotRow, WorkItemRow } from "./store/repo.js"
import type {
  Provisioned,
  WorkspaceDriver,
  WorkspaceEvent,
  WorkspaceGuarantees,
} from "./workspace-driver.js"

/** Topes por defecto del snapshot; pasarlos es un fallo explícito, no un snapshot parcial. */
export const DEFAULT_SNAPSHOT_LIMITS = { max_files: 50_000, max_bytes: 512 * 1024 * 1024 }

export type ManifestEntry =
  | { path: string; type: "file"; size: number; sha256: string; mode: number }
  | { path: string; type: "symlink"; target: string }

export type SnapshotManifest = {
  version: 1
  root: string
  created_at: string
  files: ManifestEntry[]
}

export type FsChanges = { added: string[]; modified: string[]; deleted: string[] }

export type DirectFsDeps = {
  repo: Repo
  /** Carpeta del proyecto (ADR-0019 §2). */
  rootOf: (projectId: string) => string
  snapshotsDir: string
  limits?: Partial<typeof DEFAULT_SNAPSHOT_LIMITS>
}

export function defaultSnapshotsDir(
  platform: NodeJS.Platform = process.platform,
  env: Record<string, string | undefined> = process.env,
): string {
  return join(defaultStateDir(platform, env), "snapshots")
}

export class DirectFsDriver implements WorkspaceDriver {
  readonly kind = "direct_fs"
  readonly guarantees: WorkspaceGuarantees = {
    isolation: "none",
    rescue: "snapshot",
    parallel: false,
  }
  private readonly deps: DirectFsDeps
  private readonly limits: typeof DEFAULT_SNAPSHOT_LIMITS
  constructor(deps: DirectFsDeps) {
    this.deps = deps
    this.limits = { ...DEFAULT_SNAPSHOT_LIMITS, ...deps.limits }
  }

  async provision(run: RunRow, _item: WorkItemRow): Promise<Provisioned> {
    const { repo, snapshotsDir } = this.deps
    const rootPath = this.deps.rootOf(run.project_id)
    if (run.purpose !== "execute") return { ok: true, cwd: rootPath, events: [] }
    const vcs = repo.getProjectVcs(run.project_id)
    if (vcs.vcs !== "none" || !vcs.vcs_none_confirmed_at)
      return {
        ok: false,
        message:
          "el modo sin control de versiones necesita la confirmación del humano (projects.set_vcs con vcs = none)",
      }
    const root = realpathSync.native(rootPath)
    const refused = refusedRoot(root)
    if (refused) return { ok: false, message: refused }
    const holder = repo.activeSnapshotForRoot(root)
    if (holder && holder.run_id !== run.id)
      return { ok: false, message: `la carpeta ${root} ya la está usando el run ${holder.run_id}` }

    const walked = await walk(root, this.limits)
    if (!walked.ok) return walked
    const manifest: SnapshotManifest = {
      version: 1,
      root,
      created_at: new Date().toISOString(),
      files: walked.files,
    }
    const dir = join(snapshotsDir, run.id)
    await mkdir(dir, { recursive: true })
    const manifestJson = JSON.stringify(manifest, null, 2)
    await writeFile(join(dir, "manifest.json"), manifestJson)
    await writeFile(join(dir, "files.list"), manifest.files.map((f) => `${f.path}\0`).join(""))
    await tar(["-cf", join(dir, "files.tar"), "-C", root, "--null", "-T", join(dir, "files.list")])
    const totalBytes = manifest.files.reduce((n, f) => n + (f.type === "file" ? f.size : 0), 0)
    let row: RunSnapshotRow
    try {
      row = repo.addRunSnapshot({
        project_id: run.project_id,
        run_id: run.id,
        root_path: root,
        snapshot_dir: dir,
        manifest_sha256: sha256(manifestJson),
        file_count: manifest.files.length,
        total_bytes: totalBytes,
      })
    } catch (e) {
      // Otro run tomó la carpeta entre la comprobación y el registro.
      await rm(dir, { recursive: true, force: true })
      const now = repo.activeSnapshotForRoot(root)
      if (now)
        return { ok: false, message: `la carpeta ${root} ya la está usando el run ${now.run_id}` }
      throw e
    }
    return {
      ok: true,
      cwd: root,
      events: [
        {
          kind: "workspace.snapshot_created",
          payload: {
            snapshot_id: row.id,
            root,
            snapshot_dir: dir,
            file_count: row.file_count,
            total_bytes: row.total_bytes,
          },
        },
      ],
    }
  }

  async capture(runId: string): Promise<WorkspaceEvent[]> {
    const row = this.deps.repo.runSnapshot(runId)
    if (!row) return []
    const changes = await this.changes(row)
    return [
      {
        kind: "workspace.changes",
        payload: { snapshot_id: row.id, root: row.root_path, ...changes },
      },
    ]
  }

  async release(runId: string): Promise<WorkspaceEvent[]> {
    const row = this.deps.repo.runSnapshot(runId)
    if (!row || row.released_at) return []
    this.deps.repo.releaseSnapshot(row.id)
    // El snapshot se conserva para restaurar; liberar sólo suelta la carpeta.
    return [
      {
        kind: "workspace.released",
        payload: { snapshot_id: row.id, root: row.root_path, snapshot_dir: row.snapshot_dir },
      },
    ]
  }

  /**
   * Devuelve la carpeta al estado del snapshot. Sólo con el run ya liberado
   * (nadie escribiendo). Los archivos creados después se informan y se borran
   * sólo si `deleteNew`.
   */
  async restore(
    runId: string,
    opts: { deleteNew?: boolean } = {},
  ): Promise<{ restored: number; deleted: string[]; kept_new: string[] }> {
    const row = this.deps.repo.runSnapshot(runId)
    if (!row) throw new Error(`el run ${runId} no tiene snapshot`)
    if (!row.released_at)
      throw new Error(`el run ${runId} sigue usando la carpeta; espera a que termine`)
    const holder = this.deps.repo.activeSnapshotForRoot(row.root_path)
    if (holder)
      throw new Error(`la carpeta ${row.root_path} la está usando el run ${holder.run_id}`)
    const { added } = await this.changes(row)
    await tar(["-xf", join(row.snapshot_dir, "files.tar"), "-C", row.root_path])
    const deleted: string[] = []
    if (opts.deleteNew)
      for (const path of added) {
        await rm(join(row.root_path, ...path.split("/")), { force: true })
        deleted.push(path)
      }
    this.deps.repo.markSnapshotRestored(row.id)
    return { restored: row.file_count, deleted, kept_new: opts.deleteNew ? [] : added }
  }

  private async changes(row: RunSnapshotRow): Promise<FsChanges> {
    const manifest = JSON.parse(
      await readFile(join(row.snapshot_dir, "manifest.json"), "utf8"),
    ) as SnapshotManifest
    const now = await walk(row.root_path, { max_files: Infinity, max_bytes: Infinity })
    if (!now.ok) throw new Error(now.message)
    const before = new Map(manifest.files.map((f) => [f.path, f]))
    const after = new Map(now.files.map((f) => [f.path, f]))
    const out: FsChanges = { added: [], modified: [], deleted: [] }
    for (const [path, f] of after) {
      const old = before.get(path)
      if (!old) out.added.push(path)
      else if (!sameEntry(old, f)) out.modified.push(path)
    }
    for (const path of before.keys()) if (!after.has(path)) out.deleted.push(path)
    return out
  }
}

function sameEntry(a: ManifestEntry, b: ManifestEntry): boolean {
  if (a.type === "file" && b.type === "file") return a.sha256 === b.sha256 && a.mode === b.mode
  if (a.type === "symlink" && b.type === "symlink") return a.target === b.target
  return false
}

/** `$HOME`, sus ancestros y la raíz del disco no se toman enteros como carpeta de un run. */
function refusedRoot(root: string): string | null {
  const home = realpathSync.native(homedir())
  if (root === parse(root).root) return `no se trabaja sobre la raíz del disco (${root})`
  if (root === home || home.startsWith(root + sep))
    return `no se trabaja sobre ${root} entero: elige una carpeta dentro de tu home`
  return null
}

async function walk(
  root: string,
  limits: { max_files: number; max_bytes: number },
): Promise<{ ok: true; files: ManifestEntry[] } | { ok: false; message: string }> {
  const files: ManifestEntry[] = []
  let bytes = 0
  const pending = [root]
  while (pending.length > 0) {
    const dir = pending.pop() as string
    for (const name of (await readdir(dir)).sort()) {
      const abs = join(dir, name)
      const rel = relative(root, abs).split(sep).join("/")
      const st = await lstat(abs)
      if (st.isDirectory()) pending.push(abs)
      else if (st.isSymbolicLink())
        files.push({ path: rel, type: "symlink", target: await readlink(abs) })
      else if (st.isFile()) {
        bytes += st.size
        files.push({
          path: rel,
          type: "file",
          size: st.size,
          sha256: await fileSha256(abs),
          mode: st.mode & 0o777,
        })
      }
      if (files.length > limits.max_files)
        return {
          ok: false,
          message: `la carpeta tiene más de ${limits.max_files} archivos; acota la carpeta del proyecto`,
        }
      if (bytes > limits.max_bytes)
        return {
          ok: false,
          message: `la carpeta pesa más de ${Math.round(limits.max_bytes / 1024 / 1024)} MiB; acota la carpeta del proyecto`,
        }
    }
  }
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  return { ok: true, files }
}

async function fileSha256(path: string): Promise<string> {
  const hasher = new Bun.CryptoHasher("sha256")
  for await (const chunk of Bun.file(path).stream()) hasher.update(chunk)
  return hasher.digest("hex")
}

function sha256(text: string): string {
  return new Bun.CryptoHasher("sha256").update(text).digest("hex")
}

/** `tar` del sistema: GNU tar en Linux, bsdtar en macOS y en Windows 10+. */
function tar(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("tar", args, { stdio: ["ignore", "ignore", "pipe"] })
    let stderr = ""
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString()
    })
    child.on("error", reject)
    child.on("close", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`tar ${args[0]} salió con ${code}: ${stderr.trim()}`)),
    )
  })
}
