-- Relações sociais usam uma chave de par ordenada. Assim A/B e B/A nunca
-- conseguem virar duas amizades ou duas solicitações concorrentes.
CREATE TABLE friend_requests (
  pair_key TEXT PRIMARY KEY,
  requester_id TEXT NOT NULL REFERENCES accounts(user_id) ON DELETE CASCADE,
  recipient_id TEXT NOT NULL REFERENCES accounts(user_id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  CHECK (requester_id <> recipient_id)
);

CREATE INDEX friend_requests_by_recipient
  ON friend_requests(recipient_id, created_at DESC);
CREATE INDEX friend_requests_by_requester
  ON friend_requests(requester_id, created_at DESC);

CREATE TABLE friendships (
  pair_key TEXT PRIMARY KEY,
  user_low_id TEXT NOT NULL REFERENCES accounts(user_id) ON DELETE CASCADE,
  user_high_id TEXT NOT NULL REFERENCES accounts(user_id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  CHECK (user_low_id < user_high_id)
);

CREATE INDEX friendships_by_low ON friendships(user_low_id, created_at DESC);
CREATE INDEX friendships_by_high ON friendships(user_high_id, created_at DESC);

CREATE TABLE user_blocks (
  blocker_id TEXT NOT NULL REFERENCES accounts(user_id) ON DELETE CASCADE,
  blocked_id TEXT NOT NULL REFERENCES accounts(user_id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (blocker_id, blocked_id),
  CHECK (blocker_id <> blocked_id)
);

CREATE INDEX user_blocks_by_blocked ON user_blocks(blocked_id, created_at DESC);

ALTER TABLE profiles ADD COLUMN presence_mode TEXT NOT NULL DEFAULT 'online'
  CHECK (presence_mode IN ('online', 'away', 'dnd', 'invisible'));
ALTER TABLE profiles ADD COLUMN custom_status TEXT;
ALTER TABLE profiles ADD COLUMN status_expires_at INTEGER;

-- Cursores mantêm leitura O(1). A sequência de cada conversa é monotônica e
-- permite calcular novos itens com índice quando um resumo precisa ser refeito.
CREATE TABLE read_states (
  user_id TEXT NOT NULL REFERENCES accounts(user_id) ON DELETE CASCADE,
  conversation_type TEXT NOT NULL CHECK (conversation_type IN ('channel', 'direct')),
  conversation_id TEXT NOT NULL,
  last_read_sequence INTEGER NOT NULL DEFAULT 0,
  mention_count INTEGER NOT NULL DEFAULT 0 CHECK (mention_count >= 0),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, conversation_type, conversation_id)
);

CREATE INDEX read_states_by_user ON read_states(user_id, updated_at DESC);

CREATE TABLE message_mentions (
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  target_type TEXT NOT NULL CHECK (target_type IN ('user', 'role', 'everyone')),
  target_id TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (message_id, target_type, target_id)
);

CREATE INDEX message_mentions_by_target
  ON message_mentions(target_type, target_id, message_id);

CREATE TABLE direct_message_mentions (
  message_id TEXT NOT NULL REFERENCES direct_messages(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES accounts(user_id) ON DELETE CASCADE,
  PRIMARY KEY (message_id, user_id)
);

ALTER TABLE messages ADD COLUMN reply_to_id TEXT REFERENCES messages(id) ON DELETE SET NULL;
ALTER TABLE direct_messages ADD COLUMN reply_to_id TEXT REFERENCES direct_messages(id) ON DELETE SET NULL;

CREATE TABLE message_reactions (
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES accounts(user_id) ON DELETE CASCADE,
  emoji TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (message_id, user_id, emoji)
);

CREATE INDEX message_reactions_summary ON message_reactions(message_id, emoji);

CREATE TABLE direct_message_reactions (
  message_id TEXT NOT NULL REFERENCES direct_messages(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES accounts(user_id) ON DELETE CASCADE,
  emoji TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (message_id, user_id, emoji)
);

CREATE INDEX direct_message_reactions_summary
  ON direct_message_reactions(message_id, emoji);

CREATE TABLE attachments (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES accounts(user_id) ON DELETE CASCADE,
  message_id TEXT REFERENCES messages(id) ON DELETE CASCADE,
  direct_message_id TEXT REFERENCES direct_messages(id) ON DELETE CASCADE,
  filename TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  byte_size INTEGER NOT NULL CHECK (byte_size > 0),
  storage_key TEXT NOT NULL UNIQUE,
  public_url TEXT,
  width INTEGER,
  height INTEGER,
  created_at INTEGER NOT NULL,
  CHECK ((message_id IS NULL) <> (direct_message_id IS NULL))
);

CREATE INDEX attachments_by_message ON attachments(message_id);
CREATE INDEX attachments_by_direct_message ON attachments(direct_message_id);

CREATE TABLE notifications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES accounts(user_id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('direct', 'mention', 'friend_request', 'call', 'social')),
  actor_id TEXT REFERENCES accounts(user_id) ON DELETE SET NULL,
  conversation_type TEXT CHECK (conversation_type IN ('channel', 'direct')),
  conversation_id TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  read_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE INDEX notifications_unread
  ON notifications(user_id, read_at, created_at DESC);

-- Sessões individuais substituem gradualmente a revogação global por versão.
-- O hash identifica o token sem armazenar o segredo que autentica a pessoa.
CREATE TABLE account_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES accounts(user_id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  client_type TEXT NOT NULL CHECK (client_type IN ('web', 'desktop', 'mobile', 'unknown')),
  device_name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER
);

CREATE INDEX account_sessions_by_user
  ON account_sessions(user_id, revoked_at, last_seen_at DESC);

CREATE TABLE member_timeouts (
  guild_id TEXT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES accounts(user_id) ON DELETE CASCADE,
  moderator_user_id TEXT REFERENCES accounts(user_id) ON DELETE SET NULL,
  reason TEXT,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (guild_id, user_id)
);

CREATE TABLE audit_log (
  id TEXT PRIMARY KEY,
  guild_id TEXT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  actor_id TEXT REFERENCES accounts(user_id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  target_type TEXT,
  target_id TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);

CREATE INDEX audit_log_by_guild ON audit_log(guild_id, created_at DESC, id);

CREATE TABLE call_events (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES accounts(user_id) ON DELETE SET NULL,
  channel_id TEXT REFERENCES channels(id) ON DELETE SET NULL,
  event_type TEXT NOT NULL,
  route TEXT CHECK (route IN ('p2p', 'sfu', 'turn')),
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);

CREATE INDEX call_events_recent ON call_events(created_at DESC, event_type);
