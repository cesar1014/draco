-- Contas reais ficam separadas de `profiles`: as versões antigas permitiam
-- apelidos repetidos e criavam um perfil por navegador. A tabela nova consegue
-- impor unicidade de e-mail e nome sem tornar impossível migrar aquele histórico.
CREATE TABLE accounts (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  email TEXT NOT NULL COLLATE NOCASE UNIQUE,
  username TEXT NOT NULL COLLATE NOCASE UNIQUE,
  password_hash TEXT,
  email_verified_at INTEGER,
  is_system_admin INTEGER NOT NULL DEFAULT 0 CHECK (is_system_admin IN (0, 1)),
  session_version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Só o hash do segredo fica no banco. Se alguém copiar o SQLite, não consegue
-- usar um link de verificação ou recuperação que ainda não expirou.
CREATE TABLE account_tokens (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES accounts(user_id) ON DELETE CASCADE,
  purpose TEXT NOT NULL CHECK (
    purpose IN ('verify_email', 'password_reset', 'password_change', 'admin_setup')
  ),
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE INDEX account_tokens_by_user_purpose
  ON account_tokens(user_id, purpose, created_at DESC);

-- Uma conversa é identificada pelo par de participantes em ordem estável. O par
-- pode ter uma pessoa só: é o bloco de notas privado de quem manda DM pra si.
CREATE TABLE direct_threads (
  id TEXT PRIMARY KEY,
  pair_key TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE direct_participants (
  thread_id TEXT NOT NULL REFERENCES direct_threads(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES accounts(user_id) ON DELETE CASCADE,
  joined_at INTEGER NOT NULL,
  PRIMARY KEY (thread_id, user_id)
);

CREATE INDEX direct_participants_by_user
  ON direct_participants(user_id, thread_id);

CREATE TABLE direct_messages (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  thread_id TEXT NOT NULL REFERENCES direct_threads(id) ON DELETE CASCADE,
  author_id TEXT NOT NULL REFERENCES accounts(user_id) ON DELETE RESTRICT,
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  edited_at INTEGER,
  deleted_at INTEGER
);

CREATE INDEX direct_messages_by_thread_sequence
  ON direct_messages(thread_id, sequence DESC);
