import type { IceConfigResponse } from "@/types";

/**
 * Só STUN público. É o fallback quando `/api/ice` não responde, e melhor tentar
 * conectar com o que dá do que não abrir a call.
 */
const FALLBACK: IceConfigResponse = {
  iceServers: [{ urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] }],
  iceTransportPolicy: "all",
  hasTurn: false,
  source: "fallback",
  expiresAt: null,
  warning: "Não foi possível falar com o servidor de configuração. Usando apenas STUN.",
};

/**
 * Quanto tempo uma configuração sem prazo declarado é reaproveitada. Existe
 * porque o fallback e o modo de credencial fixa não trazem `expiresAt`, e sem
 * teto uma sessão longa nunca mais pediria configuração ao servidor: se o TURN
 * fosse ligado no meio do dia, quem estava com a aba aberta ficaria em STUN.
 */
const DEFAULT_TTL_MS = 30 * 60 * 1000;
/** Renova antes do fim: credencial que vence no meio da call é o pior momento. */
const RENEW_BEFORE_MS = 2 * 60 * 1000;

interface Cached {
  config: IceConfigResponse;
  /** Quando este cache deixa de servir, seja por prazo do TURN ou pelo teto local. */
  staleAt: number;
}

let cached: Cached | null = null;
/** Uma busca por vez: seis tiles pedindo junto renderiam seis requisições iguais. */
let inFlight: Promise<IceConfigResponse> | null = null;

async function fetchConfig(refresh: boolean): Promise<IceConfigResponse> {
  const url = refresh ? "/api/ice?refresh=1" : "/api/ice";
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(6000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const config = (await response.json()) as IceConfigResponse;
    const ttl = config.expiresAt ? config.expiresAt - Date.now() : DEFAULT_TTL_MS;
    cached = { config, staleAt: Date.now() + Math.max(ttl, RENEW_BEFORE_MS) };
    return config;
  } catch (error) {
    console.warn("[ice] usando fallback:", error);
    // O fallback também vence: sem isso, uma falha momentânea deixaria a aba em
    // STUN até a pessoa recarregar a página.
    cached = { config: FALLBACK, staleAt: Date.now() + RENEW_BEFORE_MS };
    return FALLBACK;
  }
}

/**
 * Configuração de ICE do servidor. Guardada em cache porque a credencial de TURN
 * vale horas e trocar de canal de voz não deveria render uma requisição, mas com
 * prazo: uma credencial temporária guardada pra sempre é uma call que não conecta
 * amanhã sem ninguém entender por quê.
 *
 * `force` refaz a busca agora e pede ao servidor uma credencial nova. É o que se
 * usa quando o ICE falhou: repetir a mesma credencial recusada não muda nada.
 */
export function loadIceConfig(force = false): Promise<IceConfigResponse> {
  if (!force && cached && Date.now() < cached.staleAt - RENEW_BEFORE_MS) {
    return Promise.resolve(cached.config);
  }
  inFlight ??= fetchConfig(force).finally(() => {
    inFlight = null;
  });
  return inFlight;
}

/**
 * Coleta candidatos ICE num peer descartável só pra dizer o que a rede permite.
 * `srflx` significa que o STUN respondeu; `relay`, que o TURN está de pé. É o
 * que o botão "Testar conexão" das configurações usa.
 */
export async function runIceDiagnostics(config: IceConfigResponse, timeoutMs = 8000) {
  const pc = new RTCPeerConnection({ iceServers: config.iceServers });
  const found = { host: false, srflx: false, relay: false };

  try {
    // Um canal de dados basta pra dar o que negociar e disparar a coleta.
    pc.createDataChannel("probe");
    await pc.setLocalDescription(await pc.createOffer());

    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, timeoutMs);
      pc.onicecandidate = ({ candidate }) => {
        if (!candidate) {
          clearTimeout(timer);
          resolve();
          return;
        }
        const type = candidate.type ?? "";
        if (type === "host") found.host = true;
        if (type === "srflx") found.srflx = true;
        if (type === "relay") {
          found.relay = true;
          // Achou relay: já sabemos o que queríamos, não precisa esperar o resto.
          clearTimeout(timer);
          resolve();
        }
      };
    });
  } finally {
    pc.onicecandidate = null;
    pc.close();
  }

  return found;
}
