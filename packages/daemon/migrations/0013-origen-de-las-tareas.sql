-- Generado desde docs/sdd/03-data-model-and-storage.md (migración 0013-origen-de-las-tareas) por scripts/extract-ddl.ts.
-- No editar a mano: el SDD es la fuente; `bun scripts/extract-ddl.ts --check` detecta deriva.

-- migración: 0013-origen-de-las-tareas
ALTER TABLE work_items ADD COLUMN origin_work_item_id TEXT REFERENCES work_items(id);
ALTER TABLE work_items ADD COLUMN origin_run_id TEXT REFERENCES runs(id);
CREATE INDEX idx_work_items_origin ON work_items(origin_work_item_id)
    WHERE origin_work_item_id IS NOT NULL;
