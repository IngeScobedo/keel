-- Generado desde docs/sdd/03-data-model-and-storage.md (migración 0009-plugins) por scripts/extract-ddl.ts.
-- No editar a mano: el SDD es la fuente; `bun scripts/extract-ddl.ts --check` detecta deriva.

-- migración: 0009-plugins
CREATE TABLE plugins (
    id TEXT PRIMARY KEY NOT NULL,
    version TEXT NOT NULL,
    path TEXT NOT NULL,
    manifest_json TEXT NOT NULL CHECK (json_valid(manifest_json)),
    sha256 TEXT NOT NULL,
    installed_by TEXT NOT NULL,
    installed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    uninstalled_at TEXT
);
