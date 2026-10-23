-- Generado desde docs/sdd/03-data-model-and-storage.md (migración 0008-intermediario-de-recursos) por scripts/extract-ddl.ts.
-- No editar a mano: el SDD es la fuente; `bun scripts/extract-ddl.ts --check` detecta deriva.

-- migración: 0008-intermediario-de-recursos
ALTER TABLE connections ADD COLUMN environment TEXT NOT NULL DEFAULT 'dev'
    CHECK (environment IN ('dev', 'staging', 'prod'));
ALTER TABLE connections ADD COLUMN guarantees_json TEXT NOT NULL DEFAULT '{}'
    CHECK (json_valid(guarantees_json));
ALTER TABLE connections ADD COLUMN secret_ref_ro TEXT;
ALTER TABLE connections ADD COLUMN created_at TEXT;
ALTER TABLE connections ADD COLUMN archived_at TEXT;
CREATE UNIQUE INDEX idx_connections_name ON connections(project_id, name)
    WHERE archived_at IS NULL;
ALTER TABLE permission_grants ADD COLUMN operation TEXT;
CREATE INDEX idx_grants_connection ON permission_grants(connection_id, operation)
    WHERE revoked_at IS NULL;
