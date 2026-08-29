import { openDatabase } from "./database.js";

/**
 * Todo o SQL do estado vive aqui. O resto do servidor conversa com objetos no
 * formato que vai pro socket, então trocar uma consulta ou o próprio banco não
 * espalha mudança pela sinalização.
 *
 * As consultas de mensagem ordenam por `sequence`, não por `created_at`: o
 * horário vem de `Date.now()` na máquina que recebeu a mensagem, e um ajuste de
 * relógio (ou um deploy numa máquina com hora diferente) embaralharia a conversa.
 * `sequence` é a ordem real de chegada e nunca anda pra trás.
 */

const DEFAULT_PERMISSIONS = ["view_channels", "send_messages", "connect", "speak"];

function mapGuild(row) {
  return {
    id: row.id,
    name: row.name,
    initials: row.initials,
    color: row.color,
    // `null` só num servidor que ficou sem ninguém: o dono é apagado por
    // `ON DELETE SET NULL`, e daí ninguém mais o administra.
    ownerId: row.owner_id ?? null,
  };
}

function mapChannel(row) {
  return {
    id: row.id,
    guildId: row.guild_id,
    type: row.type,
    name: row.name,
    category: row.category,
  };
}

function mapMessage(row) {
  return {
    id: row.id,
    channelId: row.channel_id,
    authorId: row.author_id,
    username: row.username_snapshot,
    color: row.color_snapshot,
    content: row.content,
    at: row.created_at,
  };
}

export class StateRepository {
  constructor(database) {
    this.database = database;
    this.statements = {
      listGuilds: database.prepare(`
        SELECT id, name, initials, color, owner_id
        FROM guilds
        ORDER BY position, id
      `),
      listChannels: database.prepare(`
        SELECT id, guild_id, type, name, category
        FROM channels
        ORDER BY position, id
      `),
      // As mais recentes de cada canal numa consulta só, pra hidratar a memória
      // no boot sem uma ida ao banco por canal.
      listMessages: database.prepare(`
        WITH ranked AS (
          SELECT
            sequence,
            id,
            channel_id,
            author_id,
            username_snapshot,
            color_snapshot,
            content,
            created_at,
            ROW_NUMBER() OVER (
              PARTITION BY channel_id
              ORDER BY sequence DESC
            ) AS row_number
          FROM messages
          WHERE deleted_at IS NULL
        )
        SELECT
          sequence,
          id,
          channel_id,
          author_id,
          username_snapshot,
          color_snapshot,
          content,
          created_at
        FROM ranked
        WHERE row_number <= ?
        ORDER BY channel_id, sequence
      `),
      messageSequence: database.prepare(`
        SELECT sequence
        FROM messages
        WHERE id = ? AND channel_id = ? AND deleted_at IS NULL
      `),
      listMessagesBefore: database.prepare(`
        SELECT
          sequence,
          id,
          channel_id,
          author_id,
          username_snapshot,
          color_snapshot,
          content,
          created_at
        FROM messages
        WHERE channel_id = ? AND deleted_at IS NULL AND sequence < ?
        ORDER BY sequence DESC
        LIMIT ?
      `),
      insertDefaultRole: database.prepare(`
        INSERT INTO roles (
          id,
          guild_id,
          name,
          position,
          permissions_json,
          is_default,
          created_at,
          updated_at
        )
        VALUES (@id, @guildId, '@everyone', 0, @permissions, 1, @now, @now)
        ON CONFLICT(id) DO NOTHING
      `),
      insertChannel: database.prepare(`
        INSERT INTO channels (
          id,
          guild_id,
          type,
          name,
          category,
          position,
          created_at,
          updated_at
        )
        VALUES (@id, @guildId, @type, @name, @category, @position, @now, @now)
        ON CONFLICT(id) DO NOTHING
      `),
      upsertUser: database.prepare(`
        INSERT INTO users (id, created_at, updated_at)
        VALUES (@id, @now, @now)
        ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at
      `),
      upsertProfile: database.prepare(`
        INSERT INTO profiles (user_id, username, color, updated_at)
        VALUES (@id, @username, @color, @now)
        ON CONFLICT(user_id) DO UPDATE SET
          username = excluded.username,
          color = excluded.color,
          updated_at = excluded.updated_at
      `),
      upsertGuildMember: database.prepare(`
        INSERT INTO guild_members (guild_id, user_id, joined_at, updated_at)
        VALUES (@guildId, @userId, @now, @now)
        ON CONFLICT(guild_id, user_id) DO UPDATE SET updated_at = excluded.updated_at
      `),
      assignDefaultRole: database.prepare(`
        INSERT INTO guild_member_roles (guild_id, user_id, role_id, assigned_at)
        SELECT @guildId, @userId, id, @now
        FROM roles
        WHERE guild_id = @guildId AND is_default = 1
        ON CONFLICT(guild_id, user_id, role_id) DO NOTHING
      `),
      insertMessage: database.prepare(`
        INSERT INTO messages (
          id,
          channel_id,
          author_id,
          username_snapshot,
          color_snapshot,
          content,
          created_at
        )
        VALUES (@id, @channelId, @authorId, @username, @color, @content, @at)
      `),
      pruneMessages: database.prepare(`
        DELETE FROM messages
        WHERE id IN (
          SELECT id
          FROM messages
          WHERE channel_id = ?
          ORDER BY sequence DESC
          LIMIT -1 OFFSET ?
        )
      `),
      readSetting: database.prepare("SELECT value_json FROM app_settings WHERE setting_key = ?"),
      writeSetting: database.prepare(`
        INSERT INTO app_settings (setting_key, value_json, updated_at)
        VALUES (@key, @value, @now)
        ON CONFLICT(setting_key) DO UPDATE SET
          value_json = excluded.value_json,
          updated_at = excluded.updated_at
      `),

      // --- associação a servidores -------------------------------------------
      listGuildsForUser: database.prepare(`
        SELECT g.id, g.name, g.initials, g.color, g.owner_id AS owner_id
        FROM guilds g
        JOIN guild_members gm ON gm.guild_id = g.id
        WHERE gm.user_id = ?
        ORDER BY g.position, g.id
      `),
      // Quem pertence ao servidor, esteja conectado ou não. É daqui que sai a
      // parte "offline" da lista de membros: presença vem da memória, o elenco
      // vem do banco.
      listGuildRoster: database.prepare(`
        SELECT p.user_id, p.username, p.color
        FROM guild_members gm
        JOIN profiles p ON p.user_id = gm.user_id
        WHERE gm.guild_id = ?
        ORDER BY gm.joined_at, p.username
      `),
      deleteGuildMember: database.prepare(
        "DELETE FROM guild_members WHERE guild_id = ? AND user_id = ?",
      ),
      nextGuildPosition: database.prepare(
        "SELECT COALESCE(MAX(position), -1) + 1 AS position FROM guilds",
      ),
      insertOwnedGuild: database.prepare(`
        INSERT INTO guilds (id, owner_id, name, initials, color, position, created_at, updated_at)
        VALUES (@id, @ownerId, @name, @initials, @color, @position, @now, @now)
      `),

      // --- canais -------------------------------------------------------------
      nextChannelPosition: database.prepare(
        "SELECT COALESCE(MAX(position), -1) + 1 AS position FROM channels WHERE guild_id = ?",
      ),
      deleteChannel: database.prepare("DELETE FROM channels WHERE id = ?"),
      countChannelsOfType: database.prepare(
        "SELECT COUNT(*) AS total FROM channels WHERE guild_id = ? AND type = ?",
      ),

      // --- convites -----------------------------------------------------------
      insertInvite: database.prepare(`
        INSERT INTO invites (code, guild_id, channel_id, inviter_user_id, max_uses, expires_at, created_at)
        VALUES (@code, @guildId, @channelId, @inviterId, @maxUses, @expiresAt, @now)
      `),
      findInvite: database.prepare(`
        SELECT code, guild_id, inviter_user_id, max_uses, uses, expires_at, revoked_at
        FROM invites
        WHERE code = ?
      `),
      bumpInviteUses: database.prepare("UPDATE invites SET uses = uses + 1 WHERE code = ?"),
      revokeInvite: database.prepare(
        "UPDATE invites SET revoked_at = ? WHERE code = ? AND guild_id = ? AND revoked_at IS NULL",
      ),
      listInvites: database.prepare(`
        SELECT code, guild_id, inviter_user_id, max_uses, uses, expires_at, created_at
        FROM invites
        WHERE guild_id = ? AND revoked_at IS NULL
        ORDER BY created_at DESC
      `),

      // --- bans ---------------------------------------------------------------
      insertBan: database.prepare(`
        INSERT INTO bans (guild_id, user_id, moderator_user_id, reason, created_at)
        VALUES (@guildId, @userId, @moderatorId, @reason, @now)
        ON CONFLICT(guild_id, user_id) DO UPDATE SET
          moderator_user_id = excluded.moderator_user_id,
          reason = excluded.reason,
          created_at = excluded.created_at
      `),
      deleteBan: database.prepare("DELETE FROM bans WHERE guild_id = ? AND user_id = ?"),
      findBan: database.prepare(
        "SELECT guild_id, user_id, expires_at FROM bans WHERE guild_id = ? AND user_id = ?",
      ),
      listBans: database.prepare(`
        SELECT b.guild_id, b.user_id, b.reason, b.created_at, p.username
        FROM bans b
        LEFT JOIN profiles p ON p.user_id = b.user_id
        WHERE b.guild_id = ?
        ORDER BY b.created_at DESC
      `),
    };

    this.saveProfileTransaction = database.transaction((profile, now) => {
      this.statements.upsertUser.run({ id: profile.id, now });
      this.statements.upsertProfile.run({ ...profile, now });
    });

    this.addMessageTransaction = database.transaction((message, retention) => {
      this.statements.insertMessage.run(message);
      this.statements.pruneMessages.run(message.channelId, retention);
    });

    /**
     * Servidor novo nasce com dono, cargo padrão, um canal de texto e um de voz.
     * Numa transação só porque um servidor sem canal nenhum é um estado que a
     * interface não sabe desenhar: melhor não existir do que existir pela metade.
     */
    this.createGuildTransaction = database.transaction((guild, channels, now) => {
      this.statements.insertOwnedGuild.run({
        ...guild,
        position: this.statements.nextGuildPosition.get().position,
        now,
      });
      this.statements.insertDefaultRole.run({
        id: `${guild.id}:everyone`,
        guildId: guild.id,
        permissions: JSON.stringify(DEFAULT_PERMISSIONS),
        now,
      });
      for (const [position, channel] of channels.entries()) {
        this.statements.insertChannel.run({ ...channel, guildId: guild.id, position, now });
      }
      this.statements.upsertGuildMember.run({ guildId: guild.id, userId: guild.ownerId, now });
      this.statements.assignDefaultRole.run({ guildId: guild.id, userId: guild.ownerId, now });
    });

    /**
     * Aceitar convite: entra no servidor e gasta um uso. Junto porque o contador
     * é o que impede um convite de uso único de virar dois, e conferir antes de
     * gravar não bastaria — duas pessoas colando o mesmo código no mesmo instante
     * passariam as duas.
     */
    this.acceptInviteTransaction = database.transaction((code, userId, now) => {
      const invite = this.statements.findInvite.get(code);
      if (!invite || invite.revoked_at) return { ok: false, error: "invite-invalid" };
      if (invite.expires_at !== null && invite.expires_at <= now) {
        return { ok: false, error: "invite-expired" };
      }
      if (invite.max_uses !== null && invite.uses >= invite.max_uses) {
        return { ok: false, error: "invite-used-up" };
      }
      if (this.statements.findBan.get(invite.guild_id, userId)) {
        return { ok: false, error: "banned" };
      }

      // Já era membro: o convite não é gasto. Colar o link duas vezes não deveria
      // consumir um uso que outra pessoa poderia aproveitar.
      const already = this.statements.listGuildsForUser
        .all(userId)
        .some((row) => row.id === invite.guild_id);
      if (!already) {
        this.statements.upsertGuildMember.run({ guildId: invite.guild_id, userId, now });
        this.statements.assignDefaultRole.run({ guildId: invite.guild_id, userId, now });
        this.statements.bumpInviteUses.run(code);
      }
      return { ok: true, guildId: invite.guild_id, joined: !already };
    });

    /** Banir tira do servidor e registra o banimento: as duas coisas ou nenhuma. */
    this.banTransaction = database.transaction((ban, now) => {
      this.statements.insertBan.run({ ...ban, now });
      this.statements.deleteGuildMember.run(ban.guildId, ban.userId);
    });
  }

  listGuilds() {
    return this.statements.listGuilds.all().map(mapGuild);
  }

  listChannels() {
    return this.statements.listChannels.all().map(mapChannel);
  }

  listMessages(historyLimit) {
    return this.statements.listMessages.all(historyLimit).map(mapMessage);
  }

  /**
   * Página anterior a uma mensagem conhecida. Ancorar num id, e não num
   * deslocamento, é o que impede a página seguinte de repetir ou pular linhas
   * quando alguém manda mensagem no meio da rolagem.
   *
   * Devolve `null` quando o id não é daquele canal: o cliente pediu por algo que
   * não existe, e responder uma página qualquer esconderia o descompasso.
   */
  listMessagesBefore(channelId, beforeId, limit) {
    const anchor = this.statements.messageSequence.get(beforeId, channelId);
    if (!anchor) return null;
    // Um a mais que o pedido: a diferença é o que diz se ainda há passado.
    const rows = this.statements.listMessagesBefore.all(channelId, anchor.sequence, limit + 1);
    return {
      messages: rows.slice(0, limit).reverse().map(mapMessage),
      more: rows.length > limit,
    };
  }

  saveProfile(profile) {
    this.saveProfileTransaction(profile, Date.now());
  }

  /**
   * Configuração do servidor, guardada como JSON. `undefined` quando a chave não
   * existe, o que é diferente de um valor `null` gravado de propósito.
   */
  readSetting(key) {
    const row = this.statements.readSetting.get(key);
    if (!row) return undefined;
    try {
      return JSON.parse(row.value_json);
    } catch {
      return undefined;
    }
  }

  writeSetting(key, value) {
    this.statements.writeSetting.run({
      key,
      value: JSON.stringify(value),
      now: Date.now(),
    });
  }

  addMessage(message, retention) {
    this.addMessageTransaction(message, retention);
  }

  // --- servidores ------------------------------------------------------------

  /** Servidores de que esta pessoa é membro. Vazio para quem acabou de chegar. */
  listGuildsForUser(userId) {
    return this.statements.listGuildsForUser.all(userId).map(mapGuild);
  }

  /**
   * Todo mundo que pertence ao servidor. Presença não entra aqui: quem está
   * conectado agora está na memória, e juntar as duas coisas é trabalho de quem
   * monta o snapshot.
   */
  listGuildRoster(guildId) {
    return this.statements.listGuildRoster.all(guildId).map((row) => ({
      id: row.user_id,
      username: row.username,
      color: row.color,
    }));
  }

  createGuild(guild, channels) {
    this.createGuildTransaction(guild, channels, Date.now());
  }

  isMember(guildId, userId) {
    return this.statements.listGuildsForUser.all(userId).some((row) => row.id === guildId);
  }

  isOwner(guildId, userId) {
    return this.statements.listGuildsForUser
      .all(userId)
      .some((row) => row.id === guildId && row.owner_id === userId);
  }

  leaveGuild(guildId, userId) {
    this.statements.deleteGuildMember.run(guildId, userId);
  }

  // --- canais ----------------------------------------------------------------

  createChannel(channel) {
    this.statements.insertChannel.run({
      ...channel,
      position: this.statements.nextChannelPosition.get(channel.guildId).position,
      now: Date.now(),
    });
  }

  /** Quantos canais daquele tipo o servidor tem. Serve pra não deixar chegar a zero. */
  countChannelsOfType(guildId, type) {
    return this.statements.countChannelsOfType.get(guildId, type).total;
  }

  deleteChannel(channelId) {
    this.statements.deleteChannel.run(channelId);
  }

  // --- convites --------------------------------------------------------------

  createInvite(invite) {
    this.statements.insertInvite.run({ ...invite, now: Date.now() });
  }

  acceptInvite(code, userId) {
    return this.acceptInviteTransaction(code, userId, Date.now());
  }

  revokeInvite(guildId, code) {
    return this.statements.revokeInvite.run(Date.now(), code, guildId).changes > 0;
  }

  listInvites(guildId) {
    return this.statements.listInvites.all(guildId).map((row) => ({
      code: row.code,
      guildId: row.guild_id,
      inviterId: row.inviter_user_id,
      maxUses: row.max_uses,
      uses: row.uses,
      expiresAt: row.expires_at,
      createdAt: row.created_at,
    }));
  }

  // --- bans ------------------------------------------------------------------

  ban(ban) {
    this.banTransaction(ban, Date.now());
  }

  /** Banimento vencido não vale: o prazo é conferido na leitura, não por rotina. */
  isBanned(guildId, userId) {
    const ban = this.statements.findBan.get(guildId, userId);
    if (!ban) return false;
    if (ban.expires_at !== null && ban.expires_at <= Date.now()) {
      this.statements.deleteBan.run(guildId, userId);
      return false;
    }
    return true;
  }

  unban(guildId, userId) {
    return this.statements.deleteBan.run(guildId, userId).changes > 0;
  }

  listBans(guildId) {
    return this.statements.listBans.all(guildId).map((row) => ({
      userId: row.user_id,
      username: row.username,
      reason: row.reason,
      createdAt: row.created_at,
    }));
  }

  close() {
    this.database.close();
  }
}

export function createStateRepository(options = {}) {
  return new StateRepository(openDatabase(options.databasePath));
}
