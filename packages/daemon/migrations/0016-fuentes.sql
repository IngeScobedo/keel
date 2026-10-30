-- Generado desde docs/sdd/03-data-model-and-storage.md (migración 0016-fuentes) por scripts/extract-ddl.ts.
-- No editar a mano: el SDD es la fuente; `bun scripts/extract-ddl.ts --check` detecta deriva.

-- migración: 0016-fuentes
CREATE TABLE sources (
    id TEXT PRIMARY KEY NOT NULL,
    project_id TEXT NOT NULL REFERENCES projects(id),
    key_n INTEGER NOT NULL,
    title TEXT NOT NULL,
    media_type TEXT NOT NULL,
    artifact_ref TEXT NOT NULL,
    passages_json TEXT NOT NULL CHECK (json_valid(passages_json)),
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    UNIQUE (project_id, key_n)
);
