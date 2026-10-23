-- Generado desde docs/sdd/03-data-model-and-storage.md (migración 0010-investigaciones) por scripts/extract-ddl.ts.
-- No editar a mano: el SDD es la fuente; `bun scripts/extract-ddl.ts --check` detecta deriva.

-- migración: 0010-investigaciones
CREATE TABLE research_claims_items (
    id TEXT PRIMARY KEY NOT NULL,
    project_id TEXT NOT NULL REFERENCES projects(id),
    work_item_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('hypothesis', 'finding', 'conclusion')),
    statement TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('hypothesis', 'observed', 'verified', 'refuted')),
    evidence_ids_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(evidence_ids_json)),
    created_by TEXT NOT NULL,
    run_id TEXT,
    decided_by TEXT,
    decided_at TEXT,
    decision_reason TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    FOREIGN KEY(work_item_id, project_id) REFERENCES work_items(id, project_id)
);
CREATE INDEX idx_claims_work_item ON research_claims_items(work_item_id, created_at);

CREATE TABLE research_reports (
    id TEXT PRIMARY KEY NOT NULL,
    project_id TEXT NOT NULL REFERENCES projects(id),
    work_item_id TEXT NOT NULL,
    version INTEGER NOT NULL CHECK (version > 0),
    markdown TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    UNIQUE(work_item_id, version),
    FOREIGN KEY(work_item_id, project_id) REFERENCES work_items(id, project_id)
);
CREATE TRIGGER research_reports_no_update BEFORE UPDATE ON research_reports BEGIN
    SELECT RAISE(ABORT, 'a report version is immutable');
END;
