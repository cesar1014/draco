-- `accounts.username` já é único sem diferenciar maiúsculas/minúsculas e passa
-- a representar o ID público. O nome que aparece na interface vive no perfil e
-- pode se repetir. Contas existentes preservam exatamente o nome que já tinham.
UPDATE profiles
SET display_name = username
WHERE display_name IS NULL OR TRIM(display_name) = '';
