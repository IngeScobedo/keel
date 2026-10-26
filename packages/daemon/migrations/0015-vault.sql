-- Generado desde docs/sdd/03-data-model-and-storage.md (migración 0015-vault) por scripts/extract-ddl.ts.
-- No editar a mano: el SDD es la fuente; `bun scripts/extract-ddl.ts --check` detecta deriva.

-- migración: 0015-vault
CREATE TABLE vault_items (
    id TEXT PRIMARY KEY NOT NULL,
    project_id TEXT REFERENCES projects(id),
    kind TEXT NOT NULL CHECK (kind IN ('password', 'ssh_key', 'passphrase', 'token', 'connection_string')),
    label TEXT NOT NULL,
    ciphertext BLOB NOT NULL,
    nonce BLOB NOT NULL,
    wrapped_dek BLOB NOT NULL,
    public_key TEXT,
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    rotated_at TEXT,
    last_used_at TEXT,
    deleted_at TEXT
);

CREATE TABLE vault_meta (
    key TEXT PRIMARY KEY NOT NULL,
    value TEXT NOT NULL
);

ALTER TABLE connections ADD COLUMN auth_method TEXT
    CHECK (auth_method IS NULL OR auth_method IN ('agent', 'file', 'key', 'password', 'ask'));
ALTER TABLE connections ADD COLUMN vault_item_id TEXT REFERENCES vault_items(id);
ALTER TABLE connections ADD COLUMN host_key TEXT;
ALTER TABLE connections ADD COLUMN tags_json TEXT NOT NULL DEFAULT '[]'
    CHECK (json_valid(tags_json));
ALTER TABLE permission_grants ADD COLUMN risk_accepted_at TEXT;
