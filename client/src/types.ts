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
  id: string;
  username: string;
  color: string;
  voiceChannelId: string | null;
  muted: boolean;
  deafened: boolean;
  camOn: boolean;
  screenOn: boolean;
  speaking: boolean;
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
}

export interface IceConfigResponse {
  iceServers: RTCIceServer[];
  iceTransportPolicy: RTCIceTransportPolicy;
  hasTurn: boolean;
  source: string;
  warning: string | null;
}

/**
 * As quatro trilhas que cada conexão carrega, sempre nesta ordem. A ordem é
 * contrato: quem oferta cria os transceivers assim e quem responde os recebe na
 * mesma sequência, então a posição diz qual trilha que chega é o quê.
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
