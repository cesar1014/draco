-- O catálogo padrão deixou de existir: quem entra pela primeira vez começa sem
-- servidor nenhum, e cada servidor passa a ter dono. Num banco que já rodou as
-- versões anteriores sobraram os servidores semeados, sem dono e por isso sem
-- quem os administre. Nada é apagado: eles são adotados por quem entrou primeiro,
-- que é quem já estava usando aquele servidor, e viram servidores comuns.
UPDATE guilds
SET
  owner_id = (
    SELECT gm.user_id
    FROM guild_members gm
    WHERE gm.guild_id = guilds.id
    ORDER BY gm.joined_at, gm.user_id
    LIMIT 1
  ),
  updated_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000
WHERE owner_id IS NULL;

-- A marca do seed não tem mais o que marcar. Servidor sem membro nenhum continua
-- sem dono, e fica invisível: o snapshot de cada pessoa é montado a partir das
-- associações dela, então um servidor sem ninguém não aparece pra ninguém.
DELETE FROM app_settings WHERE setting_key = 'catalog:seeded_at';
