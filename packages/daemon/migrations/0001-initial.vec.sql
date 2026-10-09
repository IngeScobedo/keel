-- Generado desde docs/sdd/03-data-model-and-storage.md (bloque vec0, requiere sqlite-vec) por scripts/extract-ddl.ts.
-- No editar a mano: el SDD es la fuente; `bun scripts/extract-ddl.ts --check` detecta deriva.

CREATE VIRTUAL TABLE research_vectors USING vec0(
    research_id TEXT PRIMARY KEY,
    project_id TEXT PARTITION KEY,
    embedding FLOAT[384]
);
