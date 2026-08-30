import { randomUUID } from "node:crypto";

export class AttachmentRepository {
  constructor(database) {
    this.database = database;
    this.statements = {
      channelOwner: database.prepare("SELECT author_id FROM messages WHERE id = ? AND deleted_at IS NULL"),
      directOwner: database.prepare("SELECT author_id FROM direct_messages WHERE id = ? AND deleted_at IS NULL"),
      insert: database.prepare(`
        INSERT INTO attachments (
          id, owner_id, message_id, direct_message_id, filename, mime_type,
          byte_size, storage_key, public_url, created_at
        ) VALUES (
          @id, @ownerId, @messageId, @directMessageId, @filename, @mime,
          @size, @storageKey, @publicUrl, @now
        )
      `),
      byId: database.prepare("SELECT * FROM attachments WHERE id = ? AND owner_id = ?"),
      countForChannel: database.prepare("SELECT COUNT(*) AS total FROM attachments WHERE message_id = ?"),
      countForDirect: database.prepare("SELECT COUNT(*) AS total FROM attachments WHERE direct_message_id = ?"),
      prunePending: database.prepare("DELETE FROM attachments WHERE uploaded_at IS NULL AND created_at < ?"),
      complete: database.prepare("UPDATE attachments SET uploaded_at = ? WHERE id = ? AND owner_id = ? AND uploaded_at IS NULL"),
      remove: database.prepare("DELETE FROM attachments WHERE id = ? AND owner_id = ? AND uploaded_at IS NULL"),
    };
  }

  create({ scope, messageId, ownerId, filename, mime, size, storageKey, publicUrl }) {
    this.statements.prunePending.run(Date.now() - 60 * 60 * 1000);
    const owner = (scope === "channel" ? this.statements.channelOwner : this.statements.directOwner).get(messageId)?.author_id;
    if (owner !== ownerId) return null;
    const count = (scope === "channel" ? this.statements.countForChannel : this.statements.countForDirect).get(messageId)?.total ?? 0;
    if (count >= 5) return null;
    const attachment = {
      id: randomUUID(), ownerId,
      messageId: scope === "channel" ? messageId : null,
      directMessageId: scope === "direct" ? messageId : null,
      filename, mime, size, storageKey, publicUrl, now: Date.now(),
    };
    this.statements.insert.run(attachment);
    return attachment;
  }

  pending(id, ownerId) {
    return this.statements.byId.get(id, ownerId) ?? null;
  }

  complete(id, ownerId) {
    return this.statements.complete.run(Date.now(), id, ownerId).changes > 0;
  }

  removePending(id, ownerId) {
    this.statements.remove.run(id, ownerId);
  }

  listFor(type, messageIds) {
    if (!messageIds.length) return new Map();
    const column = type === "channel" ? "message_id" : "direct_message_id";
    const placeholders = messageIds.map(() => "?").join(",");
    const rows = this.database.prepare(`
      SELECT id, ${column} AS message_id, filename, mime_type, byte_size,
        public_url, width, height, created_at
      FROM attachments WHERE uploaded_at IS NOT NULL AND ${column} IN (${placeholders})
      ORDER BY created_at, id
    `).all(...messageIds);
    const grouped = new Map();
    for (const row of rows) {
      const list = grouped.get(row.message_id) ?? [];
      list.push({
        id: row.id, filename: row.filename, mime: row.mime_type, size: row.byte_size,
        url: row.public_url, width: row.width, height: row.height, at: row.created_at,
      });
      grouped.set(row.message_id, list);
    }
    return grouped;
  }
}
