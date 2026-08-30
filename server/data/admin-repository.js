import { randomUUID } from "node:crypto";
import { GUILD_PERMISSIONS } from "../permissions.js";

const parsePermissions = (value) => {
  try {
    const parsed = JSON.parse(value || "[]");
    return Array.isArray(parsed) ? parsed.filter((item) => GUILD_PERMISSIONS.includes(item)) : [];
  } catch {
    return [];
  }
};

export class AdminRepository {
  constructor(database) {
    this.database = database;
    this.statements = {
      guildOwner: database.prepare("SELECT owner_id FROM guilds WHERE id = ?"),
      highestRole: database.prepare(`
        SELECT MAX(r.position) AS position FROM guild_member_roles gmr
        JOIN roles r ON r.id = gmr.role_id
        WHERE gmr.guild_id = ? AND gmr.user_id = ? AND r.is_default = 0
      `),
      role: database.prepare("SELECT id, position, is_default FROM roles WHERE guild_id = ? AND id = ?"),
      removeMember: database.prepare("DELETE FROM guild_members WHERE guild_id = ? AND user_id = ?"),
      setTimeout: database.prepare(`
        INSERT INTO member_timeouts (guild_id, user_id, moderator_user_id, reason, expires_at, created_at)
        VALUES (@guildId, @userId, @moderatorId, @reason, @expiresAt, @now)
        ON CONFLICT(guild_id, user_id) DO UPDATE SET moderator_user_id = excluded.moderator_user_id,
          reason = excluded.reason, expires_at = excluded.expires_at, created_at = excluded.created_at
      `),
      removeTimeout: database.prepare("DELETE FROM member_timeouts WHERE guild_id = ? AND user_id = ?"),
      getTimeout: database.prepare("SELECT expires_at FROM member_timeouts WHERE guild_id = ? AND user_id = ?"),
      listTimeouts: database.prepare(`
        SELECT t.user_id, p.username, t.reason, t.expires_at, t.created_at
        FROM member_timeouts t LEFT JOIN profiles p ON p.user_id = t.user_id
        WHERE t.guild_id = ? AND t.expires_at > ? ORDER BY t.expires_at
      `),
      listOverwrites: database.prepare(`
        SELECT target_type, target_id, allow_permissions_json, deny_permissions_json, updated_at
        FROM channel_permission_overwrites WHERE channel_id = ? ORDER BY target_type, target_id
      `),
      upsertOverwrite: database.prepare(`
        INSERT INTO channel_permission_overwrites (
          channel_id, target_type, target_id, allow_permissions_json,
          deny_permissions_json, updated_at
        ) VALUES (@channelId, @targetType, @targetId, @allow, @deny, @now)
        ON CONFLICT(channel_id, target_type, target_id) DO UPDATE SET
          allow_permissions_json = excluded.allow_permissions_json,
          deny_permissions_json = excluded.deny_permissions_json,
          updated_at = excluded.updated_at
      `),
      deleteOverwrite: database.prepare(`
        DELETE FROM channel_permission_overwrites WHERE channel_id = ? AND target_type = ? AND target_id = ?
      `),
      memberRoleIds: database.prepare("SELECT role_id FROM guild_member_roles WHERE guild_id = ? AND user_id = ?"),
      auditInsert: database.prepare(`
        INSERT INTO audit_log (id, guild_id, actor_id, action, target_type, target_id, metadata_json, created_at)
        VALUES (@id, @guildId, @actorId, @action, @targetType, @targetId, @metadata, @now)
      `),
      auditList: database.prepare(`
        SELECT l.id, l.actor_id, p.username AS actor_username, l.action,
          l.target_type, l.target_id, l.metadata_json, l.created_at
        FROM audit_log l LEFT JOIN profiles p ON p.user_id = l.actor_id
        WHERE l.guild_id = ? AND (? IS NULL OR l.action = ?)
        ORDER BY l.created_at DESC, l.id DESC LIMIT ?
      `),
    };
  }

  hierarchy(guildId, userId) {
    const owner = this.statements.guildOwner.get(guildId)?.owner_id;
    if (owner === userId) return Number.POSITIVE_INFINITY;
    return this.statements.highestRole.get(guildId, userId)?.position ?? 0;
  }

  canActOn(guildId, actorId, targetId, { systemAdmin = false } = {}) {
    if (systemAdmin) return true;
    const owner = this.statements.guildOwner.get(guildId)?.owner_id;
    if (targetId === owner) return false;
    if (actorId === owner) return true;
    return this.hierarchy(guildId, actorId) > this.hierarchy(guildId, targetId);
  }

  canManageRole(guildId, actorId, roleId, { systemAdmin = false } = {}) {
    const role = this.statements.role.get(guildId, roleId);
    if (!role || role.is_default) return false;
    return systemAdmin || this.hierarchy(guildId, actorId) > role.position;
  }

  kick(guildId, userId) {
    return this.statements.removeMember.run(guildId, userId).changes > 0;
  }

  timeout(guildId, userId, moderatorId, durationMs, reason) {
    const expiresAt = Date.now() + durationMs;
    this.statements.setTimeout.run({ guildId, userId, moderatorId, reason, expiresAt, now: Date.now() });
    return expiresAt;
  }

  removeTimeout(guildId, userId) {
    return this.statements.removeTimeout.run(guildId, userId).changes > 0;
  }

  isTimedOut(guildId, userId) {
    const row = this.statements.getTimeout.get(guildId, userId);
    if (!row) return false;
    if (row.expires_at > Date.now()) return true;
    this.statements.removeTimeout.run(guildId, userId);
    return false;
  }

  timeouts(guildId) {
    return this.statements.listTimeouts.all(guildId, Date.now()).map((row) => ({
      userId: row.user_id, username: row.username, reason: row.reason,
      expiresAt: row.expires_at, createdAt: row.created_at,
    }));
  }

  overwrites(channelId) {
    return this.statements.listOverwrites.all(channelId).map((row) => ({
      targetType: row.target_type,
      targetId: row.target_id,
      allow: parsePermissions(row.allow_permissions_json),
      deny: parsePermissions(row.deny_permissions_json),
      updatedAt: row.updated_at,
    }));
  }

  setOverwrite(channelId, targetType, targetId, allow, deny) {
    if (!allow.length && !deny.length) {
      this.statements.deleteOverwrite.run(channelId, targetType, targetId);
      return;
    }
    this.statements.upsertOverwrite.run({
      channelId, targetType, targetId,
      allow: JSON.stringify(allow), deny: JSON.stringify(deny), now: Date.now(),
    });
  }

  resolveChannelPermissions(channelId, guildId, userId, basePermissions) {
    const effective = new Set(basePermissions);
    const roleIds = new Set(this.statements.memberRoleIds.all(guildId, userId).map((row) => row.role_id));
    const overwrites = this.overwrites(channelId);
    const defaultRole = `${guildId}:everyone`;
    const ordered = [
      ...overwrites.filter((item) => item.targetType === "role" && item.targetId === defaultRole),
      ...overwrites.filter((item) => item.targetType === "role" && roleIds.has(item.targetId) && item.targetId !== defaultRole),
      ...overwrites.filter((item) => item.targetType === "member" && item.targetId === userId),
    ];
    for (const overwrite of ordered) {
      for (const permission of overwrite.deny) effective.delete(permission);
      for (const permission of overwrite.allow) effective.add(permission);
    }
    return [...effective];
  }

  audit(guildId, actorId, action, targetType = null, targetId = null, metadata = {}) {
    const entry = {
      id: randomUUID(), guildId, actorId, action, targetType, targetId,
      metadata: JSON.stringify(metadata), now: Date.now(),
    };
    this.statements.auditInsert.run(entry);
    return entry.id;
  }

  auditLog(guildId, { action = null, limit = 100 } = {}) {
    return this.statements.auditList.all(guildId, action, action, Math.min(100, Math.max(1, limit))).map((row) => ({
      id: row.id,
      actorId: row.actor_id,
      actorUsername: row.actor_username,
      action: row.action,
      targetType: row.target_type,
      targetId: row.target_id,
      metadata: JSON.parse(row.metadata_json || "{}"),
      at: row.created_at,
    }));
  }
}
