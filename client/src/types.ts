/** Espelha o que o servidor manda. Mudar aqui exige mudar `server/state.js`. */

export interface Guild {
  id: string;
  name: string;
  initials: string;
  color: string;
  /** Quem criou. `null` só num servidor cujo dono deixou de existir. */
  ownerId: string | null;
}

export interface Channel {
  id: string;
  guildId: string;
  type: "text" | "voice";
  name: string;
  category: string;
  position: number;
}

export interface Member {
  /**
   * Identidade da pessoa, estável entre reconexões. Não é o id do socket. É por
   * isso que o volume ajustado e o tile fixado sobrevivem a uma queda de Wi-Fi.
   */
  id: string;
  username: string;
  /** ID público único, sem @. Visitantes não possuem um. */
  publicId: string | null;
  color: string;
  voiceChannelId: string | null;
  muted: boolean;
  deafened: boolean;
  camOn: boolean;
  screenOn: boolean;
  speaking: boolean;
  /** Quando entrou no servidor, pra ordenar a lista de Online por chegada. */
  since: number;
  /** Visitantes existem apenas enquanto o socket está aberto. */
  guest?: boolean;
  guestGuildId?: string | null;
  /** Sessão da pessoa no SFU. `null` em malha direta. */
  sfuSessionId: string | null;
  /** Nome de cada trilha publicada no SFU, por slot. É o que se assina. */
  sfuTracks: Partial<Record<MediaSlot, string | null>>;
  presence: PresenceState;
  customStatus: string | null;
  statusExpiresAt: number | null;
}

export interface ScreenViewer {
  id: string;
  username: string;
  color: string;
  startedAt: number;
}

export interface Message {
  sequence: number;
  id: string;
  channelId: string;
  authorId: string;
  username: string;
  color: string;
  content: string;
  at: number;
  mentions?: Array<{ type: "user" | "role" | "everyone"; id: string }>;
  editedAt?: number | null;
  deletedAt?: number | null;
  replyToId?: string | null;
  reply?: MessageReference | null;
  reactions?: MessageReaction[];
  attachments?: Attachment[];
}

export interface Attachment {
  id: string;
  filename: string;
  mime: "image/jpeg" | "image/png" | "image/gif" | "image/webp" | "application/pdf";
  size: number;
  url: string;
  width?: number | null;
  height?: number | null;
  at: number;
}

export interface MessageReference {
  id: string;
  authorId: string;
  username: string;
  content: string | null;
  deleted: boolean;
}

export interface MessageReaction {
  emoji: string;
  count: number;
  userIds: string[];
}

export type PresenceMode = "online" | "away" | "dnd" | "invisible";
export type PresenceState = Exclude<PresenceMode, "invisible"> | "offline";

export interface SocialPerson {
  id: string;
  /** Alias legado do ID público. */
  username: string;
  publicId: string;
  displayName: string;
  color: string;
  avatarUrl: string | null;
  customStatus: string | null;
  statusExpiresAt: number | null;
  since: number;
}

export interface Relationships {
  friends: SocialPerson[];
  incomingRequests: SocialPerson[];
  outgoingRequests: SocialPerson[];
  blocked: SocialPerson[];
}

export interface UnreadState {
  unread: boolean;
  mentions: number;
  lastReadSequence: number;
}

export interface DracoNotification {
  id: string;
  kind: "direct" | "mention" | "friend_request" | "call" | "social";
  actorId: string | null;
  conversationType: "channel" | "direct" | null;
  conversationId: string | null;
  metadata: Record<string, unknown>;
  readAt: number | null;
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
  publicId: string | null;
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
  /** Permissões efetivas da conta em cada servidor. */
  permissions: Record<string, GuildPermission[]>;
  /** Cargos visíveis e atribuições, agrupados por servidor. */
  roles: Record<string, Role[]>;
  memberRoles: Record<string, Record<string, string[]>>;
  directThreads?: DirectThread[];
  directMessages?: Record<string, DirectMessage[]>;
  relationships?: Relationships;
  unread?: Record<string, UnreadState>;
  notifications?: DracoNotification[];
  sfuHealth?: SfuHealth;
}

export interface SfuHealth {
  status: "AVAILABLE" | "DEGRADED" | "UNAVAILABLE";
  checkedAt: number | null;
  detail: string;
}

export interface Account {
  id: string;
  email: string | null;
  /** Alias legado do nome exibido. */
  username: string;
  displayName: string;
  publicId: string | null;
  isSystemAdmin: boolean;
  guest?: boolean;
}

export type GuildPermission =
  | "view_channels"
  | "send_messages"
  | "connect"
  | "speak"
  | "manage_channels"
  | "create_invites"
  | "ban_members"
  | "manage_roles"
  | "manage_messages"
  | "moderate_members"
  | "mention_everyone"
  | "view_audit_log";

export interface Role {
  id: string;
  guildId: string;
  name: string;
  color: string | null;
  permissions: GuildPermission[];
  isDefault: boolean;
  position: number;
}

export interface DirectThread {
  id: string;
  peer: RosterEntry;
  lastContent: string | null;
  lastAt: number | null;
}

export interface DirectMessage {
  sequence: number;
  id: string;
  threadId: string;
  authorId: string;
  username: string;
  color: string;
  content: string;
  at: number;
  editedAt?: number | null;
  deletedAt?: number | null;
  replyToId?: string | null;
  reply?: MessageReference | null;
  reactions?: MessageReaction[];
  attachments?: Attachment[];
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
  moderatorId: string | null;
  moderatorUsername: string | null;
  reason: string | null;
  createdAt: number;
}

export interface TimeoutEntry {
  userId: string;
  username: string | null;
  reason: string | null;
  expiresAt: number;
  createdAt: number;
}

export interface AuditEntry {
  id: string;
  actorId: string | null;
  actorUsername: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  metadata: Record<string, unknown>;
  at: number;
}

export interface ChannelOverwrite {
  targetType: "role" | "member";
  targetId: string;
  allow: GuildPermission[];
  deny: GuildPermission[];
  updatedAt: number;
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
