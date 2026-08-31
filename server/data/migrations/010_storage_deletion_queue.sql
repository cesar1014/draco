CREATE TABLE storage_deletion_queue (
  storage_key TEXT PRIMARY KEY,
  queued_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0
);

CREATE TRIGGER attachments_queue_storage_delete
BEFORE DELETE ON attachments
WHEN OLD.storage_key IS NOT NULL AND OLD.storage_key != ''
BEGIN
  INSERT INTO storage_deletion_queue(storage_key, queued_at, attempts)
  VALUES (OLD.storage_key, CAST(unixepoch('subsec') * 1000 AS INTEGER), 0)
  ON CONFLICT(storage_key) DO NOTHING;
END;
