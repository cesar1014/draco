/** Espelha o que o servidor manda. Mudar aqui exige mudar `server/state.js`. */

export interface Guild {
  id: string;
  name: string;
  initials: string;
  color: string;
  /** Quem criou. `null` nos servidores do catálogo padrão, que não têm dono. */
  ownerId: string | null;
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

/**
 * Alguém que pertence a um servidor, conectado ou não. Presença é o `Member`; isto
 * é o elenco, que vem do banco. Juntar os dois é o que permite mostrar quem está
 * offline sem inventar estado de call pra quem não está lá.
 */
export interface RosterEntry {
  id: string;
  username: string;
  color: string;
}

export interface ServerSnapshot {
  guilds: Guild[];
  channels: Channel[];
  members: Member[];
  /** guildId -> quem pertence àquele servidor. */
  roster: Record<string, RosterEntry[]>;
  messages: Record<string, Message[]>;
  /** Canais em que ainda existe conversa antes da que veio no snapshot. */
  history: Record<string, boolean>;
}

/** Convite ativo de um servidor, como a tela de administração o mostra. */
export interface Invite {
  code: string;
  guildId: string;
  inviterId: string | null;
  maxUses: number | null;
  uses: number;
  expiresAt: number | null;
  createdAt: number;
}

export interface BanEntry {
  userId: string;
  username: string | null;
  reason: string | null;
  createdAt: number;
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
