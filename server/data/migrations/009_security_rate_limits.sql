CREATE TABLE security_rate_limits (
  scope_key TEXT PRIMARY KEY,
  tokens REAL NOT NULL,
  updated_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX security_rate_limits_expiry ON security_rate_limits(expires_at);
