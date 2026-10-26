-- Generado desde docs/sdd/03-data-model-and-storage.md (migración 0012-flujo-de-la-tarea) por scripts/extract-ddl.ts.
-- No editar a mano: el SDD es la fuente; `bun scripts/extract-ddl.ts --check` detecta deriva.

-- migración: 0012-flujo-de-la-tarea
CREATE TABLE task_flows (
    work_item_id TEXT PRIMARY KEY NOT NULL REFERENCES work_items(id),
    stage TEXT NOT NULL CHECK (stage IN ('brief', 'design', 'implement', 'review', 'close')),
    ceremony TEXT CHECK (ceremony IS NULL OR ceremony IN ('direct', 'formal')),
    ceremony_reason TEXT,
    contract_sha256 TEXT,
    baseline_json TEXT CHECK (baseline_json IS NULL OR json_valid(baseline_json)),
    last_verify_json TEXT CHECK (last_verify_json IS NULL OR json_valid(last_verify_json)),
    started_by TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE task_docs (
    id TEXT PRIMARY KEY NOT NULL,
    work_item_id TEXT NOT NULL REFERENCES work_items(id),
    kind TEXT NOT NULL CHECK (kind IN ('brief', 'spec', 'design', 'tasks', 'story', 'qa')),
    version INTEGER NOT NULL CHECK (version >= 1),
    artifact_ref TEXT NOT NULL,
    sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
    size INTEGER NOT NULL CHECK (size >= 0),
    author TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    UNIQUE (work_item_id, kind, version)
);

CREATE TABLE project_profiles (
    project_id TEXT PRIMARY KEY NOT NULL REFERENCES projects(id),
    profile_json TEXT NOT NULL CHECK (json_valid(profile_json)),
    confirmed_by TEXT,
    confirmed_at TEXT,
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
