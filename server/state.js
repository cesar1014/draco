import { randomUUID } from "node:crypto";

/**
 * Todo o estado vive em memória: reiniciar o processo zera canais e mensagens.
 * É deliberado: o objetivo era funcionar sem instalar banco de dados. Trocar
 * por SQLite depois é local: só estas funções tocam o estado.
 *
 * Quem identifica uma pessoa é o `userId`, não o socket. O socket muda a cada
 * oscilação de Wi-Fi; a pessoa não. Manter os dois separados é o que faz o
 * volume que você ajustou, o destaque que você fixou e a tela que você estava
 * assistindo continuarem valendo depois de uma reconexão.
 */

/** Quantas mensagens ficam guardadas por canal antes de as antigas caírem. */
const MESSAGE_HISTORY = 200;

export const GUILDS = [
  { id: "g-main", name: "Meu Servidor", initials: "MS", color: "#5b6cff" },
  { id: "g-games", name: "Jogatina", initials: "JG", color: "#3ddc97" },
];

export const CHANNELS = [
  { id: "t-geral", guildId: "g-main", type: "text", name: "geral", category: "Canais de Texto" },
  { id: "t-avisos", guildId: "g-main", type: "text", name: "avisos", category: "Canais de Texto" },
  { id: "v-geral", guildId: "g-main", type: "voice", name: "Geral", category: "Canais de Voz" },
  { id: "v-reuniao", guildId: "g-main", type: "voice", name: "Reunião", category: "Canais de Voz" },
  { id: "t-jogos", guildId: "g-games", type: "text", name: "bate-papo", category: "Canais de Texto" },
  { id: "v-jogos", guildId: "g-games", type: "voice", name: "Sala de Jogo", category: "Canais de Voz" },
];

/** Cor do avatar, escolhida de forma estável a partir do nome. */
const AVATAR_COLORS = ["#5b6cff", "#3ddc97", "#ffb457", "#ff5f7a", "#f45ec1", "#a06bff", "#4fd8ff"];

/** userId -> membro conectado */
const members = new Map();
/** socketId -> userId, pra achar quem é o dono de um pacote que chegou */
const sockets = new Map();
/** channelId -> mensagens, mais antiga primeiro */
const messages = new Map();

export function colorForName(name) {
  let hash = 0;
  for (const char of name) hash = (hash * 31 + char.codePointAt(0)) % 1_000_003;
  return AVATAR_COLORS[hash % AVATAR_COLORS.length];
}

export const newUserId = () => randomUUID();

/**
 * Entra ou reassume uma identidade. Quando o mesmo `userId` volta com um socket
 * novo (reconexão, ou a mesma pessoa recarregando a página), o membro é o mesmo
 * objeto: preferências e estado de voz seguem de pé. O socket antigo é devolvido
 * pra quem chamou, que precisa derrubá-lo pra não ficarem dois donos do mesmo id.
 */
export function addMember(socketId, userId, username) {
  const existing = members.get(userId);
  const previousSocketId = existing?.socketId ?? null;

  const member = existing ?? {
    id: userId,
    username,
    color: colorForName(username),
    voiceChannelId: null,
    // Estado de voz. Vem do cliente e é replicado pra todos: é por isso que o
    // ícone de mudo do outro aparece na hora, sem esperar a mídia mudar.
    muted: false,
    deafened: false,
    camOn: false,
    screenOn: false,
    speaking: false,
    /**
     * Sessões no SFU. Duas de propósito: numa a pessoa só envia, na outra só
     * recebe. Assim uma renegociação de quem entrou na call não passa pela mesma
     * conexão que está carregando a câmera de quem já estava, e o SDP de
     * publicação nunca precisa ser reescrito porque alguém apareceu.
     *
     * Só a de envio é anunciada aos outros: é dela que saem as trilhas.
     */
    sfuSessionId: null,
    sfuRecvSessionId: null,
    /** Nome das trilhas publicadas, por slot, que é o que os outros assinam. */
    sfuTracks: {},
    since: Date.now(),
  };

  member.username = username;
  member.color = colorForName(username);
  member.socketId = socketId;

  // Socket novo, sessão de mídia nova: os ids antigos apontam pra uma sessão que
  // o SFU já está descartando, e anunciá-los faria os outros assinarem o vazio.
  if (previousSocketId && previousSocketId !== socketId) {
    member.sfuSessionId = null;
    member.sfuRecvSessionId = null;
    member.sfuTracks = {};
    sockets.delete(previousSocketId);
  }

  members.set(userId, member);
  sockets.set(socketId, userId);
  return { member, previousSocketId };
}

/** O membro dono deste socket, ou `undefined` se o socket não se identificou. */
export function getMember(socketId) {
  const userId = sockets.get(socketId);
  return userId ? members.get(userId) : undefined;
}

export function getMemberById(userId) {
  return members.get(userId);
}

/** Só remove se o socket ainda for o atual: reconexão rápida chega antes do `disconnect`. */
export function removeMember(socketId) {
  const userId = sockets.get(socketId);
  sockets.delete(socketId);
  if (!userId) return null;
  const member = members.get(userId);
  if (!member || member.socketId !== socketId) return null;
  members.delete(userId);
  return member;
}

export function listMembers() {
  return [...members.values()];
}

/** Quem mais está no mesmo canal de voz: com quem abrir peer connection. */
export function peersInVoiceChannel(channelId, exceptUserId) {
  if (!channelId) return [];
  return [...members.values()].filter((m) => m.voiceChannelId === channelId && m.id !== exceptUserId);
}

export function setVoiceChannel(userId, channelId) {
  const member = members.get(userId);
  if (!member) return null;
  member.voiceChannelId = channelId;
  if (channelId === null) {
    // Sair da call zera o que só faz sentido dentro dela; mute e deafen são
    // preferências da pessoa e sobrevivem.
    member.camOn = false;
    member.screenOn = false;
    member.speaking = false;
    member.sfuSessionId = null;
    member.sfuRecvSessionId = null;
    member.sfuTracks = {};
  }
  return member;
}

export function setVoiceState(userId, patch) {
  const member = members.get(userId);
  if (!member) return null;
  for (const key of ["muted", "deafened", "camOn", "screenOn", "speaking"]) {
    if (typeof patch?.[key] === "boolean") member[key] = patch[key];
  }
  return member;
}

/** Sessão no SFU. Uma por socket: reconectar cria outra, e a antiga expira sozinha. */
export function setSfuSession(userId, { sendSessionId, recvSessionId }) {
  const member = members.get(userId);
  if (!member) return null;
  member.sfuSessionId = sendSessionId;
  member.sfuRecvSessionId = recvSessionId;
  member.sfuTracks = {};
  return member;
}

/** Registra as trilhas publicadas. É o que diz aos outros o que existe pra assinar. */
export function setSfuTracks(userId, tracks) {
  const member = members.get(userId);
  if (!member) return null;
  member.sfuTracks = { ...member.sfuTracks, ...tracks };
  return member;
}

export function findChannel(channelId) {
  return CHANNELS.find((c) => c.id === channelId) ?? null;
}

export function addMessage(channelId, author, content) {
  const message = {
    id: randomUUID(),
    channelId,
    authorId: author.id,
    username: author.username,
    color: author.color,
    content,
    at: Date.now(),
  };
  const list = messages.get(channelId) ?? [];
  list.push(message);
  if (list.length > MESSAGE_HISTORY) list.splice(0, list.length - MESSAGE_HISTORY);
  messages.set(channelId, list);
  return message;
}

/**
 * Snapshot completo mandado a cada cliente que entra ou reconecta. Simples de
 * raciocinar: em vez de aplicar deltas na ordem certa, o cliente rebobina tudo.
 */
export function snapshot() {
  return {
    guilds: GUILDS,
    channels: CHANNELS,
    members: listMembers(),
    messages: Object.fromEntries(messages),
  };
}
