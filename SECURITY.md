# Segurança do Draco

Este documento registra os controles efetivamente implementados. Controles que dependem da infraestrutura externa aparecem explicitamente como condicionais.

| # | Controle | Situação no Draco |
|---:|---|---|
| 1 | Esconder chaves | `.env` é ignorado pelo Git; SMTP, SFU, storage, sessão, CAPTCHA e chaves de criptografia existem somente no servidor/cofre da hospedagem. |
| 2 | Limpar segredos do Git | Histórico e arquivos rastreados foram auditados. O CI executa Gitleaks no histórico completo e não contém credenciais reais. |
| 3 | Public key no banco | Não se aplica: não há chave pública de cliente nem banco exposto ao navegador. Chaves simétricas nunca ficam no SQLite. |
| 4 | RLS | Não se aplica ao SQLite local. A camada equivalente é a autorização server-side por associação, cargo, canal, autoria e participação em DM. |
| 5 | Criptografia | HTTPS/WSS e WebRTC protegem o tráfego. Mensagens no SQLite e backups usam AES-256-GCM autenticado com chaves externas e rotação; senhas, tokens e IPs ficam em hash/HMAC. Não é E2EE. |
| 6 | Auth server-side | Conta, sessão, dispositivos, convites e autorizações são decididos no servidor. Tokens de conta ficam em cookie HttpOnly; o cliente não decide identidade ou privilégios. |
| 7 | Restringir acessos | Servidores privados, salas Socket.IO por servidor/canal, DMs somente para participantes e administrador global sem leitura automática de DMs alheias. |
| 8 | Mass assignment | Rotas extraem apenas campos conhecidos; permissões, ids de dono, privilégio global e campos persistidos nunca são aplicados diretamente do corpo recebido. |
| 9 | Cookies | Sessão e credencial derivadora de dispositivo usam `HttpOnly`, `SameSite=Strict`, `Path=/` e `Secure` em produção. Tokens antigos do `localStorage` são migrados uma vez e removidos. |
| 10 | Hash de senhas | scrypt com sal aleatório; novos hashes usam N=32768, r=8, p=3. |
| 11 | Rate limit | Autenticação usa baldes persistentes e independentes por IP e e-mail opaco; Socket.IO mantém limites por IP/usuário para chat, convites, administração, voz, ICE e SFU. |
| 12 | Bot protection | Cloudflare Turnstile protege login, cadastro e recuperação quando as duas chaves estão configuradas. Confirmação de e-mail e de dispositivo continua obrigatória; administradores não podem fazer bootstrap de um dispositivo apenas com senha. |
| 13 | Queries parametrizadas | Repositórios usam statements preparados e parâmetros; migrations executam somente SQL estático versionado. |
| 14 | Validar inputs | Tipo, comprimento, formato, ids, SDP, ICE, nomes, idade, senha, mensagens e anexos são limitados no servidor. Corpos JSON têm limite de 16 KiB. |
| 15 | Evitar vazamento | Erros externos omitem detalhes internos; logs não registram senha/token/mensagem. O DTO de membros exclui socket interno, sessão receptora do SFU, privilégio global e modo invisível bruto. |
| 16 | Uploads | Bucket privado, URLs assinadas curtas, allowlist JPG/PNG/GIF/WebP/PDF, extensão+MIME+magic bytes, 25 MiB/arquivo, 5 anexos/mensagem, quota acumulada por conta e remoção de pendências/objetos inválidos. |
| 17 | Respostas mínimas | Snapshots são filtrados por servidor e canal; anexos recebem somente URL temporária; segredos, hashes e campos internos nunca entram nas respostas. |
| 18 | Headers | CSP, HSTS, `Permissions-Policy`, anti-frame, anti-MIME-sniff e remoção de `X-Powered-By`. Origens de storage/Turnstile entram na CSP somente quando configuradas. |
| 19 | HTTPS | Em `NODE_ENV=production`, o boot falha sem `ORIGIN`/`APP_URL` HTTPS válidas; GET HTTP recebe 308, escritas HTTP são recusadas e o handshake Socket.IO exige transporte externo HTTPS. |
| 20 | Dependências | CI semanal e por PR executa `npm audit` no servidor e desktop, testes, build, validação Electron e Gitleaks. Dependabot acompanha npm e GitHub Actions. |

## Configuração obrigatória em produção

- `NODE_ENV=production`, `ORIGIN` e `APP_URL` com a origem HTTPS exata.
- `DATA_ENCRYPTION_KEY`, `BACKUP_ENCRYPTION_KEY` e `SESSION_SECRET` no cofre de secrets, nunca no repositório ou SQLite.
- `TRUSTED_PROXY=1` somente quando o processo está realmente atrás do proxy TLS confiável.
- Bucket privado com CORS limitado à origem do Draco. Uma regra de lifecycle no provedor é recomendada como segunda camada para uploads incompletos.
- `TURNSTILE_SITE_KEY` e `TURNSTILE_SECRET_KEY` juntas para ativar a barreira antirobô externa.

## Limites conhecidos

- O conteúdo é administrado pelo servidor e não possui criptografia ponta a ponta; metadados relacionais do SQLite não são cifrados por campo. Use também criptografia do volume da hospedagem.
- A allowlist e a assinatura mágica reduzem uploads maliciosos, mas não substituem antivírus/CDR para PDFs em uma instalação pública de alto risco.
- O instalador sem certificado pode mostrar “Editor desconhecido”/SmartScreen; atualização automática permanece desativada em builds não assinados.
