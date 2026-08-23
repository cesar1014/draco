import { createHmac } from "node:crypto";

/**
 * Monta a configuração de ICE no servidor, não no cliente. O motivo prático:
 * chave de API de TURN não pode ir pro navegador, e trocar de provedor passa a
 * ser mexer no `.env` em vez de rebuildar o front.
 */

/** STUN só descobre seu IP público — resolve rede local e NAT simples, de graça. */
const DEFAULT_STUN = [
  { urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] },
  { urls: "stun:stun.cloudflare.com:3478" },
];

/** Credencial buscada por HTTP é cacheada: elas valem horas, não faz sentido pedir a cada F5. */
const CACHE_MS = 4 * 60 * 1000;
/** Validade da credencial gerada por HMAC no modo coturn. */
const HMAC_TTL_SECONDS = 12 * 60 * 60;

let cache = null;

function hasTurnServer(iceServers) {
  return iceServers.some((server) => {
    const urls = Array.isArray(server?.urls) ? server.urls : [server?.urls];
    return urls.some((url) => typeof url === "string" && /^turns?:/.test(url));
  });
}

/**
 * Modo coturn `use-auth-secret`: o usuário é um timestamp de expiração e a senha
 * é o HMAC dele. Não existe cadastro de usuário no TURN — quem sabe o segredo
 * consegue emitir credencial temporária.
 */
function hmacCredentials(host, secret) {
  const username = `${Math.floor(Date.now() / 1000) + HMAC_TTL_SECONDS}:discord-clone`;
  const credential = createHmac("sha1", secret).update(username).digest("base64");
  return { urls: host.split(",").map((u) => u.trim()).filter(Boolean), username, credential };
}

async function fetchCredentials(url) {
  // Sem timeout, um provedor fora do ar travaria o carregamento da call inteira.
  const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const body = await response.json();
  // Provedores divergem: uns devolvem o array cru, outros embrulham em `iceServers`.
  const servers = Array.isArray(body) ? body : body?.iceServers;
  if (!Array.isArray(servers) || servers.length === 0) throw new Error("resposta sem iceServers");
  return servers;
}

/**
 * @returns {Promise<{iceServers: RTCIceServer[], iceTransportPolicy: string, hasTurn: boolean, source: string, warning: string|null}>}
 */
export async function resolveIceConfig(env = process.env) {
  const iceTransportPolicy = env.TURN_ONLY === "1" ? "relay" : "all";
  let warning = null;
  let source = "stun";
  let turnServers = [];

  if (env.TURN_URL && env.TURN_USERNAME && env.TURN_PASSWORD) {
    source = "static";
    turnServers = [
      {
        urls: env.TURN_URL.split(",").map((u) => u.trim()).filter(Boolean),
        username: env.TURN_USERNAME,
        credential: env.TURN_PASSWORD,
      },
    ];
  } else if (env.TURN_CREDENTIALS_URL) {
    source = "rest";
    if (cache && Date.now() - cache.at < CACHE_MS) {
      turnServers = cache.servers;
    } else {
      try {
        turnServers = await fetchCredentials(env.TURN_CREDENTIALS_URL);
        cache = { at: Date.now(), servers: turnServers };
      } catch (error) {
        // Degradar pra STUN é melhor que não conectar ninguém: quem estiver na
        // mesma rede continua funcionando, e a UI avisa que o TURN caiu.
        warning = `Falha ao buscar credenciais de TURN (${error.message}). Usando apenas STUN.`;
        source = "stun";
      }
    }
  } else if (env.TURN_HOST && env.TURN_SECRET) {
    source = "hmac";
    turnServers = [hmacCredentials(env.TURN_HOST, env.TURN_SECRET)];
  }

  const iceServers = [...DEFAULT_STUN, ...turnServers];
  const turnPresent = hasTurnServer(iceServers);

  if (!turnPresent && !warning) {
    warning =
      "TURN não configurado: chamadas entre redes diferentes podem falhar. " +
      "Veja a seção TURN do .env.example.";
  }
  if (iceTransportPolicy === "relay" && !turnPresent) {
    warning = "TURN_ONLY=1 sem TURN configurado — nenhuma conexão vai fechar. Corrija o .env.";
  }

  return { iceServers, iceTransportPolicy, hasTurn: turnPresent, source, warning };
}
