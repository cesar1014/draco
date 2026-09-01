import { randomUUID } from "node:crypto";
import { openDatabase } from "./database.js";

function mapAccount(row) {
  if (!row) return null;
  const displayName = row.display_name || row.username;
  return {
    userId: row.user_id,
    email: row.email,
    // `username` continua como alias do nome exibido para clientes antigos.
    username: displayName,
    displayName,
    publicId: row.username,
    passwordHash: row.password_hash,
    emailVerifiedAt: row.email_verified_at,
    isSystemAdmin: row.is_system_admin === 1,
    sessionVersion: row.session_version,
    disabledAt: row.disabled_at ?? null,
    createdAt: row.created_at,
  };
}

export class AccountRepository {
  constructor(database) {
    this.database = database;
    this.cipher = database.dracoFieldCipher;
    this.statements = {
      accountByEmail: database.prepare(`
        SELECT a.*, u.disabled_at, COALESCE(p.display_name, p.username, a.username) AS display_name
        FROM accounts a
        JOIN users u ON u.id = a.user_id
        LEFT JOIN profiles p ON p.user_id = a.user_id
        WHERE a.email = ? COLLATE NOCASE
      `),
      accountByPublicId: database.prepare(`
        SELECT a.*, u.disabled_at, COALESCE(p.display_name, p.username, a.username) AS display_name
        FROM accounts a
        JOIN users u ON u.id = a.user_id
        LEFT JOIN profiles p ON p.user_id = a.user_id
        WHERE a.username = ? COLLATE NOCASE
      `),
      accountById: database.prepare(`
        SELECT a.*, u.disabled_at, COALESCE(p.display_name, p.username, a.username) AS display_name
        FROM accounts a
        JOIN users u ON u.id = a.user_id
        LEFT JOIN profiles p ON p.user_id = a.user_id
        WHERE a.user_id = ?
      `),
      deletePendingAccount: database.prepare(`
        DELETE FROM users
        WHERE id = @userId
          AND EXISTS (
            SELECT 1 FROM accounts a
            WHERE a.user_id = users.id
              AND a.email_verified_at IS NULL
              AND a.is_system_admin = 0
          )
      `),
      deleteExpiredPendingAccounts: database.prepare(`
        DELETE FROM users
        WHERE id IN (
          SELECT a.user_id
          FROM accounts a
          WHERE a.email_verified_at IS NULL
            AND a.is_system_admin = 0
            AND a.created_at <= @cutoff
        )
      `),
      insertUser: database.prepare(`
        INSERT INTO users (id, created_at, updated_at) VALUES (@userId, @now, @now)
      `),
      insertProfile: database.prepare(`
        INSERT INTO profiles (user_id, username, display_name, color, updated_at)
        VALUES (@userId, @displayName, @displayName, @color, @now)
      `),
      insertAccount: database.prepare(`
        INSERT INTO accounts (
          user_id, email, username, password_hash, email_verified_at,
          is_system_admin, session_version, created_at, updated_at
        ) VALUES (
          @userId, @email, @publicId, @passwordHash, @verifiedAt,
          @isSystemAdmin, 1, @now, @now
        )
      `),
      updateAccountPublicId: database.prepare(`
        UPDATE accounts SET username = @publicId, updated_at = @now WHERE user_id = @userId
      `),
      updateProfileIdentity: database.prepare(`
        UPDATE profiles
        SET username = @displayName, display_name = @displayName,
            color = @color, updated_at = @now
        WHERE user_id = @userId
      `),
      insertToken: database.prepare(`
        INSERT INTO account_tokens (token_hash, user_id, purpose, expires_at, created_at)
        VALUES (@tokenHash, @userId, @purpose, @expiresAt, @now)
      `),
      expireTokens: database.prepare(`
        UPDATE account_tokens SET used_at = @now
        WHERE user_id = @userId AND purpose = @purpose AND used_at IS NULL
      `),
      tokenByHash: database.prepare(`
        SELECT token_hash, user_id, purpose, expires_at, used_at
        FROM account_tokens WHERE token_hash = ?
      `),
      consumeToken: database.prepare(`
        UPDATE account_tokens SET used_at = ? WHERE token_hash = ? AND used_at IS NULL
      `),
      verifyEmail: database.prepare(`
        UPDATE accounts SET email_verified_at = COALESCE(email_verified_at, @now), updated_at = @now
        WHERE user_id = @userId
      `),
      setPassword: database.prepare(`
        UPDATE accounts
        SET password_hash = @passwordHash,
            email_verified_at = COALESCE(email_verified_at, @now),
            session_version = session_version + 1,
            updated_at = @now
        WHERE user_id = @userId
      `),
      makeSystemAdmin: database.prepare(`
        UPDATE accounts SET is_system_admin = 1, updated_at = ? WHERE user_id = ?
      `),
      trustAddress: database.prepare(`
        INSERT INTO account_trusted_addresses (
          user_id, address_hash, trusted_at, last_used_at
        ) VALUES (@userId, @addressHash, @now, @now)
        ON CONFLICT(user_id, address_hash) DO UPDATE SET last_used_at = excluded.last_used_at
      `),
      trimTrustedAddresses: database.prepare(`
        DELETE FROM account_trusted_addresses
        WHERE user_id = @userId
          AND address_hash NOT IN (
            SELECT address_hash FROM account_trusted_addresses
            WHERE user_id = @userId
            ORDER BY last_used_at DESC
            LIMIT 20
          )
      `),
      expireLoginChallenges: database.prepare(`
        UPDATE account_login_challenges SET used_at = @now
        WHERE user_id = @userId AND used_at IS NULL
      `),
      insertLoginChallenge: database.prepare(`
        INSERT INTO account_login_challenges (
          token_hash, user_id, address_hash, expires_at, created_at,
          device_id, device_credential_hash, client_type, device_name
        ) VALUES (
          @tokenHash, @userId, @addressHash, @expiresAt, @now,
          @deviceId, @deviceCredentialHash, @clientType, @deviceName
        )
      `),
      loginChallenge: database.prepare(`
        SELECT token_hash, user_id, address_hash, expires_at, used_at,
               device_id, device_credential_hash, client_type, device_name
        FROM account_login_challenges WHERE token_hash = ?
      `),
      consumeLoginChallenge: database.prepare(`
        UPDATE account_login_challenges SET used_at = @now
        WHERE token_hash = @tokenHash AND used_at IS NULL AND expires_at > @now
      `),
      cleanLoginChallenges: database.prepare(`
        DELETE FROM account_login_challenges
        WHERE expires_at < @cutoff OR (used_at IS NOT NULL AND used_at < @cutoff)
      `),
      sharedGuild: database.prepare(`
        SELECT 1
        FROM guild_members mine
        JOIN guild_members theirs ON theirs.guild_id = mine.guild_id
        WHERE mine.user_id = ? AND theirs.user_id = ?
        LIMIT 1
      `),
      insertThread: database.prepare(`
        INSERT INTO direct_threads (id, pair_key, created_at, updated_at)
        VALUES (@id, @pairKey, @now, @now)
        ON CONFLICT(pair_key) DO UPDATE SET updated_at = direct_threads.updated_at
      `),
      threadByPair: database.prepare("SELECT id FROM direct_threads WHERE pair_key = ?"),
      addParticipant: database.prepare(`
        INSERT INTO direct_participants (thread_id, user_id, joined_at)
        VALUES (?, ?, ?)
        ON CONFLICT(thread_id, user_id) DO NOTHING
      `),
      listThreads: database.prepare(`
        SELECT
          t.id,
          t.updated_at,
          a.user_id AS peer_id,
          COALESCE(p.display_name, p.username) AS peer_username,
          a.username AS peer_public_id,
          p.color AS peer_color,
          (
            SELECT dm.content FROM direct_messages dm
            WHERE dm.thread_id = t.id AND dm.deleted_at IS NULL
            ORDER BY dm.sequence DESC LIMIT 1
          ) AS last_content,
          (
            SELECT dm.id FROM direct_messages dm
            WHERE dm.thread_id = t.id AND dm.deleted_at IS NULL
            ORDER BY dm.sequence DESC LIMIT 1
          ) AS last_message_id,
          (
            SELECT dm.created_at FROM direct_messages dm
            WHERE dm.thread_id = t.id AND dm.deleted_at IS NULL
            ORDER BY dm.sequence DESC LIMIT 1
          ) AS last_at
        FROM direct_participants me
        JOIN direct_threads t ON t.id = me.thread_id
        JOIN direct_participants other ON other.thread_id = t.id
        JOIN accounts a ON a.user_id = other.user_id
        JOIN profiles p ON p.user_id = other.user_id
        WHERE me.user_id = @userId
          AND (
            other.user_id != @userId
            OR NOT EXISTS (
              SELECT 1 FROM direct_participants third
              WHERE third.thread_id = t.id AND third.user_id != @userId
            )
          )
        ORDER BY COALESCE(last_at, t.updated_at) DESC
      `),
      isParticipant: database.prepare(`
        SELECT 1 FROM direct_participants WHERE thread_id = ? AND user_id = ?
      `),
      participants: database.prepare(`
        SELECT user_id FROM direct_participants WHERE thread_id = ? ORDER BY user_id
      `),
      listDirectMessages: database.prepare(`
        SELECT dm.sequence, dm.id, dm.thread_id, dm.author_id, dm.content, dm.created_at,
               dm.edited_at, dm.deleted_at, dm.reply_to_id,
               COALESCE(p.display_name, p.username) AS username, p.color
        FROM direct_messages dm
        JOIN accounts a ON a.user_id = dm.author_id
        JOIN profiles p ON p.user_id = dm.author_id
        WHERE dm.thread_id = ?
        ORDER BY dm.sequence DESC LIMIT ?
      `),
      insertDirectMessage: database.prepare(`
        INSERT INTO direct_messages (id, thread_id, author_id, content, reply_to_id, created_at)
        VALUES (@id, @threadId, @authorId, @content, @replyToId, @now)
      `),
      touchThread: database.prepare("UPDATE direct_threads SET updated_at = ? WHERE id = ?"),
      insertSession: database.prepare(`
        INSERT INTO account_sessions (
          id, user_id, token_hash, client_type, device_name, device_id,
          created_at, last_seen_at, expires_at
        ) VALUES (@id, @userId, @tokenHash, @clientType, @deviceName, @deviceId, @now, @now, @expiresAt)
      `),
      activeSession: database.prepare(`
        SELECT id, user_id, client_type, device_name, device_id, created_at, last_seen_at, expires_at
        FROM account_sessions
        WHERE id = ? AND user_id = ? AND revoked_at IS NULL AND expires_at > ?
      `),
      touchSession: database.prepare(`
        UPDATE account_sessions SET last_seen_at = ? WHERE id = ? AND revoked_at IS NULL
      `),
      listSessions: database.prepare(`
        SELECT s.id, s.device_id, s.client_type, s.device_name, s.created_at,
               s.last_seen_at, s.expires_at, d.trusted_at
        FROM account_sessions s
        LEFT JOIN account_devices d ON d.id = s.device_id
        WHERE s.user_id = ? AND s.revoked_at IS NULL AND s.expires_at > ?
          AND (d.id IS NULL OR d.revoked_at IS NULL)
        ORDER BY s.last_seen_at DESC
      `),
      revokeSession: database.prepare(`
        UPDATE account_sessions SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL
      `),
      revokeAllSessions: database.prepare(`
        UPDATE account_sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL
      `),
      revokeSessionsByDevice: database.prepare(`
        UPDATE account_sessions SET revoked_at = @now
        WHERE user_id = @userId AND device_id = @deviceId AND revoked_at IS NULL
      `),
      activeDeviceByCredential: database.prepare(`
        SELECT id, user_id, client_type, device_name, trusted_at, last_seen_at
        FROM account_devices
        WHERE credential_hash = ? AND revoked_at IS NULL
      `),
      countDevices: database.prepare(`
        SELECT COUNT(*) AS total FROM account_devices WHERE user_id = ?
      `),
      insertDevice: database.prepare(`
        INSERT INTO account_devices (
          id, user_id, credential_hash, client_type, device_name,
          trusted_at, last_seen_at, last_address_hash
        ) VALUES (
          @id, @userId, @credentialHash, @clientType, @deviceName,
          @now, @now, @addressHash
        )
      `),
      touchDevice: database.prepare(`
        UPDATE account_devices
        SET last_seen_at = @now, last_address_hash = COALESCE(@addressHash, last_address_hash)
        WHERE id = @deviceId AND user_id = @userId AND revoked_at IS NULL
      `),
      replaceDeviceCredential: database.prepare(`
        UPDATE account_devices SET credential_hash = ?, last_seen_at = ?
        WHERE id = ? AND user_id = ? AND revoked_at IS NULL
      `),
      replaceSessionDeviceCredential: database.prepare(`
        UPDATE account_devices SET credential_hash = @credentialHash, last_seen_at = @now
        WHERE user_id = @userId AND revoked_at IS NULL AND id = (
          SELECT device_id FROM account_sessions
          WHERE id = @sessionId AND user_id = @userId AND revoked_at IS NULL
        )
      `),
      revokeDevice: database.prepare(`
        UPDATE account_devices SET revoked_at = @now
        WHERE id = @deviceId AND user_id = @userId AND revoked_at IS NULL
      `),
      revokeAllDevices: database.prepare(`
        UPDATE account_devices SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL
      `),
      bumpSessionVersion: database.prepare(`
        UPDATE accounts SET session_version = session_version + 1, updated_at = ? WHERE user_id = ?
      `),
    };

    this.createAccountTransaction = database.transaction((account) => {
      this.statements.insertUser.run(account);
      this.statements.insertProfile.run(account);
      this.statements.insertAccount.run(account);
    });
    this.updateIdentityTransaction = database.transaction((identity) => {
      this.statements.updateAccountPublicId.run(identity);
      this.statements.updateProfileIdentity.run(identity);
    });
    this.createTokenTransaction = database.transaction((token) => {
      this.statements.expireTokens.run(token);
      this.statements.insertToken.run(token);
    });
    this.trustAddressTransaction = database.transaction((trusted) => {
      this.statements.trustAddress.run(trusted);
      this.statements.trimTrustedAddresses.run(trusted);
    });
    this.createLoginChallengeTransaction = database.transaction((challenge) => {
      this.statements.expireLoginChallenges.run(challenge);
      this.statements.cleanLoginChallenges.run({ cutoff: challenge.now - 24 * 60 * 60 * 1000 });
      this.statements.insertLoginChallenge.run(challenge);
    });
    this.consumeLoginChallengeTransaction = database.transaction((tokenHash, now) => {
      const challenge = this.statements.loginChallenge.get(tokenHash);
      if (!challenge || challenge.used_at || challenge.expires_at <= now) return null;
      const consumed = this.statements.consumeLoginChallenge.run({ tokenHash, now }).changes > 0;
      if (!consumed) return null;
      if (challenge.device_id && challenge.device_credential_hash) {
        this.statements.insertDevice.run({
          id: challenge.device_id,
          userId: challenge.user_id,
          credentialHash: challenge.device_credential_hash,
          clientType: challenge.client_type ?? "unknown",
          deviceName: challenge.device_name ?? "Dispositivo desconhecido",
          addressHash: challenge.address_hash,
          now,
        });
      }
      this.trustAddressTransaction({ userId: challenge.user_id, addressHash: challenge.address_hash, now });
      return challenge;
    });
    this.createThreadTransaction = database.transaction((left, right, now) => {
      const pair = [...new Set([left, right])].sort();
      const pairKey = pair.join(":");
      const id = `d-${randomUUID().slice(0, 12)}`;
      this.statements.insertThread.run({ id, pairKey, now });
      const threadId = this.statements.threadByPair.get(pairKey).id;
      for (const userId of pair) this.statements.addParticipant.run(threadId, userId, now);
      return threadId;
    });
    this.addDirectMessageTransaction = database.transaction((message) => {
      this.statements.insertDirectMessage.run(message);
      this.statements.touchThread.run(message.now, message.threadId);
    });
    this.setPasswordTransaction = database.transaction((userId, passwordHash, now) => {
      this.statements.setPassword.run({ userId, passwordHash, now });
      this.statements.revokeAllSessions.run(now, userId);
      this.statements.revokeAllDevices.run(now, userId);
      this.statements.expireLoginChallenges.run({ userId, now });
    });
    this.createSessionTransaction = database.transaction((session) => {
      if (session.deviceId) {
        this.statements.revokeSessionsByDevice.run({
          userId: session.userId,
          deviceId: session.deviceId,
          now: session.now,
        });
      }
      this.statements.insertSession.run(session);
    });
    this.revokeDeviceTransaction = database.transaction((userId, deviceId, now) => {
      const changed = this.statements.revokeDevice.run({ userId, deviceId, now }).changes > 0;
      this.statements.revokeSessionsByDevice.run({ userId, deviceId, now });
      return changed;
    });
    this.bootstrapDeviceTransaction = database.transaction((device) => {
      if (this.statements.countDevices.get(device.userId).total !== 0) return null;
      this.statements.insertDevice.run(device);
      if (device.addressHash) {
        this.trustAddressTransaction({
          userId: device.userId,
          addressHash: device.addressHash,
          now: device.now,
        });
      }
      return this.statements.activeDeviceByCredential.get(device.credentialHash);
    });
  }

  accountByEmail(email) {
    return mapAccount(this.statements.accountByEmail.get(email));
  }

  accountByPublicId(publicId) {
    return mapAccount(this.statements.accountByPublicId.get(publicId));
  }

  /** Compatibilidade interna enquanto chamadas antigas ainda usam este nome. */
  accountByUsername(publicId) {
    return this.accountByPublicId(publicId);
  }

  accountById(userId) {
    return mapAccount(this.statements.accountById.get(userId));
  }

  deletePendingAccount(userId) {
    return this.statements.deletePendingAccount.run({ userId }).changes > 0;
  }

  deleteExpiredPendingAccounts(cutoff) {
    return this.statements.deleteExpiredPendingAccounts.run({ cutoff }).changes;
  }

  createAccount({
    userId,
    email,
    username = null,
    publicId = username,
    displayName = username ?? publicId,
    passwordHash = null,
    isSystemAdmin = false,
    verifiedAt = null,
    color,
  }) {
    const now = Date.now();
    this.createAccountTransaction({
      userId,
      email,
      publicId,
      displayName,
      passwordHash,
      verifiedAt,
      isSystemAdmin: isSystemAdmin ? 1 : 0,
      color,
      now,
    });
    return this.accountById(userId);
  }

  ensureSystemAdmin(account) {
    const byEmail = this.accountByEmail(account.email);
    if (byEmail) {
      if (!byEmail.isSystemAdmin) this.statements.makeSystemAdmin.run(Date.now(), byEmail.userId);
      return this.accountById(byEmail.userId);
    }
    return this.createAccount({ ...account, isSystemAdmin: true });
  }

  updateIdentity(userId, { publicId, displayName, color }) {
    this.updateIdentityTransaction({ userId, publicId, displayName, color, now: Date.now() });
    return this.accountById(userId);
  }

  createToken({ tokenHash, userId, purpose, expiresAt }) {
    this.createTokenTransaction({ tokenHash, userId, purpose, expiresAt, now: Date.now() });
  }

  token(tokenHash) {
    return this.statements.tokenByHash.get(tokenHash) ?? null;
  }

  consumeToken(tokenHash) {
    return this.statements.consumeToken.run(Date.now(), tokenHash).changes > 0;
  }

  verifyEmail(userId) {
    this.statements.verifyEmail.run({ userId, now: Date.now() });
    return this.accountById(userId);
  }

  setPassword(userId, passwordHash) {
    this.setPasswordTransaction(userId, passwordHash, Date.now());
    return this.accountById(userId);
  }

  createLoginChallenge({
    tokenHash,
    userId,
    addressHash,
    expiresAt,
    deviceId = null,
    deviceCredentialHash = null,
    clientType = null,
    deviceName = null,
  }) {
    this.createLoginChallengeTransaction({
      tokenHash, userId, addressHash, expiresAt,
      deviceId, deviceCredentialHash, clientType, deviceName,
      now: Date.now(),
    });
  }

  consumeLoginChallenge(tokenHash) {
    return this.consumeLoginChallengeTransaction(tokenHash, Date.now());
  }

  sharesGuild(left, right) {
    return left === right || Boolean(this.statements.sharedGuild.get(left, right));
  }

  createOrFindThread(left, right) {
    return this.createThreadTransaction(left, right, Date.now());
  }

  listThreads(userId) {
    const seen = new Set();
    return this.statements.listThreads.all({ userId }).filter((row) => {
      if (seen.has(row.id)) return false;
      seen.add(row.id);
      return true;
    }).map((row) => ({
      id: row.id,
      peer: {
        id: row.peer_id,
        username: row.peer_username,
        publicId: row.peer_public_id,
        color: row.peer_color,
      },
      lastContent: row.last_content === null
        ? null
        : this.cipher.decrypt(row.last_content, `direct_messages:${row.last_message_id}`),
      lastAt: row.last_at ?? null,
    }));
  }

  isParticipant(threadId, userId) {
    return Boolean(this.statements.isParticipant.get(threadId, userId));
  }

  participants(threadId) {
    return this.statements.participants.all(threadId).map((row) => row.user_id);
  }

  listDirectMessages(threadId, limit = 50) {
    return this.statements.listDirectMessages.all(threadId, limit).reverse().map((row) => ({
      sequence: row.sequence,
      id: row.id,
      threadId: row.thread_id,
      authorId: row.author_id,
      username: row.username,
      color: row.color,
      content: row.deleted_at ? "" : this.cipher.decrypt(row.content, `direct_messages:${row.id}`),
      at: row.created_at,
      editedAt: row.edited_at ?? null,
      deletedAt: row.deleted_at ?? null,
      replyToId: row.reply_to_id ?? null,
    }));
  }

  addDirectMessage(threadId, authorId, content, replyToId = null) {
    const id = randomUUID();
    const message = {
      id,
      threadId,
      authorId,
      content: this.cipher.encrypt(content, `direct_messages:${id}`),
      replyToId,
      now: Date.now(),
    };
    this.addDirectMessageTransaction(message);
    const sequence = this.database.prepare("SELECT sequence FROM direct_messages WHERE id = ?").get(message.id).sequence;
    const account = this.accountById(authorId);
    return {
      sequence,
      id: message.id,
      threadId,
      authorId,
      username: account.displayName,
      color: this.database.prepare("SELECT color FROM profiles WHERE user_id = ?").get(authorId).color,
      content,
      at: message.now,
      editedAt: null,
      deletedAt: null,
      replyToId,
    };
  }

  createSession(session) {
    this.createSessionTransaction({ ...session, deviceId: session.deviceId ?? null, now: Date.now() });
  }

  activeSession(id, userId) {
    const row = this.statements.activeSession.get(id, userId, Date.now());
    if (!row) return null;
    if (Date.now() - row.last_seen_at > 60_000) this.statements.touchSession.run(Date.now(), id);
    return row;
  }

  listSessions(userId) {
    return this.statements.listSessions.all(userId, Date.now()).map((row) => ({
      id: row.id,
      deviceId: row.device_id ?? null,
      clientType: row.client_type,
      deviceName: row.device_name,
      trustedAt: row.trusted_at ?? null,
      createdAt: row.created_at,
      lastSeenAt: row.last_seen_at,
      expiresAt: row.expires_at,
    }));
  }

  revokeSession(userId, sessionId) {
    const session = this.statements.activeSession.get(sessionId, userId, Date.now());
    if (session?.device_id) return this.revokeDeviceTransaction(userId, session.device_id, Date.now());
    return this.statements.revokeSession.run(Date.now(), sessionId, userId).changes > 0;
  }

  revokeCurrentSession(userId, sessionId) {
    return this.statements.revokeSession.run(Date.now(), sessionId, userId).changes > 0;
  }

  activeDevice(userId, credentialHash) {
    const device = this.statements.activeDeviceByCredential.get(credentialHash);
    return device?.user_id === userId ? device : null;
  }

  createDevice({ id = randomUUID(), userId, credentialHash, clientType, deviceName, addressHash }) {
    const now = Date.now();
    this.statements.insertDevice.run({
      id, userId, credentialHash, clientType, deviceName, addressHash, now,
    });
    if (addressHash) this.trustAddressTransaction({ userId, addressHash, now });
    return this.activeDevice(userId, credentialHash);
  }

  bootstrapDevice({ id = randomUUID(), userId, credentialHash, clientType, deviceName, addressHash }) {
    return this.bootstrapDeviceTransaction({
      id, userId, credentialHash, clientType, deviceName, addressHash, now: Date.now(),
    });
  }

  touchDevice(userId, deviceId, addressHash) {
    this.statements.touchDevice.run({ userId, deviceId, addressHash: addressHash ?? null, now: Date.now() });
  }

  replaceDeviceCredential(userId, deviceId, credentialHash) {
    return this.statements.replaceDeviceCredential.run(
      credentialHash, Date.now(), deviceId, userId,
    ).changes > 0;
  }

  replaceSessionDeviceCredential(userId, sessionId, credentialHash) {
    return this.statements.replaceSessionDeviceCredential.run({
      userId, sessionId, credentialHash, now: Date.now(),
    }).changes > 0;
  }

  revokeAllSessions(userId) {
    const now = Date.now();
    this.database.transaction(() => {
      this.statements.revokeAllSessions.run(now, userId);
      this.statements.revokeAllDevices.run(now, userId);
      this.statements.expireLoginChallenges.run({ userId, now });
      this.statements.bumpSessionVersion.run(now, userId);
    })();
    return this.accountById(userId);
  }

  close() {
    this.database.close();
  }
}

export function createAccountRepository(options = {}) {
  return new AccountRepository(openDatabase(options.databasePath));
}
