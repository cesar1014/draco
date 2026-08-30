-- O IP nunca é guardado em texto puro. `address_hash` é um HMAC produzido com o
-- segredo de sessão; ele serve apenas para reconhecer que o mesmo endereço voltou.
CREATE TABLE account_trusted_addresses (
  user_id TEXT NOT NULL REFERENCES accounts(user_id) ON DELETE CASCADE,
  address_hash TEXT NOT NULL,
  trusted_at INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, address_hash)
);

CREATE INDEX account_trusted_addresses_by_last_use
  ON account_trusted_addresses(user_id, last_used_at DESC);

-- Desafio separado dos outros links de conta porque precisa carregar o endereço
-- que será autorizado. Como nos demais tokens, só a impressão do segredo fica.
CREATE TABLE account_login_challenges (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES accounts(user_id) ON DELETE CASCADE,
  address_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE INDEX account_login_challenges_by_user
  ON account_login_challenges(user_id, created_at DESC);
