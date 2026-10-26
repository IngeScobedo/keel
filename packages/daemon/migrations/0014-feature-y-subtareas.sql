-- Generado desde docs/sdd/03-data-model-and-storage.md (migración 0014-feature-y-subtareas) por scripts/extract-ddl.ts.
-- No editar a mano: el SDD es la fuente; `bun scripts/extract-ddl.ts --check` detecta deriva.

-- migración: 0014-feature-y-subtareas
ALTER TABLE task_flows ADD COLUMN feature_json TEXT
    CHECK (feature_json IS NULL OR json_valid(feature_json));
ALTER TABLE task_flows ADD COLUMN subtask_json TEXT
    CHECK (subtask_json IS NULL OR json_valid(subtask_json));
CREATE INDEX idx_work_items_parent ON work_items(parent_work_item_id)
    WHERE parent_work_item_id IS NOT NULL;
