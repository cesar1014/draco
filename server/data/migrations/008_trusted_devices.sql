CREATE TABLE account_devices (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES accounts(user_id) ON DELETE CASCADE,
  credential_hash TEXT NOT NULL UNIQUE,
  client_type TEXT NOT NULL CHECK (client_type IN ('web', 'desktop', 'mobile', 'unknown')),
  device_name TEXT NOT NULL,
  trusted_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  last_address_hash TEXT,
  revoked_at INTEGER
);

CREATE INDEX account_devices_by_user
  ON account_devices(user_id, revoked_at, last_seen_at DESC);

ALTER TABLE account_sessions ADD COLUMN device_id TEXT REFERENCES account_devices(id) ON DELETE SET NULL;
CREATE INDEX account_sessions_by_device
  ON account_sessions(device_id, revoked_at, last_seen_at DESC);

ALTER TABLE account_login_challenges ADD COLUMN device_id TEXT;
ALTER TABLE account_login_challenges ADD COLUMN device_credential_hash TEXT;
ALTER TABLE account_login_challenges ADD COLUMN client_type TEXT;
ALTER TABLE account_login_challenges ADD COLUMN device_name TEXT;
