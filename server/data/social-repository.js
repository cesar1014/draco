import { randomUUID } from "node:crypto";

const pairKey = (left, right) => [left, right].sort().join(":");

function mapPerson(row) {
  return {
    id: row.user_id,
    username: row.username,
    displayName: row.display_name || row.username,
    color: row.color,
    avatarUrl: row.avatar_url ?? null,
    customStatus: row.custom_status ?? null,
    statusExpiresAt: row.status_expires_at ?? null,
  };
}

export class SocialRepository {
  constructor(database) {
    this.database = database;
    this.statements = {
      profileById: database.prepare(`
        SELECT user_id, username, display_name, color, avatar_url,
               presence_mode, custom_status, status_expires_at
        FROM profiles WHERE user_id = ?
      `),
      profileByUsername: database.prepare(`
        SELECT p.user_id, p.username, p.display_name, p.color, p.avatar_url,
               p.presence_mode, p.custom_status, p.status_expires_at
        FROM profiles p JOIN accounts a ON a.user_id = p.user_id
        WHERE a.username = ? COLLATE NOCASE
      `),
      requestByPair: database.prepare("SELECT * FROM friend_requests WHERE pair_key = ?"),
      friendshipByPair: database.prepare("SELECT 1 FROM friendships WHERE pair_key = ?"),
      blockEitherWay: database.prepare(`
        SELECT 1 FROM user_blocks
        WHERE (blocker_id = ? AND blocked_id = ?) OR (blocker_id = ? AND blocked_id = ?)
      `),
      insertRequest: database.prepare(`
        INSERT INTO friend_requests (pair_key, requester_id, recipient_id, created_at)
        VALUES (?, ?, ?, ?)
      `),
      deleteRequest: database.prepare("DELETE FROM friend_requests WHERE pair_key = ?"),
      insertFriendship: database.prepare(`
        INSERT INTO friendships (pair_key, user_low_id, user_high_id, created_at)
        VALUES (@pairKey, @low, @high, @now)
      `),
      deleteFriendship: database.prepare("DELETE FROM friendships WHERE pair_key = ?"),
      insertBlock: database.prepare(`
        INSERT INTO user_blocks (blocker_id, blocked_id, created_at)
        VALUES (?, ?, ?)
        ON CONFLICT(blocker_id, blocked_id) DO NOTHING
      `),
      deleteBlock: database.prepare("DELETE FROM user_blocks WHERE blocker_id = ? AND blocked_id = ?"),
      listFriends: database.prepare(`
        SELECT p.user_id, p.username, p.display_name, p.color, p.avatar_url,
               p.custom_status, p.status_expires_at, f.created_at
        FROM friendships f
        JOIN profiles p ON p.user_id = CASE WHEN f.user_low_id = @userId THEN f.user_high_id ELSE f.user_low_id END
        WHERE f.user_low_id = @userId OR f.user_high_id = @userId
        ORDER BY COALESCE(p.display_name, p.username) COLLATE NOCASE
      `),
      listIncoming: database.prepare(`
        SELECT p.user_id, p.username, p.display_name, p.color, p.avatar_url,
               p.custom_status, p.status_expires_at, r.created_at
        FROM friend_requests r JOIN profiles p ON p.user_id = r.requester_id
        WHERE r.recipient_id = ? ORDER BY r.created_at DESC
      `),
      listOutgoing: database.prepare(`
        SELECT p.user_id, p.username, p.display_name, p.color, p.avatar_url,
               p.custom_status, p.status_expires_at, r.created_at
        FROM friend_requests r JOIN profiles p ON p.user_id = r.recipient_id
        WHERE r.requester_id = ? ORDER BY r.created_at DESC
      `),
      listBlocked: database.prepare(`
        SELECT p.user_id, p.username, p.display_name, p.color, p.avatar_url,
               p.custom_status, p.status_expires_at, b.created_at
        FROM user_blocks b JOIN profiles p ON p.user_id = b.blocked_id
        WHERE b.blocker_id = ? ORDER BY b.created_at DESC
      `),
      friendIds: database.prepare(`
        SELECT CASE WHEN user_low_id = ? THEN user_high_id ELSE user_low_id END AS user_id
        FROM friendships WHERE user_low_id = ? OR user_high_id = ?
      `),
      updatePresence: database.prepare(`
        UPDATE profiles SET presence_mode = @mode, custom_status = @status,
          status_expires_at = @expiresAt, updated_at = @now WHERE user_id = @userId
      `),
      insertNotification: database.prepare(`
        INSERT INTO notifications (
          id, user_id, kind, actor_id, conversation_type, conversation_id,
          metadata_json, created_at
        ) VALUES (
          @id, @userId, @kind, @actorId, @conversationType, @conversationId,
          @metadata, @now
        )
      `),
      listNotifications: database.prepare(`
        SELECT id, kind, actor_id, conversation_type, conversation_id,
               metadata_json, read_at, created_at
        FROM notifications WHERE user_id = ?
        ORDER BY created_at DESC LIMIT ?
      `),
      readNotification: database.prepare(`
        UPDATE notifications SET read_at = COALESCE(read_at, ?)
        WHERE id = ? AND user_id = ?
      `),
      markRead: database.prepare(`
        INSERT INTO read_states (
          user_id, conversation_type, conversation_id, last_read_sequence,
          mention_count, updated_at
        ) VALUES (@userId, @type, @id, @sequence, 0, @now)
        ON CONFLICT(user_id, conversation_type, conversation_id) DO UPDATE SET
          last_read_sequence = MAX(read_states.last_read_sequence, excluded.last_read_sequence),
          mention_count = 0,
          updated_at = excluded.updated_at
      `),
      incrementMention: database.prepare(`
        INSERT INTO read_states (
          user_id, conversation_type, conversation_id, last_read_sequence,
          mention_count, updated_at
        ) VALUES (@userId, @type, @id, 0, 1, @now)
        ON CONFLICT(user_id, conversation_type, conversation_id) DO UPDATE SET
          mention_count = read_states.mention_count + 1,
          updated_at = excluded.updated_at
      `),
      listReadStates: database.prepare(`
        SELECT conversation_type, conversation_id, last_read_sequence, mention_count
        FROM read_states WHERE user_id = ?
      `),
      latestChannelSequences: database.prepare(`
        SELECT channel_id AS id, MAX(sequence) AS sequence FROM messages
        WHERE deleted_at IS NULL GROUP BY channel_id
      `),
      latestDirectSequences: database.prepare(`
        SELECT dm.thread_id AS id, MAX(dm.sequence) AS sequence
        FROM direct_messages dm JOIN direct_participants dp ON dp.thread_id = dm.thread_id
        WHERE dp.user_id = ? AND dm.deleted_at IS NULL GROUP BY dm.thread_id
      `),
      memberByUsername: database.prepare(`
        SELECT a.user_id FROM accounts a
        JOIN guild_members gm ON gm.user_id = a.user_id
        WHERE gm.guild_id = ? AND a.username = ? COLLATE NOCASE
      `),
      roleByName: database.prepare(`
        SELECT id FROM roles WHERE guild_id = ? AND name = ? COLLATE NOCASE
      `),
      roleAudience: database.prepare(`
        SELECT user_id FROM guild_member_roles WHERE guild_id = ? AND role_id = ?
      `),
      guildAudience: database.prepare("SELECT user_id FROM guild_members WHERE guild_id = ?"),
      insertMention: database.prepare(`
        INSERT INTO message_mentions (message_id, target_type, target_id)
        VALUES (?, ?, ?) ON CONFLICT DO NOTHING
      `),
    };

    this.acceptTransaction = database.transaction((pair, recipientId, now) => {
      const request = this.statements.requestByPair.get(pair);
      if (!request || request.recipient_id !== recipientId) return { ok: false, error: "no-request" };
      const [low, high] = [request.requester_id, request.recipient_id].sort();
      this.statements.deleteRequest.run(pair);
      this.statements.insertFriendship.run({ pairKey: pair, low, high, now });
      return { ok: true, peerId: request.requester_id };
    });

    this.blockTransaction = database.transaction((blockerId, blockedId, now) => {
      const pair = pairKey(blockerId, blockedId);
      this.statements.deleteRequest.run(pair);
      this.statements.deleteFriendship.run(pair);
      this.statements.insertBlock.run(blockerId, blockedId, now);
    });
  }

  profile(userId) {
    const row = this.statements.profileById.get(userId);
    if (!row) return null;
    const expired = row.status_expires_at !== null && row.status_expires_at <= Date.now();
    return {
      ...mapPerson(row),
      presenceMode: row.presence_mode,
      customStatus: expired ? null : row.custom_status,
      statusExpiresAt: expired ? null : row.status_expires_at,
    };
  }

  targetByUsername(username) {
    const row = this.statements.profileByUsername.get(username);
    return row ? mapPerson(row) : null;
  }

  relationshipSnapshot(userId) {
    const mapped = (rows) => rows.map((row) => ({ ...mapPerson(row), since: row.created_at }));
    return {
      friends: mapped(this.statements.listFriends.all({ userId })),
      incomingRequests: mapped(this.statements.listIncoming.all(userId)),
      outgoingRequests: mapped(this.statements.listOutgoing.all(userId)),
      blocked: mapped(this.statements.listBlocked.all(userId)),
    };
  }

  friendIds(userId) {
    return this.statements.friendIds.all(userId, userId, userId).map((row) => row.user_id);
  }

  isBlocked(left, right) {
    return Boolean(this.statements.blockEitherWay.get(left, right, right, left));
  }

  areFriends(left, right) {
    return Boolean(this.statements.friendshipByPair.get(pairKey(left, right)));
  }

  sendRequest(requesterId, recipientId) {
    if (requesterId === recipientId) return { ok: false, error: "cannot-friend-self" };
    const pair = pairKey(requesterId, recipientId);
    if (this.isBlocked(requesterId, recipientId)) return { ok: false, error: "relationship-blocked" };
    if (this.statements.friendshipByPair.get(pair)) return { ok: false, error: "already-friends" };
    const existing = this.statements.requestByPair.get(pair);
    if (existing) return { ok: false, error: existing.requester_id === requesterId ? "request-exists" : "request-awaiting-you" };
    this.statements.insertRequest.run(pair, requesterId, recipientId, Date.now());
    return { ok: true };
  }

  acceptRequest(recipientId, requesterId) {
    return this.acceptTransaction(pairKey(recipientId, requesterId), recipientId, Date.now());
  }

  rejectRequest(recipientId, requesterId) {
    const pair = pairKey(recipientId, requesterId);
    const request = this.statements.requestByPair.get(pair);
    if (!request || request.recipient_id !== recipientId) return false;
    return this.statements.deleteRequest.run(pair).changes > 0;
  }

  cancelRequest(requesterId, recipientId) {
    const pair = pairKey(requesterId, recipientId);
    const request = this.statements.requestByPair.get(pair);
    if (!request || request.requester_id !== requesterId) return false;
    return this.statements.deleteRequest.run(pair).changes > 0;
  }

  removeFriend(userId, peerId) {
    return this.statements.deleteFriendship.run(pairKey(userId, peerId)).changes > 0;
  }

  block(blockerId, blockedId) {
    if (blockerId === blockedId) return false;
    this.blockTransaction(blockerId, blockedId, Date.now());
    return true;
  }

  unblock(blockerId, blockedId) {
    return this.statements.deleteBlock.run(blockerId, blockedId).changes > 0;
  }

  updatePresence(userId, mode, status, expiresAt) {
    this.statements.updatePresence.run({ userId, mode, status, expiresAt, now: Date.now() });
    return this.profile(userId);
  }

  notify({ userId, kind, actorId = null, conversationType = null, conversationId = null, metadata = {} }) {
    const notification = {
      id: randomUUID(), userId, kind, actorId, conversationType, conversationId,
      metadata: JSON.stringify(metadata), now: Date.now(),
    };
    this.statements.insertNotification.run(notification);
    return { ...notification, metadata, at: notification.now, readAt: null };
  }

  notifications(userId, limit = 50) {
    return this.statements.listNotifications.all(userId, limit).map((row) => ({
      id: row.id,
      kind: row.kind,
      actorId: row.actor_id,
      conversationType: row.conversation_type,
      conversationId: row.conversation_id,
      metadata: JSON.parse(row.metadata_json || "{}"),
      readAt: row.read_at,
      at: row.created_at,
    }));
  }

  readNotification(userId, id) {
    return this.statements.readNotification.run(Date.now(), id, userId).changes > 0;
  }

  markRead(userId, type, id, sequence) {
    this.statements.markRead.run({ userId, type, id, sequence, now: Date.now() });
  }

  incrementMention(userId, type, id) {
    this.statements.incrementMention.run({ userId, type, id, now: Date.now() });
  }

  unreadSnapshot(userId, visibleChannelIds) {
    const reads = new Map(this.statements.listReadStates.all(userId).map((row) => [
      `${row.conversation_type}:${row.conversation_id}`,
      { sequence: row.last_read_sequence, mentions: row.mention_count },
    ]));
    const out = {};
    for (const row of this.statements.latestChannelSequences.all()) {
      if (!visibleChannelIds.has(row.id)) continue;
      const read = reads.get(`channel:${row.id}`) ?? { sequence: 0, mentions: 0 };
      out[`channel:${row.id}`] = {
        unread: row.sequence > read.sequence,
        mentions: read.mentions,
        lastReadSequence: read.sequence,
      };
    }
    for (const row of this.statements.latestDirectSequences.all(userId)) {
      const read = reads.get(`direct:${row.id}`) ?? { sequence: 0, mentions: 0 };
      out[`direct:${row.id}`] = {
        unread: row.sequence > read.sequence,
        mentions: read.mentions,
        lastReadSequence: read.sequence,
      };
    }
    return out;
  }

  recordMentions(messageId, guildId, content, { elevated = false, authorId = null } = {}) {
    const targets = [];
    const audience = new Set();
    const tokens = [...content.matchAll(/(^|\s)@([\p{L}\p{N}_.-]{2,32})(?=$|[\s.,!?;:])/gu)]
      .map((match) => match[2]);
    for (const token of new Set(tokens)) {
      if (token.toLowerCase() === "everyone") {
        if (!elevated) continue;
        targets.push({ type: "everyone", id: "" });
        for (const row of this.statements.guildAudience.all(guildId)) audience.add(row.user_id);
        continue;
      }
      const user = this.statements.memberByUsername.get(guildId, token);
      if (user) {
        targets.push({ type: "user", id: user.user_id });
        audience.add(user.user_id);
        continue;
      }
      if (!elevated) continue;
      const role = this.statements.roleByName.get(guildId, token);
      if (!role) continue;
      targets.push({ type: "role", id: role.id });
      for (const row of this.statements.roleAudience.all(guildId, role.id)) audience.add(row.user_id);
    }
    this.database.transaction(() => {
      for (const target of targets) this.statements.insertMention.run(messageId, target.type, target.id);
    })();
    if (authorId) audience.delete(authorId);
    return { targets, userIds: [...audience] };
  }
}
