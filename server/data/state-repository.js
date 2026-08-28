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

/** Marca que o catálogo padrão já foi criado neste banco. */
const CATALOG_SEEDED = "catalog:seeded_at";

function mapGuild(row) {
  return { id: row.id, name: row.name, initials: row.initials, color: row.color };
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
        SELECT id, name, initials, color
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
      insertGuild: database.prepare(`
        INSERT INTO guilds (id, name, initials, color, position, created_at, updated_at)
        VALUES (@id, @name, @initials, @color, @position, @now, @now)
        ON CONFLICT(id) DO NOTHING
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
    };

    this.seedCatalogTransaction = database.transaction((guilds, channels, now) => {
      // A marca é o que faz o seed acontecer uma vez na vida do banco. Sem ela,
      // apagar um canal seria inútil: o próximo boot o inseriria de novo.
      if (this.statements.readSetting.get(CATALOG_SEEDED)) return;

      for (const [position, guild] of guilds.entries()) {
        this.statements.insertGuild.run({ ...guild, position, now });
        this.statements.insertDefaultRole.run({
          id: `${guild.id}:everyone`,
          guildId: guild.id,
          permissions: JSON.stringify(DEFAULT_PERMISSIONS),
          now,
        });
      }
      for (const [position, channel] of channels.entries()) {
        this.statements.insertChannel.run({ ...channel, position, now });
      }
      this.statements.writeSetting.run({ key: CATALOG_SEEDED, value: JSON.stringify(now), now });
    });

    this.saveProfileTransaction = database.transaction((profile, guildIds, now) => {
      this.statements.upsertUser.run({ id: profile.id, now });
      this.statements.upsertProfile.run({ ...profile, now });
      for (const guildId of guildIds) {
        this.statements.upsertGuildMember.run({ guildId, userId: profile.id, now });
        this.statements.assignDefaultRole.run({ guildId, userId: profile.id, now });
      }
    });

    this.addMessageTransaction = database.transaction((message, retention) => {
      this.statements.insertMessage.run(message);
      this.statements.pruneMessages.run(message.channelId, retention);
    });
  }

  seedCatalog(guilds, channels) {
    this.seedCatalogTransaction(guilds, channels, Date.now());
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

  saveProfile(profile, guildIds) {
    this.saveProfileTransaction(profile, guildIds, Date.now());
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

  close() {
    this.database.close();
  }
}

export function createStateRepository(options = {}) {
  return new StateRepository(openDatabase(options.databasePath));
}
