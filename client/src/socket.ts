import { io, type Socket } from "socket.io-client";
import type { Member, Message, ServerSnapshot, SignalPayload } from "@/types";

/**
 * Contrato de eventos com `server/signaling.js`, escrito como tipo pra o
 * compilador reclamar quando um lado mudar sem o outro. Sinalização errada não
 * dá erro em tempo de execução — só uma call que não conecta e ninguém sabe por
 * quê —, então é o tipo de descuido que vale caro deixar passar.
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
  state?: ServerSnapshot;
}

export interface VoiceJoinReply {
  ok: boolean;
  error?: string;
  channelId?: string;
  peers?: Member[];
}

interface ClientEvents {
  identify: (payload: { username: string; password: string }, ack: (reply: IdentifyReply) => void) => void;
  "chat:send": (payload: { channelId: string; content: string }) => void;
  "voice:join": (payload: { channelId: string }, ack: (reply: VoiceJoinReply) => void) => void;
  "voice:leave": () => void;
  "voice:state": (payload: Partial<VoiceFlags>) => void;
  "rtc:signal": (payload: SignalPayload & { to: string }) => void;
}

export type AppSocket = Socket<ServerEvents, ClientEvents>;

/**
 * Conecta na mesma origem da página — em desenvolvimento o Vite faz proxy pro
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
    // acessa, e a primeira conexão é ela acordando — leva bem mais de 8 segundos.
    // Um teto curto aqui transforma "está acordando" em "não foi possível falar
    // com o servidor", que manda a pessoa procurar o problema no lugar errado.
    timeout: 45000,
  });
}

export const identify = (socket: AppSocket, username: string, password: string) =>
  new Promise<IdentifyReply>((resolve) => socket.emit("identify", { username, password }, resolve));

export const joinVoiceChannel = (socket: AppSocket, channelId: string) =>
  new Promise<VoiceJoinReply>((resolve) => socket.emit("voice:join", { channelId }, resolve));

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
      return "O servidor não respondeu. Se ele está num plano grátis, pode estar acordando — espere uns 30 segundos e clique em Entrar de novo.";
    default:
      return "Não foi possível falar com o servidor. Ele está rodando?";
  }
}
