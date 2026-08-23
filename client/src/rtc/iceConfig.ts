import type { IceConfigResponse } from "@/types";

/**
 * Só STUN público. É o fallback quando `/api/ice` não responde — melhor tentar
 * conectar com o que dá do que não abrir a call.
 */
const FALLBACK: IceConfigResponse = {
  iceServers: [{ urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] }],
  iceTransportPolicy: "all",
  hasTurn: false,
  source: "fallback",
  warning: "Não foi possível falar com o servidor de configuração. Usando apenas STUN.",
};

let cached: IceConfigResponse | null = null;

/**
 * Busca a configuração de ICE no servidor. Fica em cache porque a credencial de
 * TURN vale horas e trocar de canal de voz não deveria render uma requisição.
 */
export async function loadIceConfig(): Promise<IceConfigResponse> {
  if (cached) return cached;
  try {
    const response = await fetch("/api/ice", { signal: AbortSignal.timeout(6000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    cached = (await response.json()) as IceConfigResponse;
  } catch (error) {
    console.warn("[ice] usando fallback:", error);
    cached = FALLBACK;
  }
  return cached;
}

export function clearIceCache() {
  cached = null;
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
