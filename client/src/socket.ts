import { io, type Socket } from "socket.io-client";
import type {
  BanEntry,
  Account,
  Channel,
  DirectMessage,
  DirectThread,
  Guild,
  Invite,
  MediaSlot,
  Member,
  Message,
  RosterEntry,
  Role,
  GuildPermission,
  IceConfigResponse,
  ServerSnapshot,
  SignalPayload,
  Relationships,
  PresenceMode,
  DracoNotification,
  TimeoutEntry,
  AuditEntry,
  ChannelOverwrite,
  SfuHealth,
} from "@/types";

/**
 * Contrato de eventos com `server/signaling.js`, escrito como tipo pra o
 * compilador reclamar quando um lado mudar sem o outro. Sinalização errada não
 * dá erro em tempo de execução, só uma call que não conecta e ninguém sabe por
 * quê, então é o tipo de descuido que vale caro deixar passar.
 */
interface ServerEvents {
  "member:joined": (member: Member) => void;
  "member:state": (member: Member) => void;
  "member:left": (payload: { id: string }) => void;
  "chat:message": (message: Message) => void;
  "chat:updated": (message: Message) => void;
  "voice:peer-joined": (payload: { channelId: string; member: Member }) => void;
  "voice:peer-left": (payload: { channelId: string; memberId: string }) => void;
  "voice:channel-closed": (payload: { channelId: string }) => void;
  "voice:moderated": (payload: { channelId: string }) => void;
  "rtc:signal": (payload: SignalPayload & { from: string }) => void;
  "channel:created": (payload: { channel: Channel }) => void;
  "channel:deleted": (payload: { guildId: string; channelId: string }) => void;
  "channels:reordered": (payload: { guildId: string; channels: Channel[] }) => void;
  "guild:member-joined": (payload: { guildId: string; member: RosterEntry }) => void;
  "guild:member-left": (payload: { guildId: string; userId: string }) => void;
  "guild:banned": (payload: { guildId: string }) => void;
  "guild:kicked": (payload: { guildId: string }) => void;
  "role:changed": (payload: {
    guildId: string;
    roles: Role[];
    memberRoles: Record<string, string[]>;
  }) => void;
  "direct:thread": (thread: DirectThread) => void;
  "direct:message": (message: DirectMessage) => void;
  "direct:updated": (message: DirectMessage) => void;
  "relationship:update": (relationships: Relationships) => void;
  "notification:new": (notification: DracoNotification) => void;
  "sfu:health": (health: SfuHealth) => void;
}

export interface VoiceFlags {
  muted: boolean;
  deafened: boolean;
  camOn: boolean;
  screenOn: boolean;
  speaking: boolean;
}

export interface IdentifyReply {
  ok: boolean;
  error?: string;
  selfId?: string;
  /**
   * Token de sessão assinado pelo servidor. Só vem quando muda — na primeira
   * entrada ou perto de vencer — e é o que o navegador guarda pra voltar como a
   * mesma pessoa. A identidade em si não é prova de nada: sem a assinatura, o
   * servidor emite outra.
   */
  token?: string;
  guestToken?: string;
  /** O servidor tem credenciais do SFU: a mídia passa por servidor. */
  sfu?: boolean;
  state?: ServerSnapshot;
  account?: Account;
}

export interface VoiceJoinReply {
  ok: boolean;
  error?: string;
  channelId?: string;
  peers?: Member[];
  sfu?: boolean;
  sfuHealth?: SfuHealth;
}

export interface ChatHistoryReply {
  ok: boolean;
  error?: string;
  channelId?: string;
  /** Página anterior, mais antiga primeiro, pra concatenar direto antes do que já existe. */
  messages?: Message[];
  more?: boolean;
}

/** Resposta comum dos eventos `sfu:*`. Erro nunca é fatal: o cliente cai pra malha. */
interface SfuReply {
  ok: boolean;
  error?: string;
}

/** Resposta mínima de uma ação administrativa. */
export interface Ack {
  ok: boolean;
  error?: string;
}

/**
 * Ações que mudam a que servidores a pessoa pertence devolvem o snapshot inteiro.
 * É mais dado do que um delta, e é de propósito: entrar num servidor traz canais,
 * elenco e conversa de uma vez, e aplicar isso por partes na ordem certa é onde
 * costumam nascer telas que discordam do servidor.
 */
export interface GuildReply extends Ack {
  guild?: Guild;
  guildId?: string;
  state?: ServerSnapshot;
}

export interface ChannelReply extends Ack {
  channel?: Channel;
  channels?: Channel[];
}

export interface InviteReply extends Ack {
  code?: string;
  invites?: Invite[];
}

export interface BanReply extends Ack {
  bans?: BanEntry[];
}

/** O painel de administração pede tudo de uma vez: um evento, uma ida ao banco. */
export interface AdminReply extends Ack {
  owner?: boolean;
  roster?: RosterEntry[];
  invites?: Invite[];
  bans?: BanEntry[];
  permissions?: GuildPermission[];
  roles?: Role[];
  memberRoles?: Record<string, string[]>;
  availablePermissions?: GuildPermission[];
  timeouts?: TimeoutEntry[];
  auditLog?: AuditEntry[];
}

export interface RoleReply extends Ack {
  role?: Role;
  roles?: Role[];
  memberRoles?: Record<string, string[]>;
}

export interface ModerationReply extends Ack {
  expiresAt?: number;
  timeouts?: TimeoutEntry[];
}

export interface OverwriteReply extends Ack {
  overwrites?: ChannelOverwrite[];
}

export interface DirectReply extends Ack {
  thread?: DirectThread;
  messages?: DirectMessage[];
  message?: DirectMessage;
}

export interface MessageReply extends Ack {
  message?: Message | DirectMessage;
}

export interface RelationshipReply extends Ack {
  relationships?: Relationships;
  profile?: {
    presenceMode: PresenceMode;
    customStatus: string | null;
    statusExpiresAt: number | null;
  };
}

interface SfuPublishReply extends SfuReply {
  description?: RTCSessionDescriptionInit | null;
}
interface SfuSubscribeReply extends SfuReply {
  description?: RTCSessionDescriptionInit | null;
  requiresImmediateRenegotiation?: boolean;
  tracks?: Array<{ mid: string | null; trackName: string | null }>;
}

interface ClientEvents {
  identify: (
    payload: { token?: string | null; guest?: { username?: string; inviteCode?: string; age?: number; token?: string } },
    ack: (reply: IdentifyReply) => void,
  ) => void;
  "ice:get": (
    payload: { refresh: boolean },
    ack: (reply: { ok: boolean; error?: string; config?: IceConfigResponse }) => void,
  ) => void;
  "chat:send": (payload: { channelId: string; content: string; replyToId?: string | null }, ack: (reply: MessageReply) => void) => void;
  "chat:edit": (payload: { messageId: string; content: string }, ack: (reply: MessageReply) => void) => void;
  "chat:delete": (payload: { messageId: string }, ack: (reply: MessageReply) => void) => void;
  "chat:react": (payload: { messageId: string; emoji: string }, ack: (reply: MessageReply) => void) => void;
  "chat:history": (
    payload: { channelId: string; beforeId: string },
    ack: (reply: ChatHistoryReply) => void,
  ) => void;
  "voice:join": (payload: { channelId: string }, ack: (reply: VoiceJoinReply) => void) => void;
  "voice:leave": () => void;
  "voice:state": (payload: Partial<VoiceFlags>) => void;
  "rtc:signal": (payload: SignalPayload & { to: string }) => void;
  "sfu:join": (payload: Record<string, never>, ack: (reply: SfuReply) => void) => void;
  "sfu:publish": (
    payload: {
      description: RTCSessionDescriptionInit;
      tracks: Array<{ mid: string; slot: MediaSlot }>;
    },
    ack: (reply: SfuPublishReply) => void,
  ) => void;
  "sfu:subscribe": (
    payload: { tracks: Array<{ memberId: string; slot: MediaSlot; sessionId: string }> },
    ack: (reply: SfuSubscribeReply) => void,
  ) => void;
  "sfu:renegotiate": (
    payload: { role: "send" | "recv"; description: RTCSessionDescriptionInit },
    ack: (reply: SfuReply) => void,
  ) => void;

  // --- administração ------------------------------------------------------
  "guild:create": (payload: { name: string }, ack: (reply: GuildReply) => void) => void;
  "guild:leave": (payload: { guildId: string }, ack: (reply: GuildReply) => void) => void;
  "guild:admin": (payload: { guildId: string }, ack: (reply: AdminReply) => void) => void;
  "channel:create": (
    payload: { guildId: string; type: "text" | "voice"; name: string },
    ack: (reply: ChannelReply) => void,
  ) => void;
  "channel:delete": (payload: { channelId: string }, ack: (reply: Ack) => void) => void;
  "channel:reorder": (payload: { guildId: string; orderedIds: string[] }, ack: (reply: ChannelReply) => void) => void;
  "invite:create": (
    payload: { guildId: string; maxUses?: number | null; expiresInHours?: number | null },
    ack: (reply: InviteReply) => void,
  ) => void;
  "invite:accept": (payload: { code: string }, ack: (reply: GuildReply) => void) => void;
  "invite:revoke": (
    payload: { guildId: string; code: string },
    ack: (reply: InviteReply) => void,
  ) => void;
  "invite:list": (payload: { guildId: string }, ack: (reply: InviteReply) => void) => void;
  "member:ban": (
    payload: { guildId: string; userId: string; reason?: string },
    ack: (reply: BanReply) => void,
  ) => void;
  "member:unban": (
    payload: { guildId: string; userId: string },
    ack: (reply: BanReply) => void,
  ) => void;
  "member:kick": (payload: { guildId: string; userId: string; reason?: string }, ack: (reply: Ack) => void) => void;
  "member:timeout": (payload: { guildId: string; userId: string; durationMs: number; reason?: string }, ack: (reply: ModerationReply) => void) => void;
  "member:timeout-remove": (payload: { guildId: string; userId: string }, ack: (reply: ModerationReply) => void) => void;
  "channel:permissions": (payload: { channelId: string; operation: "list" | "set"; targetType?: "role" | "member"; targetId?: string; allow?: GuildPermission[]; deny?: GuildPermission[] }, ack: (reply: OverwriteReply) => void) => void;
  "role:create": (
    payload: { guildId: string; name: string; color?: string | null; permissions: GuildPermission[] },
    ack: (reply: RoleReply) => void,
  ) => void;
  "role:update": (
    payload: { guildId: string; roleId: string; name: string; color?: string | null; permissions: GuildPermission[] },
    ack: (reply: RoleReply) => void,
  ) => void;
  "role:delete": (payload: { guildId: string; roleId: string }, ack: (reply: RoleReply) => void) => void;
  "role:assign": (
    payload: { guildId: string; userId: string; roleId: string; assigned: boolean },
    ack: (reply: RoleReply) => void,
  ) => void;
  "role:reorder": (payload: { guildId: string; orderedIds: string[] }, ack: (reply: RoleReply) => void) => void;
  "direct:open": (payload: { userId: string }, ack: (reply: DirectReply) => void) => void;
  "direct:history": (payload: { threadId: string }, ack: (reply: DirectReply) => void) => void;
  "direct:send": (payload: { threadId: string; content: string; replyToId?: string | null }, ack: (reply: DirectReply) => void) => void;
  "direct:edit": (payload: { messageId: string; content: string }, ack: (reply: MessageReply) => void) => void;
  "direct:delete": (payload: { messageId: string }, ack: (reply: MessageReply) => void) => void;
  "direct:react": (payload: { messageId: string; emoji: string }, ack: (reply: MessageReply) => void) => void;
  "friend:request": (payload: { username: string }, ack: (reply: RelationshipReply) => void) => void;
  "friend:accept": (payload: { userId: string }, ack: (reply: RelationshipReply) => void) => void;
  "friend:reject": (payload: { userId: string }, ack: (reply: RelationshipReply) => void) => void;
  "friend:cancel": (payload: { userId: string }, ack: (reply: RelationshipReply) => void) => void;
  "friend:remove": (payload: { userId: string }, ack: (reply: RelationshipReply) => void) => void;
  "friend:block": (payload: { userId: string }, ack: (reply: RelationshipReply) => void) => void;
  "friend:unblock": (payload: { userId: string }, ack: (reply: RelationshipReply) => void) => void;
  "presence:update": (
    payload: { mode: PresenceMode; status: string | null; expiresAt: number | null },
    ack: (reply: RelationshipReply) => void,
  ) => void;
  "notification:read": (payload: { id: string }, ack: (reply: Ack) => void) => void;
  "read:mark": (
    payload: { type: "channel" | "direct"; id: string; sequence: number },
    ack: (reply: Ack) => void,
  ) => void;
}

export type AppSocket = Socket<ServerEvents, ClientEvents>;

/**
 * Conecta na mesma origem da página. Em desenvolvimento o Vite faz proxy pro
 * servidor de sinalização, em produção é o mesmo processo. Um endereço só
 * significa que o link do túnel serve a página e o websocket juntos.
 */
export function createSocket(): AppSocket {
  return io({
    autoConnect: false,
    // Reconexão agressiva de propósito: cair da call por uma oscilação de Wi-Fi
    // é o defeito mais irritante que um app de call pode ter.
    reconnectionDelay: 500,
    reconnectionDelayMax: 4000,
    // Generoso porque hospedagem de plano grátis desliga o serviço quando ninguém
    // acessa, e a primeira conexão é ela acordando, o que leva bem mais que isso.
    // Um teto curto aqui transforma "está acordando" em "não foi possível falar
    // com o servidor", que manda a pessoa procurar o problema no lugar errado.
    timeout: 45000,
  });
}

/** Ack com prazo: sem isso um servidor mudo travaria a entrada pra sempre. */
function ask<T extends SfuReply>(
  send: (resolve: (reply: T) => void) => void,
  timeoutMs = 12_000,
): Promise<T> {
  return new Promise<T>((resolve) => {
    let done = false;
    const finish = (reply: T) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(reply);
    };
    const timer = setTimeout(() => finish({ ok: false, error: "timeout" } as T), timeoutMs);
    send(finish);
  });
}

export const identify = (
  socket: AppSocket,
  token: string | null,
) =>
  new Promise<IdentifyReply>((resolve) =>
    socket.emit("identify", { token }, resolve),
  );

export const identifyGuest = (
  socket: AppSocket,
  username: string,
  inviteCode: string,
  age: number,
  token?: string,
) =>
  new Promise<IdentifyReply>((resolve) =>
    socket.emit("identify", { guest: { username, inviteCode, age, token } }, resolve),
  );

export const joinVoiceChannel = (socket: AppSocket, channelId: string) =>
  new Promise<VoiceJoinReply>((resolve) => socket.emit("voice:join", { channelId }, resolve));

export const requestIceConfig = async (socket: AppSocket, refresh: boolean) => {
  const reply = await ask<{ ok: boolean; error?: string; config?: IceConfigResponse }>((resolve) =>
    socket.emit("ice:get", { refresh }, resolve),
  );
  if (!reply.ok || !reply.config) throw new Error(reply.error ?? "ice-config-failed");
  return reply.config;
};

export const loadChatHistory = (socket: AppSocket, channelId: string, beforeId: string) =>
  ask<ChatHistoryReply>((resolve) => socket.emit("chat:history", { channelId, beforeId }, resolve));

export const sfuJoin = (socket: AppSocket) =>
  ask<SfuReply>((resolve) => socket.emit("sfu:join", {}, resolve));

export const sfuPublish = (
  socket: AppSocket,
  description: RTCSessionDescriptionInit,
  tracks: Array<{ mid: string; slot: MediaSlot }>,
) => ask<SfuPublishReply>((resolve) => socket.emit("sfu:publish", { description, tracks }, resolve));

export const sfuSubscribe = (
  socket: AppSocket,
  tracks: Array<{ memberId: string; slot: MediaSlot; sessionId: string }>,
) => ask<SfuSubscribeReply>((resolve) => socket.emit("sfu:subscribe", { tracks }, resolve));

export const sfuRenegotiate = (
  socket: AppSocket,
  role: "send" | "recv",
  description: RTCSessionDescriptionInit,
) => ask<SfuReply>((resolve) => socket.emit("sfu:renegotiate", { role, description }, resolve));

// --- administração -----------------------------------------------------------
// Todas com prazo: cada uma escreve no banco, e um servidor mudo travaria a tela
// esperando uma resposta que não vem.

export const createGuild = (socket: AppSocket, name: string) =>
  ask<GuildReply>((resolve) => socket.emit("guild:create", { name }, resolve));

export const leaveGuild = (socket: AppSocket, guildId: string) =>
  ask<GuildReply>((resolve) => socket.emit("guild:leave", { guildId }, resolve));

export const loadGuildAdmin = (socket: AppSocket, guildId: string) =>
  ask<AdminReply>((resolve) => socket.emit("guild:admin", { guildId }, resolve));

export const createChannel = (
  socket: AppSocket,
  guildId: string,
  type: "text" | "voice",
  name: string,
) => ask<ChannelReply>((resolve) => socket.emit("channel:create", { guildId, type, name }, resolve));

export const deleteChannel = (socket: AppSocket, channelId: string) =>
  ask<Ack>((resolve) => socket.emit("channel:delete", { channelId }, resolve));

export const reorderChannels = (socket: AppSocket, guildId: string, orderedIds: string[]) =>
  ask<ChannelReply>((resolve) => socket.emit("channel:reorder", { guildId, orderedIds }, resolve));

export const createInvite = (
  socket: AppSocket,
  guildId: string,
  options: { maxUses?: number | null; expiresInHours?: number | null } = {},
) => ask<InviteReply>((resolve) => socket.emit("invite:create", { guildId, ...options }, resolve));

export const acceptInvite = (socket: AppSocket, code: string) =>
  ask<GuildReply>((resolve) => socket.emit("invite:accept", { code }, resolve));

export const revokeInvite = (socket: AppSocket, guildId: string, code: string) =>
  ask<InviteReply>((resolve) => socket.emit("invite:revoke", { guildId, code }, resolve));

export const banMember = (socket: AppSocket, guildId: string, userId: string, reason?: string) =>
  ask<BanReply>((resolve) => socket.emit("member:ban", { guildId, userId, reason }, resolve));

export const unbanMember = (socket: AppSocket, guildId: string, userId: string) =>
  ask<BanReply>((resolve) => socket.emit("member:unban", { guildId, userId }, resolve));

export const kickMember = (socket: AppSocket, guildId: string, userId: string, reason?: string) =>
  ask<Ack>((resolve) => socket.emit("member:kick", { guildId, userId, reason }, resolve));

export const timeoutMember = (socket: AppSocket, guildId: string, userId: string, durationMs: number, reason?: string) =>
  ask<ModerationReply>((resolve) => socket.emit("member:timeout", { guildId, userId, durationMs, reason }, resolve));

export const removeMemberTimeout = (socket: AppSocket, guildId: string, userId: string) =>
  ask<ModerationReply>((resolve) => socket.emit("member:timeout-remove", { guildId, userId }, resolve));

export const loadChannelPermissions = (socket: AppSocket, channelId: string) =>
  ask<OverwriteReply>((resolve) => socket.emit("channel:permissions", { channelId, operation: "list" }, resolve));

export const saveChannelPermissions = (
  socket: AppSocket,
  channelId: string,
  targetType: "role" | "member",
  targetId: string,
  allow: GuildPermission[],
  deny: GuildPermission[],
) => ask<OverwriteReply>((resolve) => socket.emit("channel:permissions", { channelId, operation: "set", targetType, targetId, allow, deny }, resolve));

export const createRole = (
  socket: AppSocket,
  guildId: string,
  name: string,
  color: string | null,
  permissions: GuildPermission[],
) => ask<RoleReply>((resolve) => socket.emit("role:create", { guildId, name, color, permissions }, resolve));

export const updateRole = (
  socket: AppSocket,
  guildId: string,
  roleId: string,
  name: string,
  color: string | null,
  permissions: GuildPermission[],
) => ask<RoleReply>((resolve) => socket.emit("role:update", { guildId, roleId, name, color, permissions }, resolve));

export const deleteRole = (socket: AppSocket, guildId: string, roleId: string) =>
  ask<RoleReply>((resolve) => socket.emit("role:delete", { guildId, roleId }, resolve));

export const assignRole = (
  socket: AppSocket,
  guildId: string,
  userId: string,
  roleId: string,
  assigned: boolean,
) => ask<RoleReply>((resolve) => socket.emit("role:assign", { guildId, userId, roleId, assigned }, resolve));

export const reorderRoles = (socket: AppSocket, guildId: string, orderedIds: string[]) =>
  ask<RoleReply>((resolve) => socket.emit("role:reorder", { guildId, orderedIds }, resolve));

export const openDirect = (socket: AppSocket, userId: string) =>
  ask<DirectReply>((resolve) => socket.emit("direct:open", { userId }, resolve));

export const loadDirect = (socket: AppSocket, threadId: string) =>
  ask<DirectReply>((resolve) => socket.emit("direct:history", { threadId }, resolve));

export const sendChannel = (socket: AppSocket, channelId: string, content: string, replyToId?: string | null) =>
  ask<MessageReply>((resolve) => socket.emit("chat:send", { channelId, content, replyToId }, resolve));

export const sendDirect = (socket: AppSocket, threadId: string, content: string, replyToId?: string | null) =>
  ask<DirectReply>((resolve) => socket.emit("direct:send", { threadId, content, replyToId }, resolve));

export const mutateMessage = (
  socket: AppSocket,
  scope: "chat" | "direct",
  action: "edit" | "delete" | "react",
  messageId: string,
  value?: string,
) => ask<MessageReply>((resolve) => {
  if (action === "edit") socket.emit(`${scope}:edit`, { messageId, content: value ?? "" }, resolve);
  else if (action === "react") socket.emit(`${scope}:react`, { messageId, emoji: value ?? "" }, resolve);
  else socket.emit(`${scope}:delete`, { messageId }, resolve);
});

export const requestFriend = (socket: AppSocket, username: string) =>
  ask<RelationshipReply>((resolve) => socket.emit("friend:request", { username }, resolve));

export const changeFriendship = (
  socket: AppSocket,
  action: "accept" | "reject" | "cancel" | "remove" | "block" | "unblock",
  userId: string,
) => ask<RelationshipReply>((resolve) => socket.emit(`friend:${action}`, { userId }, resolve));

export const updatePresence = (
  socket: AppSocket,
  mode: PresenceMode,
  status: string | null,
  expiresAt: number | null,
) => ask<RelationshipReply>((resolve) => socket.emit("presence:update", { mode, status, expiresAt }, resolve));

export const markRead = (socket: AppSocket, type: "channel" | "direct", id: string, sequence: number) =>
  ask<Ack>((resolve) => socket.emit("read:mark", { type, id, sequence }, resolve));

/** Códigos do servidor traduzidos pra algo que a pessoa na tela entenda. */
export function describeSocketError(code: string | undefined): string {
  switch (code) {
    case "bad-password":
      return "Senha da sala incorreta.";
    case "bad-username":
      return "Escolha um apelido de 2 a 32 caracteres.";
    case "rate-limited":
      return "Muitas tentativas em pouco tempo. Espere alguns segundos.";
    case "already-identified":
      return "Esta aba já entrou. Recarregue a página.";
    case "no-channel":
      return "Esse canal de voz não existe mais.";
    case "bad-name":
      return "Escolha um nome com pelo menos duas letras.";
    case "not-member":
      return "Você não faz parte desse servidor.";
    case "not-owner":
      return "Só quem criou o servidor pode fazer isso.";
    case "missing-permission":
      return "Seu cargo não tem permissão para fazer isso.";
    case "not-authenticated":
      return "Entre na sua conta para usar esse recurso.";
    case "not-shared-server":
      return "Só é possível conversar com alguém de um servidor em comum.";
    case "role-protected":
      return "Esse cargo é protegido ou já está com esse estado.";
    case "is-owner":
      return "Você criou este servidor, então não pode sair dele.";
    case "last-channel":
      return "Este é o último canal do tipo. Crie outro antes de apagar este.";
    case "invite-invalid":
      return "Convite inválido. Confira o código.";
    case "invite-expired":
      return "Esse convite expirou. Peça um novo.";
    case "invite-used-up":
      return "Esse convite já foi usado o número máximo de vezes.";
    case "banned":
      return "Você não pode entrar nesse servidor.";
    case "adult-required":
      return "O Draco é exclusivo para pessoas com 18 anos ou mais.";
    case "cannot-ban-self":
      return "Você não pode banir a si mesmo.";
    // Silêncio, não recusa: o servidor não respondeu no prazo. Em hospedagem
    // grátis quase sempre é o serviço acordando, então a mensagem sugere esperar
    // em vez de mandar a pessoa investigar se o servidor caiu.
    case "timeout":
      return "O servidor não respondeu. Se ele está num plano grátis, pode estar acordando. Espere uns 30 segundos e clique em Entrar de novo.";
    default:
      return "Não foi possível falar com o servidor. Ele está rodando?";
  }
}
