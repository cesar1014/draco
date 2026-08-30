import { randomUUID } from "node:crypto";
import { openDatabase } from "./database.js";

function mapAccount(row) {
  if (!row) return null;
  return {
    userId: row.user_id,
    email: row.email,
    username: row.username,
    passwordHash: row.password_hash,
    emailVerifiedAt: row.email_verified_at,
    isSystemAdmin: row.is_system_admin === 1,
    sessionVersion: row.session_version,
    disabledAt: row.disabled_at ?? null,
  };
}

export class AccountRepository {
  constructor(database) {
    this.database = database;
    this.statements = {
      accountByEmail: database.prepare(`
        SELECT a.*, u.disabled_at
        FROM accounts a JOIN users u ON u.id = a.user_id
        WHERE a.email = ? COLLATE NOCASE
      `),
      accountByUsername: database.prepare(`
        SELECT a.*, u.disabled_at
        FROM accounts a JOIN users u ON u.id = a.user_id
        WHERE a.username = ? COLLATE NOCASE
      `),
      accountById: database.prepare(`
        SELECT a.*, u.disabled_at
        FROM accounts a JOIN users u ON u.id = a.user_id
        WHERE a.user_id = ?
      `),
      insertUser: database.prepare(`
        INSERT INTO users (id, created_at, updated_at) VALUES (@userId, @now, @now)
      `),
      insertProfile: database.prepare(`
        INSERT INTO profiles (user_id, username, color, updated_at)
        VALUES (@userId, @username, @color, @now)
      `),
      insertAccount: database.prepare(`
        INSERT INTO accounts (
          user_id, email, username, password_hash, email_verified_at,
          is_system_admin, session_version, created_at, updated_at
        ) VALUES (
          @userId, @email, @username, @passwordHash, @verifiedAt,
          @isSystemAdmin, 1, @now, @now
        )
      `),
      updateProfileName: database.prepare(`
        UPDATE profiles SET username = ?, updated_at = ? WHERE user_id = ?
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
      trustedAddress: database.prepare(`
        SELECT 1 FROM account_trusted_addresses
        WHERE user_id = ? AND address_hash = ?
      `),
      countTrustedAddresses: database.prepare(`
        SELECT COUNT(*) AS total FROM account_trusted_addresses WHERE user_id = ?
      `),
      touchTrustedAddress: database.prepare(`
        UPDATE account_trusted_addresses SET last_used_at = ?
        WHERE user_id = ? AND address_hash = ?
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
          token_hash, user_id, address_hash, expires_at, created_at
        ) VALUES (@tokenHash, @userId, @addressHash, @expiresAt, @now)
      `),
      loginChallenge: database.prepare(`
        SELECT token_hash, user_id, address_hash, expires_at, used_at
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
          a.username AS peer_username,
          p.color AS peer_color,
          (
            SELECT dm.content FROM direct_messages dm
            WHERE dm.thread_id = t.id AND dm.deleted_at IS NULL
            ORDER BY dm.sequence DESC LIMIT 1
          ) AS last_content,
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
        SELECT dm.id, dm.thread_id, dm.author_id, dm.content, dm.created_at,
               a.username, p.color
        FROM direct_messages dm
        JOIN accounts a ON a.user_id = dm.author_id
        JOIN profiles p ON p.user_id = dm.author_id
        WHERE dm.thread_id = ? AND dm.deleted_at IS NULL
        ORDER BY dm.sequence DESC LIMIT ?
      `),
      insertDirectMessage: database.prepare(`
        INSERT INTO direct_messages (id, thread_id, author_id, content, created_at)
        VALUES (@id, @threadId, @authorId, @content, @now)
      `),
      touchThread: database.prepare("UPDATE direct_threads SET updated_at = ? WHERE id = ?"),
    };

    this.createAccountTransaction = database.transaction((account) => {
      this.statements.insertUser.run(account);
      this.statements.insertProfile.run(account);
      this.statements.insertAccount.run(account);
    });
    this.createTokenTransaction = database.transaction((token) => {
      this.statements.expireTokens.run(token);
      this.statements.insertToken.run(token);
    });
    this.trustAddressTransaction = database.transaction((trusted) => {
      this.statements.trustAddress.run(trusted);
      this.statements.trimTrustedAddresses.run(trusted);
    });
    this.useOrBootstrapAddressTransaction = database.transaction((userId, addressHash, now) => {
      if (this.statements.trustedAddress.get(userId, addressHash)) {
        this.statements.touchTrustedAddress.run(now, userId, addressHash);
        return true;
      }
      // Uma transação só impede que dois IPs simultâneos sejam ambos tratados
      // como o primeiro endereço de uma conta migrada.
      if (this.statements.countTrustedAddresses.get(userId).total !== 0) return false;
      this.trustAddressTransaction({ userId, addressHash, now });
      return true;
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
      this.trustAddressTransaction({
        userId: challenge.user_id,
        addressHash: challenge.address_hash,
        now,
      });
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
  }

  accountByEmail(email) {
    return mapAccount(this.statements.accountByEmail.get(email));
  }

  accountByUsername(username) {
    return mapAccount(this.statements.accountByUsername.get(username));
  }

  accountById(userId) {
    return mapAccount(this.statements.accountById.get(userId));
  }

  createAccount({ userId, email, username, passwordHash = null, isSystemAdmin = false, verifiedAt = null, color }) {
    const now = Date.now();
    this.createAccountTransaction({
      userId,
      email,
      username,
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

  rename(userId, username) {
    const now = Date.now();
    this.database
      .prepare("UPDATE accounts SET username = ?, updated_at = ? WHERE user_id = ?")
      .run(username, now, userId);
    this.statements.updateProfileName.run(username, now, userId);
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
    this.statements.setPassword.run({ userId, passwordHash, now: Date.now() });
    return this.accountById(userId);
  }

  /** Retorna falso sem alterar nada quando o endereço ainda não foi confirmado. */
  useOrBootstrapAddress(userId, addressHash) {
    return this.useOrBootstrapAddressTransaction(userId, addressHash, Date.now());
  }

  trustAddress(userId, addressHash) {
    this.trustAddressTransaction({ userId, addressHash, now: Date.now() });
  }

  createLoginChallenge({ tokenHash, userId, addressHash, expiresAt }) {
    this.createLoginChallengeTransaction({
      tokenHash,
      userId,
      addressHash,
      expiresAt,
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
      peer: { id: row.peer_id, username: row.peer_username, color: row.peer_color },
      lastContent: row.last_content ?? null,
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
      id: row.id,
      threadId: row.thread_id,
      authorId: row.author_id,
      username: row.username,
      color: row.color,
      content: row.content,
      at: row.created_at,
    }));
  }

  addDirectMessage(threadId, authorId, content) {
    const message = {
      id: randomUUID(),
      threadId,
      authorId,
      content,
      now: Date.now(),
    };
    this.addDirectMessageTransaction(message);
    const account = this.accountById(authorId);
    return {
      id: message.id,
      threadId,
      authorId,
      username: account.username,
      color: this.database.prepare("SELECT color FROM profiles WHERE user_id = ?").get(authorId).color,
      content,
      at: message.now,
    };
  }

  close() {
    this.database.close();
  }
}

export function createAccountRepository(options = {}) {
  return new AccountRepository(openDatabase(options.databasePath));
}
