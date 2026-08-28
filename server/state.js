import { randomUUID } from "node:crypto";
import { createStateRepository } from "./data/state-repository.js";

/**
 * Perfis, servidores, canais e mensagens vivem no SQLite. Conexões e estado de
 * mídia continuam em memória porque deixam de ser válidos quando o processo cai.
 *
 * Quem identifica uma pessoa é o `userId`, não o socket. O socket muda a cada
 * oscilação de Wi-Fi; a pessoa não. Manter os dois separados é o que faz o
 * volume que você ajustou, o destaque que você fixou e a tela que você estava
 * assistindo continuarem valendo depois de uma reconexão.
 */

/**
 * Quantas mensagens de cada canal o banco guarda. Alto o bastante pra conversa de
 * meses caber, e limitado porque um arquivo que só cresce acaba estourando o
 * volume de 1 GB da hospedagem barata, e aí o servidor para de aceitar escrita.
 */
const MESSAGE_RETENTION = 5000;

/**
 * Quantas mensagens vão no snapshot de entrada, por canal. O resto vem por
 * `loadHistory` quando a pessoa rola pra cima: mandar meses de conversa de todos
 * os canais na entrada atrasaria a tela de quem só quer entrar na call.
 */
export const MESSAGE_PAGE = 50;

const DEFAULT_GUILDS = [
  { id: "g-main", name: "Meu Servidor", initials: "MS", color: "#5b6cff" },
  { id: "g-games", name: "Jogatina", initials: "JG", color: "#3ddc97" },
];

const DEFAULT_CHANNELS = [
  { id: "t-geral", guildId: "g-main", type: "text", name: "geral", category: "Canais de Texto" },
  { id: "t-avisos", guildId: "g-main", type: "text", name: "avisos", category: "Canais de Texto" },
  { id: "v-geral", guildId: "g-main", type: "voice", name: "Geral", category: "Canais de Voz" },
  { id: "v-reuniao", guildId: "g-main", type: "voice", name: "Reunião", category: "Canais de Voz" },
  { id: "t-jogos", guildId: "g-games", type: "text", name: "bate-papo", category: "Canais de Texto" },
  { id: "v-jogos", guildId: "g-games", type: "voice", name: "Sala de Jogo", category: "Canais de Voz" },
];

/** Cor do avatar, escolhida de forma estável a partir do nome. */
const AVATAR_COLORS = ["#5b6cff", "#3ddc97", "#ffb457", "#ff5f7a", "#f45ec1", "#a06bff", "#4fd8ff"];

const repository = createStateRepository();
repository.seedCatalog(DEFAULT_GUILDS, DEFAULT_CHANNELS);

export const GUILDS = repository.listGuilds();
export const CHANNELS = repository.listChannels();

/** userId -> membro conectado */
const members = new Map();
/** socketId -> userId, pra achar quem é o dono de um pacote que chegou */
const sockets = new Map();
/**
 * channelId -> as mensagens recentes, mais antiga primeiro. É cache do fim da
 * conversa, não a conversa inteira: o snapshot de entrada sai daqui sem tocar no
 * banco, e o passado fica no SQLite até alguém rolar pra cima.
 */
const messages = new Map();
/** channelId -> ainda existe conversa antes do que está em memória. */
const hasOlder = new Map();

for (const message of repository.listMessages(MESSAGE_PAGE + 1)) {
  const channelMessages = messages.get(message.channelId) ?? [];
  channelMessages.push(message);
  messages.set(message.channelId, channelMessages);
}
// A mensagem extra de cada canal só serve pra saber que há passado; ela sai da
// memória e volta pelo `loadHistory` se a pessoa realmente rolar até lá.
for (const [channelId, list] of messages) {
  if (list.length <= MESSAGE_PAGE) continue;
  list.splice(0, list.length - MESSAGE_PAGE);
  hasOlder.set(channelId, true);
}

export function colorForName(name) {
  let hash = 0;
  for (const char of name) hash = (hash * 31 + char.codePointAt(0)) % 1_000_003;
  return AVATAR_COLORS[hash % AVATAR_COLORS.length];
}

/**
 * Configuração que precisa sobreviver ao restart e não pertence a nenhuma
 * pessoa nem servidor — hoje só o segredo de assinatura das sessões. Passa por
 * aqui pra que o SQL continue todo no repositório.
 */
export const readSetting = (key) => repository.readSetting(key);
export const writeSetting = (key, value) => repository.writeSetting(key, value);

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

  const color = colorForName(username);
  repository.saveProfile({ id: userId, username, color }, GUILDS.map((guild) => guild.id));

  member.username = username;
  member.color = color;
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
  repository.addMessage(message, MESSAGE_RETENTION);
  const list = messages.get(channelId) ?? [];
  list.push(message);
  if (list.length > MESSAGE_PAGE) {
    list.splice(0, list.length - MESSAGE_PAGE);
    hasOlder.set(channelId, true);
  }
  messages.set(channelId, list);
  return message;
}

/**
 * Página anterior a uma mensagem, pra quem rolou até o topo do que recebeu. Sai
 * direto do banco em vez de crescer o cache: a memória do processo tem que ficar
 * do tamanho da conversa recente, e não do tamanho de quanto alguém já rolou.
 */
export function loadHistory(channelId, beforeId) {
  return repository.listMessagesBefore(channelId, beforeId, MESSAGE_PAGE);
}

/**
 * Snapshot completo mandado a cada cliente que entra ou reconecta. Simples de
 * raciocinar: em vez de aplicar deltas na ordem certa, o cliente rebobina tudo.
 *
 * Só o fim de cada conversa vai aqui. `history` diz em quais canais ainda existe
 * passado, e é o que o cliente usa pra decidir se vale pedir mais ao rolar.
 */
export function snapshot() {
  return {
    guilds: GUILDS,
    channels: CHANNELS,
    members: listMembers(),
    messages: Object.fromEntries(messages),
    history: Object.fromEntries([...hasOlder].filter(([, more]) => more)),
  };
}
