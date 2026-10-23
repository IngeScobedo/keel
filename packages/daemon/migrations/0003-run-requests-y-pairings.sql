-- Generado desde docs/sdd/03-data-model-and-storage.md (migración 0003-run-requests-y-pairings) por scripts/extract-ddl.ts.
-- No editar a mano: el SDD es la fuente; `bun scripts/extract-ddl.ts --check` detecta deriva.

-- migración: 0003-run-requests-y-pairings
CREATE TABLE run_requests (
    id TEXT PRIMARY KEY NOT NULL,
    project_id TEXT NOT NULL REFERENCES projects(id),
    work_item_id TEXT NOT NULL,
    purpose TEXT NOT NULL CHECK (purpose IN ('triage_eval', 'plan', 'execute')),
    prompt TEXT,
    profile TEXT,
    reason TEXT NOT NULL,
    requested_by TEXT NOT NULL,
    requested_by_run TEXT,
    state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'started', 'rejected')),
    decided_by TEXT,
    decided_at TEXT,
    run_id TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    FOREIGN KEY(work_item_id, project_id) REFERENCES work_items(id, project_id)
);
CREATE INDEX idx_run_requests_pending ON run_requests(project_id) WHERE state = 'pending';

CREATE TABLE session_pairings (
    id TEXT PRIMARY KEY NOT NULL,
    code TEXT NOT NULL,
    client_name TEXT NOT NULL,
    cwd TEXT,
    state TEXT NOT NULL DEFAULT 'pending'
        CHECK (state IN ('pending', 'approved', 'rejected', 'closed')),
    project_id TEXT REFERENCES projects(id),
    work_item_id TEXT,
    scopes_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(scopes_json)),
    decided_by TEXT,
    decided_at TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    closed_at TEXT
);
CREATE INDEX idx_pairings_pending ON session_pairings(state) WHERE state = 'pending';
