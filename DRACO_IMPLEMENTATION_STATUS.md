# Draco — status da implementação

## Estado final

A Parte 2 e o endurecimento de segurança solicitado estão concluídos.

- Login usa dispositivo confiável por credencial aleatória com hash no servidor, sem depender de IP fixo; revogações individual/global e troca de senha invalidam a confiança corretamente.
- SFU detecta sessões desconectadas, limita tentativas e recria a call; câmera e compartilhamento de tela limpam e republicam tracks sem manter estado falso de conexão.
- Kick, ban, unban e hierarquia são validados no backend; kick/ban removem da voz imediatamente e o histórico de banimento exibe ator, data e motivo.
- Mute/deafen público e espectadores reais do compartilhamento de tela ficam sincronizados somente dentro da call.
- A migration incremental `008_trusted_devices.sql` adiciona dispositivos confiáveis e preserva compatibilidade com bancos existentes.
- Sessão/dispositivo usam cookies HttpOnly; mensagens e backups usam AES-256-GCM com chaves externas.
- DTOs, uploads privados, quotas/limpeza, rate limit persistente, Turnstile opcional, HTTPS/origem fail-closed e scans de CI foram revisados e implementados.
- Exclusão permanente de servidor disponível somente para o dono, com confirmação pelo nome, encerramento das chamadas e cascata segura de dados/anexos.
- E-mails de confirmação, novo dispositivo e senha usam template responsivo com logo e identidade DracoCall, texto alternativo e dados dinâmicos escapados.

## Validação final

- `npm test`: aprovado, incluindo typecheck, **118** casos de signaling e **22** casos de mídia, além de contas, e-mail, social, persistência, backup, storage e segurança HTTP.
- `npm run build`: aprovado.
- `npm run app:build`: aprovado; instalador e blockmap gerados em `desktop/out/`.
- Diff final auditado sem arquivos temporários, logs/debug novos, secrets, botões sem ação ou remoção acidental de funcionalidade.

Produção exige `ORIGIN`, `APP_URL`, `SESSION_SECRET`, `DATA_ENCRYPTION_KEY` e as credenciais externas aplicáveis; Turnstile depende das duas chaves do provedor.
