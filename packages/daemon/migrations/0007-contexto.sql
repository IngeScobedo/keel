-- Generado desde docs/sdd/03-data-model-and-storage.md (migración 0007-contexto) por scripts/extract-ddl.ts.
-- No editar a mano: el SDD es la fuente; `bun scripts/extract-ddl.ts --check` detecta deriva.

-- migración: 0007-contexto
CREATE VIRTUAL TABLE context_fts USING fts5(
    ref UNINDEXED,
    project_id UNINDEXED,
    kind UNINDEXED,
    title,
    body,
    tokenize = 'unicode61 remove_diacritics 2'
);
INSERT INTO context_fts(ref, project_id, kind, title, body)
    SELECT 'keel://task/' || id, project_id, 'task', display_id || ' ' || title, spec_markdown
    FROM work_items;
INSERT INTO context_fts(ref, project_id, kind, title, body)
    SELECT 'keel://note/' || n.id, w.project_id, 'note', w.display_id, n.content_markdown
    FROM notes n JOIN work_items w ON w.id = n.work_item_id;
CREATE TRIGGER context_fts_task_insert AFTER INSERT ON work_items BEGIN
    INSERT INTO context_fts(ref, project_id, kind, title, body)
    VALUES ('keel://task/' || NEW.id, NEW.project_id, 'task', NEW.display_id || ' ' || NEW.title, NEW.spec_markdown);
END;
CREATE TRIGGER context_fts_task_update AFTER UPDATE OF title, spec_markdown ON work_items BEGIN
    DELETE FROM context_fts WHERE ref = 'keel://task/' || OLD.id;
    INSERT INTO context_fts(ref, project_id, kind, title, body)
    VALUES ('keel://task/' || NEW.id, NEW.project_id, 'task', NEW.display_id || ' ' || NEW.title, NEW.spec_markdown);
END;
CREATE TRIGGER context_fts_note_insert AFTER INSERT ON notes BEGIN
    INSERT INTO context_fts(ref, project_id, kind, title, body)
    SELECT 'keel://note/' || NEW.id, w.project_id, 'note', w.display_id, NEW.content_markdown
    FROM work_items w WHERE w.id = NEW.work_item_id;
END;
CREATE TRIGGER context_fts_evidence_insert AFTER INSERT ON evidence
WHEN NOT EXISTS (
    SELECT 1 FROM artifacts a WHERE a.sha256 = NEW.sha256 AND a.sensitivity = 'restricted'
) BEGIN
    INSERT INTO context_fts(ref, project_id, kind, title, body)
    VALUES ('keel://evidence/' || NEW.id, NEW.project_id, 'evidence',
            coalesce(NEW.title, NEW.kind), NEW.kind || ' ' || NEW.metadata_json);
END;
CREATE TRIGGER context_fts_evidence_delete AFTER DELETE ON evidence BEGIN
    DELETE FROM context_fts WHERE ref = 'keel://evidence/' || OLD.id;
END;
