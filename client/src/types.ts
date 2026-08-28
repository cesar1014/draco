/** Espelha o que o servidor manda. Mudar aqui exige mudar `server/state.js`. */

export interface Guild {
  id: string;
  name: string;
  initials: string;
  color: string;
}

export interface Channel {
  id: string;
  guildId: string;
  type: "text" | "voice";
  name: string;
  category: string;
}

export interface Member {
  /**
   * Identidade da pessoa, estável entre reconexões. Não é o id do socket. É por
   * isso que o volume ajustado e o tile fixado sobrevivem a uma queda de Wi-Fi.
   */
  id: string;
  username: string;
  color: string;
  voiceChannelId: string | null;
  muted: boolean;
  deafened: boolean;
  camOn: boolean;
  screenOn: boolean;
  speaking: boolean;
  /** Quando entrou no servidor, pra ordenar a lista de Online por chegada. */
  since: number;
  /** Sessão da pessoa no SFU. `null` em malha direta. */
  sfuSessionId: string | null;
  /** Nome de cada trilha publicada no SFU, por slot. É o que se assina. */
  sfuTracks: Partial<Record<MediaSlot, string | null>>;
}

export interface Message {
  id: string;
  channelId: string;
  authorId: string;
  username: string;
  color: string;
  content: string;
  at: number;
}

export interface ServerSnapshot {
  guilds: Guild[];
  channels: Channel[];
  members: Member[];
  messages: Record<string, Message[]>;
  /** Canais em que ainda existe conversa antes da que veio no snapshot. */
  history: Record<string, boolean>;
}

export interface IceConfigResponse {
  iceServers: RTCIceServer[];
  iceTransportPolicy: RTCIceTransportPolicy;
  hasTurn: boolean;
  source: string;
  /** Quando a credencial de TURN vence, em epoch ms. `null` quando não expira. */
  expiresAt: number | null;
  warning: string | null;
}

/**
 * As quatro trilhas que cada conexão carrega, sempre nesta ordem. Em malha a
 * ordem é contrato: quem oferta cria os transceivers assim e quem responde os
 * recebe na mesma sequência, então a posição diz qual trilha que chega é o quê.
 * Com SFU cada trilha tem nome próprio e a ordem deixa de importar.
 */
export type MediaSlot = "mic" | "camera" | "screen" | "screenAudio";

export const SLOT_ORDER: readonly MediaSlot[] = ["mic", "camera", "screen", "screenAudio"] as const;

export const SLOT_KIND: Record<MediaSlot, "audio" | "video"> = {
  mic: "audio",
  camera: "video",
  screen: "video",
  screenAudio: "audio",
};

export interface SignalPayload {
  description?: RTCSessionDescriptionInit;
  candidate?: RTCIceCandidateInit | null;
  /**
   * Pedido de oferta. Só um dos dois lados oferta (ver `VoiceEngine`); se essa
   * oferta não chegar, quem espera cobra em vez de ficar parado pra sempre.
   */
  requestOffer?: true;
}
