import { randomUUID } from "node:crypto";

/**
 * Todo o estado vive em memória: reiniciar o processo zera canais e mensagens.
 * É deliberado — o objetivo era funcionar sem instalar banco de dados. Trocar
 * por SQLite depois é local: só estas funções tocam o estado.
 */

/** Quantas mensagens ficam guardadas por canal antes de as antigas caírem. */
const MESSAGE_HISTORY = 200;

export const GUILDS = [
  { id: "g-main", name: "Meu Servidor", initials: "MS", color: "#5865f2" },
  { id: "g-games", name: "Jogatina", initials: "JG", color: "#23a55a" },
];

export const CHANNELS = [
  { id: "t-geral", guildId: "g-main", type: "text", name: "geral", category: "Canais de Texto" },
  { id: "t-avisos", guildId: "g-main", type: "text", name: "avisos", category: "Canais de Texto" },
  { id: "v-geral", guildId: "g-main", type: "voice", name: "Geral", category: "Canais de Voz" },
  { id: "v-reuniao", guildId: "g-main", type: "voice", name: "Reunião", category: "Canais de Voz" },
  { id: "t-jogos", guildId: "g-games", type: "text", name: "bate-papo", category: "Canais de Texto" },
  { id: "v-jogos", guildId: "g-games", type: "voice", name: "Sala de Jogo", category: "Canais de Voz" },
];

/** Cores de avatar do Discord, escolhidas de forma estável a partir do nome. */
const AVATAR_COLORS = ["#5865f2", "#3ba55c", "#faa61a", "#ed4245", "#eb459e", "#9b59b6", "#1abc9c"];

/** socketId -> membro conectado */
const members = new Map();
/** channelId -> mensagens, mais antiga primeiro */
const messages = new Map();

export function colorForName(name) {
  let hash = 0;
  for (const char of name) hash = (hash * 31 + char.codePointAt(0)) % 1_000_003;
  return AVATAR_COLORS[hash % AVATAR_COLORS.length];
}

export function addMember(socketId, username) {
  const member = {
    id: socketId,
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
  };
  members.set(socketId, member);
  return member;
}

export function getMember(socketId) {
  return members.get(socketId);
}

export function removeMember(socketId) {
  const member = members.get(socketId);
  members.delete(socketId);
  return member;
}

export function listMembers() {
  return [...members.values()];
}

/** Quem mais está no mesmo canal de voz — a lista com quem abrir peer connection. */
export function peersInVoiceChannel(channelId, exceptSocketId) {
  if (!channelId) return [];
  return [...members.values()].filter((m) => m.voiceChannelId === channelId && m.id !== exceptSocketId);
}

export function setVoiceChannel(socketId, channelId) {
  const member = members.get(socketId);
  if (!member) return null;
  member.voiceChannelId = channelId;
  if (channelId === null) {
    // Sair da call zera o que só faz sentido dentro dela, mas mute e deafen
    // são preferências do usuário e sobrevivem — igual ao Discord.
    member.camOn = false;
    member.screenOn = false;
    member.speaking = false;
  }
  return member;
}

export function setVoiceState(socketId, patch) {
  const member = members.get(socketId);
  if (!member) return null;
  for (const key of ["muted", "deafened", "camOn", "screenOn", "speaking"]) {
    if (typeof patch?.[key] === "boolean") member[key] = patch[key];
  }
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
