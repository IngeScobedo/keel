-- Generado desde docs/sdd/03-data-model-and-storage.md (migración 0002-workspace-driver) por scripts/extract-ddl.ts.
-- No editar a mano: el SDD es la fuente; `bun scripts/extract-ddl.ts --check` detecta deriva.

-- migración: 0002-workspace-driver
ALTER TABLE projects ADD COLUMN vcs TEXT NOT NULL DEFAULT 'git'
    CHECK (vcs IN ('git', 'none'));
ALTER TABLE projects ADD COLUMN vcs_none_confirmed_at TEXT;
ALTER TABLE projects ADD COLUMN vcs_none_confirmed_by TEXT;

CREATE TABLE run_snapshots (
    id TEXT PRIMARY KEY NOT NULL,
    project_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    root_path TEXT NOT NULL,
    snapshot_dir TEXT NOT NULL,
    manifest_sha256 TEXT NOT NULL,
    file_count INTEGER NOT NULL CHECK (file_count >= 0),
    total_bytes INTEGER NOT NULL CHECK (total_bytes >= 0),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    released_at TEXT,
    restored_at TEXT,
    UNIQUE(run_id),
    FOREIGN KEY(run_id, project_id) REFERENCES runs(id, project_id)
);
CREATE UNIQUE INDEX idx_one_writer_per_root ON run_snapshots(root_path)
    WHERE released_at IS NULL;
