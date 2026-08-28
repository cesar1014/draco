/**
 * Cliente da API do Cloudflare Realtime SFU.
 *
 * O segredo do app fica só aqui, no servidor: o navegador nunca fala com a
 * Cloudflare direto. Ele pede pelo socket, este módulo assina a chamada, e a
 * resposta volta pelo mesmo caminho. Sem SFU configurado nada disso é usado e as
 * calls seguem em malha direta entre os navegadores.
 */

const BASE = "https://rtc.live.cloudflare.com/v1";
const TIMEOUT_MS = 10_000;

/** `null` quando não há credenciais, o sinal de "siga em malha". */
export function sfuConfig(env = process.env) {
  const appId = env.CLOUDFLARE_REALTIME_APP_ID?.trim();
  const secret = env.CLOUDFLARE_REALTIME_APP_SECRET?.trim();
  if (!appId || !secret) return null;
  return { appId, secret };
}

async function call(config, method, path, body) {
  const response = await fetch(`${BASE}/apps/${config.appId}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${config.secret}`,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  const text = await response.text();
  let payload = {};
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      throw new Error(`resposta ilegível do SFU (${response.status})`);
    }
  }
  if (!response.ok) {
    throw new Error(payload.errorDescription || `SFU respondeu ${response.status}`);
  }
  // O SFU responde 200 com `errorCode` no corpo em vários casos; tratar como erro
  // aqui evita que o cliente fique esperando uma oferta que nunca vem.
  if (payload.errorCode) {
    throw new Error(payload.errorDescription || payload.errorCode);
  }
  return payload;
}

export const createSession = (config) => call(config, "POST", "/sessions/new");

export const newTracks = (config, sessionId, body) =>
  call(config, "POST", `/sessions/${sessionId}/tracks/new`, body);

export const renegotiate = (config, sessionId, sessionDescription) =>
  call(config, "PUT", `/sessions/${sessionId}/renegotiate`, { sessionDescription });
