import { createHmac } from "node:crypto";
import { logger, reason } from "./log.js";

/**
 * Monta a configuração de ICE no servidor, não no cliente. O motivo prático:
 * chave de API de TURN não pode ir pro navegador, e trocar de provedor passa a
 * ser mexer no `.env` em vez de rebuildar o front.
 */

const log = logger("TURN");

/** STUN só descobre seu IP público: resolve rede local e NAT simples, de graça. */
const DEFAULT_STUN = [
  { urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] },
  { urls: "stun:stun.cloudflare.com:3478" },
];

/**
 * Quanto tempo a credencial buscada por HTTP vale aqui. Provedores costumam emitir
 * por horas, mas guardar até o último minuto é arriscado: quem pegou a
 * configuração no fim da validade entraria numa call com credencial que expira no
 * meio dela. Uma hora dá margem sobrando.
 */
const CACHE_TTL_MS = 60 * 60 * 1000;
/** Renova antes de vencer, pra ninguém receber uma credencial já no fim da vida. */
const RENEW_BEFORE_MS = 10 * 60 * 1000;
/** Validade da credencial gerada por HMAC no modo coturn. */
const HMAC_TTL_SECONDS = 12 * 60 * 60;

/**
 * Espera depois de uma falha, dobrando até o teto. Sem isso, um provedor fora do
 * ar renderia uma requisição HTTP por pessoa que abre a página; com um teto
 * fixo alto, a primeira falha prenderia a sala em STUN por muito tempo.
 */
const RETRY_BASE_MS = 5_000;
const RETRY_MAX_MS = 5 * 60 * 1000;

/** `null` até a primeira busca. Guarda a credencial e até quando ela vale. */
let cache = null;
/** Estado do retry: quando pode tentar de novo e quantas falhas seguidas houve. */
let backoff = { until: 0, failures: 0 };

function hasTurnServer(iceServers) {
  return iceServers.some((server) => {
    const urls = Array.isArray(server?.urls) ? server.urls : [server?.urls];
    return urls.some((url) => typeof url === "string" && /^turns?:/.test(url));
  });
}

/**
 * Modo coturn `use-auth-secret`: o usuário é um timestamp de expiração e a senha
 * é o HMAC dele. Não existe cadastro de usuário no TURN: quem sabe o segredo
 * consegue emitir credencial temporária.
 */
function hmacCredentials(host, secret) {
  const expiresAt = Date.now() + HMAC_TTL_SECONDS * 1000;
  const username = `${Math.floor(expiresAt / 1000)}:draco`;
  const credential = createHmac("sha1", secret).update(username).digest("base64");
  return {
    servers: [
      { urls: host.split(",").map((u) => u.trim()).filter(Boolean), username, credential },
    ],
    expiresAt,
  };
}

async function fetchCredentials(url) {
  // Sem timeout, um provedor fora do ar travaria o carregamento da call inteira.
  const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const body = await response.json();
  // Provedores divergem: uns devolvem o array cru, outros embrulham em `iceServers`.
  const servers = Array.isArray(body) ? body : body?.iceServers;
  if (!Array.isArray(servers) || servers.length === 0) throw new Error("resposta sem iceServers");
  // Alguns informam a validade; quando não informam, o TTL local decide.
  const ttlSeconds = Number(body?.ttl);
  const lifetime = Number.isFinite(ttlSeconds) && ttlSeconds > 0 ? ttlSeconds * 1000 : CACHE_TTL_MS;
  return { servers, expiresAt: Date.now() + Math.min(lifetime, CACHE_TTL_MS) };
}

/**
 * Descarta a credencial guardada e libera uma nova tentativa imediata. O cliente
 * chama isso quando o ICE falha com TURN no ar: a credencial pode ter sido
 * revogada, e insistir na mesma só repetiria a falha até o TTL acabar.
 */
export function invalidateIceCache() {
  cache = null;
  backoff = { until: 0, failures: 0 };
}

/** Busca com backoff. `null` significa "siga com o que tem, não é hora de tentar". */
async function refreshRestCredentials(url) {
  if (Date.now() < backoff.until) return null;
  try {
    const fresh = await fetchCredentials(url);
    backoff = { until: 0, failures: 0 };
    log.info("credenciais renovadas", { validadeMs: fresh.expiresAt - Date.now() });
    return fresh;
  } catch (error) {
    backoff = {
      failures: backoff.failures + 1,
      until: Date.now() + Math.min(RETRY_BASE_MS * 2 ** backoff.failures, RETRY_MAX_MS),
    };
    log.warn("falha ao buscar credenciais", {
      motivo: reason(error),
      tentativas: backoff.failures,
      proximaEmMs: backoff.until - Date.now(),
    });
    return null;
  }
}

/**
 * @returns {Promise<{iceServers: RTCIceServer[], iceTransportPolicy: string, hasTurn: boolean, source: string, expiresAt: number|null, warning: string|null}>}
 */
export async function resolveIceConfig(env = process.env) {
  const iceTransportPolicy = env.TURN_ONLY === "1" ? "relay" : "all";
  let warning = null;
  let source = "stun";
  let turnServers = [];
  let expiresAt = null;

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
    const stale = !cache || cache.expiresAt - Date.now() < RENEW_BEFORE_MS;
    const fresh = stale ? await refreshRestCredentials(env.TURN_CREDENTIALS_URL) : null;
    if (fresh) cache = fresh;

    if (cache && cache.expiresAt > Date.now()) {
      turnServers = cache.servers;
      expiresAt = cache.expiresAt;
    } else {
      // Degradar pra STUN mantém a maioria conectada: quem estiver na mesma rede
      // continua funcionando, e a UI avisa que o TURN caiu. A próxima chamada
      // tenta de novo quando o backoff permitir, então uma falha inicial não
      // prende a sessão em STUN pra sempre.
      cache = null;
      source = "stun";
      warning = "Não foi possível obter credenciais de TURN. Usando apenas STUN; nova tentativa em instantes.";
    }
  } else if (env.TURN_HOST && env.TURN_SECRET) {
    source = "hmac";
    const generated = hmacCredentials(env.TURN_HOST, env.TURN_SECRET);
    turnServers = generated.servers;
    expiresAt = generated.expiresAt;
  }

  const iceServers = [...DEFAULT_STUN, ...turnServers];
  const turnPresent = hasTurnServer(iceServers);

  if (!turnPresent && !warning) {
    warning =
      "TURN não configurado: chamadas entre redes diferentes podem falhar. " +
      "Veja a seção TURN do .env.example.";
  }
  if (iceTransportPolicy === "relay" && !turnPresent) {
    warning = "TURN_ONLY=1 sem TURN configurado: nenhuma conexão vai fechar. Corrija o .env.";
  }

  return { iceServers, iceTransportPolicy, hasTurn: turnPresent, source, expiresAt, warning };
}
