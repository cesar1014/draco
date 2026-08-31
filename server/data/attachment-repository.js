import { randomUUID } from "node:crypto";

export class AttachmentRepository {
  constructor(database, objectStorage = null, env = process.env) {
    this.database = database;
    this.objectStorage = objectStorage;
    const configuredQuota = Number(env.OBJECT_STORAGE_USER_QUOTA_BYTES);
    this.userQuotaBytes = Number.isSafeInteger(configuredQuota) && configuredQuota > 0
      ? configuredQuota
      : 1024 * 1024 * 1024;
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
      usedByOwner: database.prepare(`
        SELECT COALESCE(SUM(byte_size), 0) AS total
        FROM attachments WHERE owner_id = ?
      `),
      expiredPending: database.prepare(`
        SELECT id, owner_id, storage_key FROM attachments
        WHERE uploaded_at IS NULL AND created_at < ? ORDER BY created_at LIMIT ?
      `),
      orphaned: database.prepare(`
        SELECT a.id, a.owner_id, a.storage_key
        FROM attachments a
        LEFT JOIN messages m ON m.id = a.message_id
        LEFT JOIN direct_messages dm ON dm.id = a.direct_message_id
        WHERE (a.message_id IS NOT NULL AND (m.id IS NULL OR m.deleted_at IS NOT NULL))
           OR (a.direct_message_id IS NOT NULL AND (dm.id IS NULL OR dm.deleted_at IS NOT NULL))
        ORDER BY a.created_at LIMIT ?
      `),
      removeById: database.prepare("DELETE FROM attachments WHERE id = ? AND uploaded_at IS NULL"),
      removeAny: database.prepare("DELETE FROM attachments WHERE id = ?"),
      queuedDeletions: database.prepare(`
        SELECT storage_key, attempts FROM storage_deletion_queue ORDER BY queued_at LIMIT ?
      `),
      completeDeletion: database.prepare("DELETE FROM storage_deletion_queue WHERE storage_key = ?"),
      failDeletion: database.prepare(`
        UPDATE storage_deletion_queue SET attempts = attempts + 1 WHERE storage_key = ?
      `),
      complete: database.prepare("UPDATE attachments SET uploaded_at = ? WHERE id = ? AND owner_id = ? AND uploaded_at IS NULL"),
      remove: database.prepare("DELETE FROM attachments WHERE id = ? AND owner_id = ? AND uploaded_at IS NULL"),
    };
    this.createTransaction = database.transaction((attachment, scope) => {
      const owner = (scope === "channel" ? this.statements.channelOwner : this.statements.directOwner)
        .get(attachment.messageId ?? attachment.directMessageId)?.author_id;
      if (owner !== attachment.ownerId) return null;
      const count = (scope === "channel" ? this.statements.countForChannel : this.statements.countForDirect)
        .get(attachment.messageId ?? attachment.directMessageId)?.total ?? 0;
      if (count >= 5) return null;
      const used = this.statements.usedByOwner.get(attachment.ownerId)?.total ?? 0;
      if (used + attachment.size > this.userQuotaBytes) return { quotaExceeded: true };
      this.statements.insert.run(attachment);
      return attachment;
    });
  }

  create({ scope, messageId, ownerId, filename, mime, size, storageKey }) {
    const attachment = {
      id: randomUUID(), ownerId,
      messageId: scope === "channel" ? messageId : null,
      directMessageId: scope === "direct" ? messageId : null,
      filename, mime, size, storageKey, publicUrl: null, now: Date.now(),
    };
    return this.createTransaction(attachment, scope);
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

  expiredPending(cutoff = Date.now() - 60 * 60 * 1000, limit = 100) {
    return this.statements.expiredPending.all(cutoff, limit);
  }

  removeExpired(id) {
    return this.statements.removeById.run(id).changes > 0;
  }

  orphaned(limit = 100) {
    return this.statements.orphaned.all(limit);
  }

  remove(id) {
    return this.statements.removeAny.run(id).changes > 0;
  }

  queuedDeletions(limit = 100) {
    return this.statements.queuedDeletions.all(limit);
  }

  completeDeletion(storageKey) {
    this.statements.completeDeletion.run(storageKey);
  }

  failDeletion(storageKey) {
    this.statements.failDeletion.run(storageKey);
  }

  listFor(type, messageIds) {
    if (!messageIds.length) return new Map();
    const column = type === "channel" ? "message_id" : "direct_message_id";
    const placeholders = messageIds.map(() => "?").join(",");
    const rows = this.database.prepare(`
      SELECT id, ${column} AS message_id, filename, mime_type, byte_size,
        storage_key, width, height, created_at
      FROM attachments WHERE uploaded_at IS NOT NULL AND ${column} IN (${placeholders})
      ORDER BY created_at, id
    `).all(...messageIds);
    const grouped = new Map();
    for (const row of rows) {
      const list = grouped.get(row.message_id) ?? [];
      list.push({
        id: row.id, filename: row.filename, mime: row.mime_type, size: row.byte_size,
        url: this.objectStorage?.downloadUrl(row.storage_key) ?? null,
        width: row.width, height: row.height, at: row.created_at,
      });
      grouped.set(row.message_id, list);
    }
    return grouped;
  }
}
