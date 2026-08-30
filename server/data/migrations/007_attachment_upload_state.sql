ALTER TABLE attachments ADD COLUMN uploaded_at INTEGER;
CREATE INDEX attachments_pending_upload ON attachments(owner_id, uploaded_at, created_at);
