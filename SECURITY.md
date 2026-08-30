# Segurança da versão 1.0.0

Este documento registra o que foi efetivamente verificado para a primeira versão oficial. Ele evita tratar itens que não existem nesta arquitetura como se estivessem implementados.

| # | Controle | Situação no Draco |
|---:|---|---|
| 1 | Esconder chaves | `.env` fora do Git, permissão 600 no servidor e segredos de SFU/SMTP somente no processo servidor. |
| 2 | Limpar segredos do Git | Histórico e arquivos rastreados verificados por padrões de chaves; somente placeholders foram encontrados. |
| 3 | Public key no banco | Não se aplica: não há chave pública de cliente nem banco exposto ao navegador. |
| 4 | RLS | Não se aplica ao SQLite local. As regras equivalentes ficam no servidor e verificam associação, cargo e permissão em cada operação. |
| 5 | Criptografia | HTTPS/WSS e WebRTC protegem tráfego; senhas, tokens e IPs ficam em hash/HMAC. Mensagens no SQLite não são E2EE nem criptografadas por campo. |
| 6 | Auth server-side | Conta, sessão, novo IP, convites e autorizações são decididos no servidor. |
| 7 | Restringir acessos | Servidores privados, salas Socket.IO por servidor, DMs somente para participantes e administrador global sem acesso a DMs alheias. |
| 8 | Mass assignment | Rotas aceitam corpo JSON simples e serviços extraem apenas campos conhecidos. |
| 9 | Cookies | Não se aplica: o Draco não usa cookie de sessão. |
| 10 | Hash de senhas | scrypt com sal aleatório; novos hashes usam N=32768, r=8, p=3. |
| 11 | Rate limit | Limites por IP/identidade em autenticação, chat, convites, administração, voz, ICE e SFU. |
| 12 | Bots | Barreira 18+, confirmação de e-mail e rate limit. Não há CAPTCHA externo. |
| 13 | Queries parametrizadas | Repositórios SQLite usam `prepare` e parâmetros; migrations executam somente SQL estático do projeto. |
| 14 | Validar inputs | Tipo, comprimento, formato, ids, SDP, ICE, nomes, idade, senha e mensagens são limitados no servidor. |
| 15 | Evitar vazamento | Erros externos omitem detalhes internos; logs não registram senha, token, mensagem ou id da janela capturada. |
| 16 | Uploads | Não se aplica: a 1.0.0 não possui upload de arquivos. |
| 17 | Respostas mínimas | Snapshots são filtrados pela associação ao servidor; segredos e hashes nunca entram nas respostas. |
| 18 | Headers | CSP, HSTS, `Permissions-Policy`, anti-frame, anti-MIME-sniff e remoção de `X-Powered-By`. |
| 19 | HTTPS | Caddy faz certificado e redirecionamento HTTP→HTTPS; o processo Node escuta somente no loopback em produção. |
| 20 | Dependências | `npm audit` do servidor e do desktop deve terminar com zero vulnerabilidades antes de publicar. |

## Limites conhecidos

- O instalador ainda não possui certificado de assinatura de código. O Windows pode mostrar “Editor desconhecido”/SmartScreen; a atualização automática fica desativada por isso.
- O conteúdo das mensagens é administrado pelo servidor e armazenado em SQLite. Isso não é criptografia ponta a ponta.
- CAPTCHA pode ser adicionado se o volume de cadastro público justificar um provedor e suas respectivas chaves/termos.
