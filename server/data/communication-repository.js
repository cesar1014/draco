import { AttachmentRepository } from "./attachment-repository.js";

function reactionSummary(database, table, messageId) {
  return database.prepare(`
    SELECT emoji, COUNT(*) AS count, GROUP_CONCAT(user_id) AS users
    FROM ${table} WHERE message_id = ? GROUP BY emoji ORDER BY MIN(created_at)
  `).all(messageId).map((row) => ({
    emoji: row.emoji,
    count: row.count,
    userIds: row.users ? row.users.split(",") : [],
  }));
}

export class CommunicationRepository {
  constructor(database, attachments = null) {
    this.database = database;
    this.cipher = database.dracoFieldCipher;
    this.attachments = attachments ?? new AttachmentRepository(database);
    this.statements = {
      channelMessage: database.prepare(`
        SELECT m.sequence, m.id, m.channel_id, c.guild_id, m.author_id,
          m.username_snapshot, m.color_snapshot, m.content, m.created_at,
          m.edited_at, m.deleted_at, m.reply_to_id
        FROM messages m JOIN channels c ON c.id = m.channel_id WHERE m.id = ?
      `),
      directMessage: database.prepare(`
        SELECT dm.sequence, dm.id, dm.thread_id, dm.author_id, dm.content,
          dm.created_at, dm.edited_at, dm.deleted_at, dm.reply_to_id,
          a.username, p.color
        FROM direct_messages dm JOIN accounts a ON a.user_id = dm.author_id
        JOIN profiles p ON p.user_id = dm.author_id WHERE dm.id = ?
      `),
      editChannel: database.prepare(`
        UPDATE messages SET content = ?, edited_at = ? WHERE id = ? AND deleted_at IS NULL
      `),
      editDirect: database.prepare(`
        UPDATE direct_messages SET content = ?, edited_at = ? WHERE id = ? AND deleted_at IS NULL
      `),
      deleteChannel: database.prepare(`
        UPDATE messages SET content = '', deleted_at = ?, edited_at = NULL WHERE id = ? AND deleted_at IS NULL
      `),
      deleteDirect: database.prepare(`
        UPDATE direct_messages SET content = '', deleted_at = ?, edited_at = NULL WHERE id = ? AND deleted_at IS NULL
      `),
      setChannelReply: database.prepare(`
        UPDATE messages SET reply_to_id = ?
        WHERE id = ? AND EXISTS (
          SELECT 1 FROM messages parent, messages child
          WHERE parent.id = ? AND child.id = ? AND parent.channel_id = child.channel_id
        )
      `),
      setDirectReply: database.prepare(`
        UPDATE direct_messages SET reply_to_id = ?
        WHERE id = ? AND EXISTS (
          SELECT 1 FROM direct_messages parent, direct_messages child
          WHERE parent.id = ? AND child.id = ? AND parent.thread_id = child.thread_id
        )
      `),
      channelReaction: database.prepare(`
        SELECT 1 FROM message_reactions WHERE message_id = ? AND user_id = ? AND emoji = ?
      `),
      directReaction: database.prepare(`
        SELECT 1 FROM direct_message_reactions WHERE message_id = ? AND user_id = ? AND emoji = ?
      `),
      addChannelReaction: database.prepare(`
        INSERT INTO message_reactions (message_id, user_id, emoji, created_at) VALUES (?, ?, ?, ?)
      `),
      addDirectReaction: database.prepare(`
        INSERT INTO direct_message_reactions (message_id, user_id, emoji, created_at) VALUES (?, ?, ?, ?)
      `),
      removeChannelReaction: database.prepare(`
        DELETE FROM message_reactions WHERE message_id = ? AND user_id = ? AND emoji = ?
      `),
      removeDirectReaction: database.prepare(`
        DELETE FROM direct_message_reactions WHERE message_id = ? AND user_id = ? AND emoji = ?
      `),
      clearMentions: database.prepare("DELETE FROM message_mentions WHERE message_id = ?"),
    };
  }

  channelMessage(id) {
    const row = this.statements.channelMessage.get(id);
    if (!row) return null;
    return {
      sequence: row.sequence,
      id: row.id,
      channelId: row.channel_id,
      guildId: row.guild_id,
      authorId: row.author_id,
      username: row.username_snapshot,
      color: row.color_snapshot,
      content: row.deleted_at ? "" : this.cipher.decrypt(row.content, `messages:${row.id}`),
      at: row.created_at,
      editedAt: row.edited_at,
      deletedAt: row.deleted_at,
      replyToId: row.reply_to_id,
      reply: row.reply_to_id ? this.channelReference(row.reply_to_id) : null,
      reactions: reactionSummary(this.database, "message_reactions", row.id),
      attachments: this.attachments.listFor("channel", [row.id]).get(row.id) ?? [],
    };
  }

  directMessage(id) {
    const row = this.statements.directMessage.get(id);
    if (!row) return null;
    return {
      sequence: row.sequence,
      id: row.id,
      threadId: row.thread_id,
      authorId: row.author_id,
      username: row.username,
      color: row.color,
      content: row.deleted_at ? "" : this.cipher.decrypt(row.content, `direct_messages:${row.id}`),
      at: row.created_at,
      editedAt: row.edited_at,
      deletedAt: row.deleted_at,
      replyToId: row.reply_to_id,
      reply: row.reply_to_id ? this.directReference(row.reply_to_id) : null,
      reactions: reactionSummary(this.database, "direct_message_reactions", row.id),
      attachments: this.attachments.listFor("direct", [row.id]).get(row.id) ?? [],
    };
  }

  channelReference(id) {
    const row = this.statements.channelMessage.get(id);
    return row ? {
      id: row.id, authorId: row.author_id, username: row.username_snapshot,
      content: row.deleted_at
        ? null
        : this.cipher.decrypt(row.content, `messages:${row.id}`).slice(0, 160),
      deleted: Boolean(row.deleted_at),
    } : null;
  }

  directReference(id) {
    const row = this.statements.directMessage.get(id);
    return row ? {
      id: row.id, authorId: row.author_id, username: row.username,
      content: row.deleted_at
        ? null
        : this.cipher.decrypt(row.content, `direct_messages:${row.id}`).slice(0, 160),
      deleted: Boolean(row.deleted_at),
    } : null;
  }

  editChannel(id, content) {
    this.statements.editChannel.run(this.cipher.encrypt(content, `messages:${id}`), Date.now(), id);
    return this.channelMessage(id);
  }

  editDirect(id, content) {
    this.statements.editDirect.run(this.cipher.encrypt(content, `direct_messages:${id}`), Date.now(), id);
    return this.directMessage(id);
  }

  deleteChannel(id) {
    this.statements.deleteChannel.run(Date.now(), id);
    return this.channelMessage(id);
  }

  deleteDirect(id) {
    this.statements.deleteDirect.run(Date.now(), id);
    return this.directMessage(id);
  }

  setReply(type, messageId, replyToId) {
    const statement = type === "channel" ? this.statements.setChannelReply : this.statements.setDirectReply;
    return statement.run(replyToId, messageId, replyToId, messageId).changes > 0;
  }

  toggleReaction(type, messageId, userId, emoji) {
    const channel = type === "channel";
    const exists = (channel ? this.statements.channelReaction : this.statements.directReaction)
      .get(messageId, userId, emoji);
    const statement = exists
      ? (channel ? this.statements.removeChannelReaction : this.statements.removeDirectReaction)
      : (channel ? this.statements.addChannelReaction : this.statements.addDirectReaction);
    exists ? statement.run(messageId, userId, emoji) : statement.run(messageId, userId, emoji, Date.now());
    return channel ? this.channelMessage(messageId) : this.directMessage(messageId);
  }

  clearMentions(messageId) {
    this.statements.clearMentions.run(messageId);
  }

  enrich(type, messages) {
    if (!messages.length) return messages;
    const ids = messages.map((message) => message.id);
    const attachments = this.attachments.listFor(type, ids);
    const placeholders = ids.map(() => "?").join(",");
    const reactionTable = type === "channel" ? "message_reactions" : "direct_message_reactions";
    const reactionRows = this.database.prepare(`
      SELECT message_id, emoji, user_id FROM ${reactionTable}
      WHERE message_id IN (${placeholders}) ORDER BY created_at
    `).all(...ids);
    const reactions = new Map();
    for (const row of reactionRows) {
      const list = reactions.get(row.message_id) ?? [];
      let item = list.find((candidate) => candidate.emoji === row.emoji);
      if (!item) {
        item = { emoji: row.emoji, count: 0, userIds: [] };
        list.push(item);
      }
      item.count += 1;
      item.userIds.push(row.user_id);
      reactions.set(row.message_id, list);
    }

    const parentIds = [...new Set(messages.map((message) => message.replyToId).filter(Boolean))];
    const references = new Map();
    if (parentIds.length) {
      const parentPlaceholders = parentIds.map(() => "?").join(",");
      const table = type === "channel" ? "messages" : "direct_messages";
      const authorJoin = type === "channel"
        ? ""
        : "JOIN accounts a ON a.user_id = m.author_id";
      const username = type === "channel" ? "m.username_snapshot AS username" : "a.username AS username";
      const rows = this.database.prepare(`
        SELECT m.id, m.author_id, ${username}, m.content, m.deleted_at
        FROM ${table} m ${authorJoin} WHERE m.id IN (${parentPlaceholders})
      `).all(...parentIds);
      for (const row of rows) references.set(row.id, {
        id: row.id,
        authorId: row.author_id,
        username: row.username,
        content: row.deleted_at
          ? null
          : this.cipher.decrypt(row.content, `${table}:${row.id}`).slice(0, 160),
        deleted: Boolean(row.deleted_at),
      });
    }
    return messages.map((message) => ({
      ...message,
      reply: message.replyToId ? references.get(message.replyToId) ?? null : null,
      reactions: reactions.get(message.id) ?? [],
      attachments: attachments.get(message.id) ?? [],
    }));
  }
}
