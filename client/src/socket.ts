import { io, type Socket } from "socket.io-client";
import type { MediaSlot, Member, Message, ServerSnapshot, SignalPayload } from "@/types";

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
  "voice:peer-joined": (payload: { channelId: string; member: Member }) => void;
  "voice:peer-left": (payload: { channelId: string; memberId: string }) => void;
  "rtc:signal": (payload: SignalPayload & { from: string }) => void;
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
  /** O servidor tem credenciais do SFU: a mídia passa por servidor. */
  sfu?: boolean;
  state?: ServerSnapshot;
}

export interface VoiceJoinReply {
  ok: boolean;
  error?: string;
  channelId?: string;
  peers?: Member[];
  sfu?: boolean;
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
    payload: { username: string; password: string; token: string | null },
    ack: (reply: IdentifyReply) => void,
  ) => void;
  "chat:send": (payload: { channelId: string; content: string }) => void;
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
  username: string,
  password: string,
  token: string | null,
) =>
  new Promise<IdentifyReply>((resolve) =>
    socket.emit("identify", { username, password, token }, resolve),
  );

export const joinVoiceChannel = (socket: AppSocket, channelId: string) =>
  new Promise<VoiceJoinReply>((resolve) => socket.emit("voice:join", { channelId }, resolve));

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
    // Silêncio, não recusa: o servidor não respondeu no prazo. Em hospedagem
    // grátis quase sempre é o serviço acordando, então a mensagem sugere esperar
    // em vez de mandar a pessoa investigar se o servidor caiu.
    case "timeout":
      return "O servidor não respondeu. Se ele está num plano grátis, pode estar acordando. Espere uns 30 segundos e clique em Entrar de novo.";
    default:
      return "Não foi possível falar com o servidor. Ele está rodando?";
  }
}
