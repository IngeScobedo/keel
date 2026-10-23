-- Generado desde docs/sdd/03-data-model-and-storage.md (migración 0006-eventos-semanticos) por scripts/extract-ddl.ts.
-- No editar a mano: el SDD es la fuente; `bun scripts/extract-ddl.ts --check` detecta deriva.

-- migración: 0006-eventos-semanticos
CREATE TABLE semantic_events (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    project_id TEXT NOT NULL REFERENCES projects(id),
    work_item_id TEXT,
    run_id TEXT,
    tool_use_id TEXT,
    kind TEXT NOT NULL,
    schema_version INTEGER NOT NULL CHECK (schema_version > 0),
    coverage TEXT NOT NULL CHECK (coverage IN ('instrumented', 'observed', 'inferred')),
    sensitivity TEXT NOT NULL DEFAULT 'internal'
        CHECK (sensitivity IN ('internal', 'restricted')),
    interpreter TEXT NOT NULL,
    dedupe_key TEXT NOT NULL UNIQUE,
    source_event_ids_json TEXT NOT NULL CHECK (json_valid(source_event_ids_json)),
    artifact_refs_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(artifact_refs_json)),
    payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
    occurred_at TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_semantic_run ON semantic_events(run_id, seq);
CREATE INDEX idx_semantic_work_item ON semantic_events(work_item_id, seq);
CREATE INDEX idx_semantic_kind ON semantic_events(project_id, kind, seq);
