-- Generado desde docs/sdd/03-data-model-and-storage.md (migración 0004-uso-interactivo) por scripts/extract-ddl.ts.
-- No editar a mano: el SDD es la fuente; `bun scripts/extract-ddl.ts --check` detecta deriva.

-- migración: 0004-uso-interactivo
CREATE TABLE permission_rules (
    id TEXT PRIMARY KEY NOT NULL,
    project_id TEXT NOT NULL REFERENCES projects(id),
    tool TEXT NOT NULL,
    prefix TEXT,
    exact INTEGER NOT NULL DEFAULT 0 CHECK (exact IN (0, 1)),
    effect TEXT NOT NULL CHECK (effect IN ('auto', 'deny')),
    source_approval_id TEXT,
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    expires_at TEXT,
    revoked_at TEXT,
    revoked_by TEXT
);
CREATE INDEX idx_permission_rules_active ON permission_rules(project_id)
    WHERE revoked_at IS NULL;

ALTER TABLE runs ADD COLUMN parent_run_id TEXT;
ALTER TABLE projects ADD COLUMN last_opened_at TEXT;
