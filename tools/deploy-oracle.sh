#!/usr/bin/env bash
# Sobe o Draco numa máquina Ubuntu limpa: Node, build, serviço, HTTPS e TURN.
# Feito pra Oracle Cloud Always Free em São Paulo, mas serve em qualquer VPS.
#
#   bash tools/deploy-oracle.sh seu-nome.duckdns.org
#
# Pode rodar de novo quantas vezes quiser: nada é duplicado e o .env é
# preservado: o script só preenche o que estiver em branco.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

DOMAIN="${1:-}"
if [ -z "$DOMAIN" ]; then
  echo "uso: bash tools/deploy-oracle.sh seu-dominio.duckdns.org" >&2
  exit 1
fi
if [ "$(id -u)" = "0" ]; then
  echo "rode como usuário normal (ubuntu), não como root. O script chama sudo onde precisa." >&2
  exit 1
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN_USER="$(id -un)"
PRIVATE_IP="$(hostname -I | awk '{print $1}')"
PUBLIC_IP="$(curl -fsS --max-time 10 https://api.ipify.org || true)"
TURN_PORTS="49160:49200"

say() { printf '\n\033[1;35m▸ %s\033[0m\n' "$1"; }

# Lê a chave do .env se já tiver valor; senão grava o valor gerado. Em qualquer
# caso devolve o valor final pelo stdout. Com "force", o valor passado manda,
# é o caso de ORIGIN e TURN_HOST, que saem do domínio dado na linha de comando.
set_env() {
  local key="$1" value="$2" mode="${3:-keep}" file="$ROOT/.env" current
  touch "$file"
  if grep -q "^${key}=" "$file"; then
    current="$(grep -m1 "^${key}=" "$file" | cut -d= -f2-)"
    if [ -n "$current" ] && [ "$mode" = "keep" ]; then
      printf '%s' "$current"
      return
    fi
    sed -i "s|^${key}=.*|${key}=${value}|" "$file"
  else
    printf '%s=%s\n' "$key" "$value" >>"$file"
  fi
  printf '%s' "$value"
}

open_port() {
  local proto="$1" port="$2"
  sudo iptables -C INPUT -p "$proto" --dport "$port" -j ACCEPT 2>/dev/null ||
    sudo iptables -I INPUT 1 -p "$proto" --dport "$port" -j ACCEPT
  if command -v ufw >/dev/null && sudo ufw status 2>/dev/null | grep -q '^Status: active'; then
    sudo ufw allow "${port}/${proto}" >/dev/null
  fi
}

say "Swap de 2 GB"
# A máquina grátis tem 1 GB de RAM e o build do Vite estoura isso sem swap.
if [ ! -f /swapfile ]; then
  sudo fallocate -l 2G /swapfile
  sudo chmod 600 /swapfile
  sudo mkswap /swapfile >/dev/null
  sudo swapon /swapfile
  echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab >/dev/null
fi
free -h | head -3

say "Pacotes do sistema"
sudo apt-get update -qq
sudo apt-get install -y -qq curl git openssl coturn iptables-persistent \
  debian-keyring debian-archive-keyring apt-transport-https

if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 20 ]; then
  say "Node.js 22"
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y -qq nodejs
fi
node --version

if ! command -v caddy >/dev/null; then
  say "Caddy (não está no repositório do Ubuntu)"
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' |
    sudo gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' |
    sudo tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
  sudo apt-get update -qq
  sudo apt-get install -y -qq caddy
fi

say "Configuração do app"
[ -f "$ROOT/.env" ] || cp "$ROOT/.env.example" "$ROOT/.env"
TURN_SECRET="$(set_env TURN_SECRET "$(openssl rand -hex 32)")"
# O segredo de sessão fica no .env, não sorteado a cada boot: assim os tokens já
# emitidos continuam válidos depois de um deploy ou de um restart do serviço.
set_env SESSION_SECRET "$(openssl rand -hex 32)" >/dev/null
set_env DATABASE_PATH "$ROOT/data/draco.sqlite" >/dev/null
# O Caddy é o proxy: sem isto o limite por IP veria o endereço dele, e todo mundo
# compartilharia o mesmo balde.
set_env TRUSTED_PROXY 1 force >/dev/null
set_env ORIGIN "https://$DOMAIN" force >/dev/null
set_env APP_URL "https://$DOMAIN" force >/dev/null
set_env SYSTEM_ADMIN_USERNAME "cesar1014" force >/dev/null
set_env SYSTEM_ADMIN_EMAIL "xcesaryt@gmail.com" force >/dev/null
set_env TURN_HOST "turn:$DOMAIN:3478" force >/dev/null
chmod 600 "$ROOT/.env"
grep -vE '^\s*(#|$)' "$ROOT/.env" | sed 's/=.*/=•••/'

say "Instalar e compilar"
cd "$ROOT"
npm ci --no-audit --no-fund
npm run build

say "Serviço draco"
sudo tee /etc/systemd/system/draco.service >/dev/null <<EOF
[Unit]
Description=Draco: voz, webcam e tela
After=network.target

[Service]
Type=simple
User=$RUN_USER
WorkingDirectory=$ROOT
Environment=NODE_ENV=production
Environment=PORT=3100
ExecStart=$(command -v node) server/index.js
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
EOF
sudo systemctl daemon-reload
sudo systemctl enable -q draco
sudo systemctl restart draco

say "HTTPS pelo Caddy"
sudo tee /etc/caddy/Caddyfile >/dev/null <<EOF
$DOMAIN {
  reverse_proxy localhost:3100
}
EOF
sudo systemctl restart caddy

say "TURN (coturn) na mesma máquina"
sudo sed -i 's/^#\?TURNSERVER_ENABLED=.*/TURNSERVER_ENABLED=1/' /etc/default/coturn
sudo tee /etc/turnserver.conf >/dev/null <<EOF
listening-port=3478
fingerprint
use-auth-secret
static-auth-secret=$TURN_SECRET
realm=$DOMAIN
# A Oracle entrega o IP público por NAT. Sem esta linha o relay anuncia o IP
# privado da VM e a conexão nunca fecha.
external-ip=${PUBLIC_IP:-$PRIVATE_IP}/$PRIVATE_IP
min-port=${TURN_PORTS%%:*}
max-port=${TURN_PORTS##*:}
no-multicast-peers
no-cli
no-tlsv1
no-tlsv1_1
EOF
sudo systemctl enable -q coturn
sudo systemctl restart coturn

say "Firewall de dentro da máquina"
open_port tcp 80
open_port tcp 443
open_port tcp 3478
open_port udp 3478
open_port udp "$TURN_PORTS"
sudo netfilter-persistent save >/dev/null

say "Conferindo"
sleep 2
for unit in draco caddy coturn; do
  printf '%-8s %s\n' "$unit" "$(systemctl is-active "$unit")"
done
printf '%-8s HTTP %s\n' "local" "$(curl -fsS -o /dev/null -w '%{http_code}' localhost:3100/api/config || echo falhou)"

cat <<EOF

────────────────────────────────────────────────────────────
Endereço      https://$DOMAIN
Conta inicial  cesar1014 (ativação enviada por e-mail quando SMTP estiver configurado)
IP público    ${PUBLIC_IP:-não detectado}

Falta abrir no painel da Oracle (Networking → VCN → Security List →
Add Ingress Rules), senão nada disso responde de fora:

  0.0.0.0/0  TCP  80, 443
  0.0.0.0/0  TCP  3478
  0.0.0.0/0  UDP  3478
  0.0.0.0/0  UDP  ${TURN_PORTS/:/-}

E o DuckDNS tem que apontar pra ${PUBLIC_IP:-o IP acima} antes do Caddy
conseguir o certificado. Se der erro de certificado, corrija o IP no
DuckDNS e rode: sudo systemctl restart caddy

Log ao vivo:  journalctl -u draco -f
────────────────────────────────────────────────────────────
EOF
