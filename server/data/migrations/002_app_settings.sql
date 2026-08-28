-- Configuração do próprio servidor, o que não pertence a nenhum servidor nem a
-- nenhuma pessoa. O primeiro uso é marcar que o catálogo padrão já foi criado:
-- sem essa marca, o seed roda a cada boot e um canal apagado de propósito
-- reapareceria sozinho no reinício seguinte.
CREATE TABLE app_settings (
  setting_key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
