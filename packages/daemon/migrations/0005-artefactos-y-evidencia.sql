-- Generado desde docs/sdd/03-data-model-and-storage.md (migración 0005-artefactos-y-evidencia) por scripts/extract-ddl.ts.
-- No editar a mano: el SDD es la fuente; `bun scripts/extract-ddl.ts --check` detecta deriva.

-- migración: 0005-artefactos-y-evidencia
CREATE TABLE artifacts (
    sha256 TEXT PRIMARY KEY NOT NULL CHECK (length(sha256) = 64),
    size INTEGER NOT NULL CHECK (size >= 0),
    media_type TEXT NOT NULL,
    sensitivity TEXT NOT NULL DEFAULT 'internal'
        CHECK (sensitivity IN ('internal', 'restricted')),
    integrity TEXT NOT NULL DEFAULT 'ok' CHECK (integrity IN ('ok', 'mismatch', 'missing')),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE evidence_v2 (
    id TEXT PRIMARY KEY NOT NULL,
    project_id TEXT NOT NULL REFERENCES projects(id),
    work_item_id TEXT,
    run_id TEXT,
    kind TEXT NOT NULL,
    title TEXT,
    artifact_ref TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
    provenance_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(provenance_json)),
    created_by TEXT NOT NULL DEFAULT 'system:migration',
    supersedes_id TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    UNIQUE(id, project_id),
    CHECK (work_item_id IS NOT NULL OR run_id IS NOT NULL),
    FOREIGN KEY(run_id, project_id) REFERENCES runs(id, project_id),
    FOREIGN KEY(work_item_id, project_id) REFERENCES work_items(id, project_id),
    FOREIGN KEY(supersedes_id, project_id) REFERENCES evidence_v2(id, project_id)
);
INSERT INTO evidence_v2(id, project_id, run_id, kind, artifact_ref, sha256, metadata_json, created_at)
    SELECT id, project_id, run_id, kind, artifact_ref, sha256, metadata_json, created_at FROM evidence;
DROP TABLE evidence;
ALTER TABLE evidence_v2 RENAME TO evidence;
CREATE INDEX idx_evidence_work_item ON evidence(work_item_id);
CREATE INDEX idx_evidence_run ON evidence(run_id);

CREATE TABLE retention_in_progress (
    purge_id TEXT PRIMARY KEY NOT NULL,
    actor_id TEXT NOT NULL
);
DROP TRIGGER events_no_delete;
CREATE TRIGGER events_no_delete BEFORE DELETE ON events
WHEN NOT EXISTS (SELECT 1 FROM retention_in_progress) BEGIN
    SELECT RAISE(ABORT, 'events are append-only');
END;

CREATE TABLE event_purges (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id TEXT REFERENCES projects(id),
    before_event_seq INTEGER NOT NULL,
    events_deleted INTEGER NOT NULL,
    reason TEXT NOT NULL,
    actor_id TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
