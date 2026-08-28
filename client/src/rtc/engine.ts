import type { PeerStats } from "@/rtc/stats";
import type { MediaSlot } from "@/types";

/**
 * Contrato comum aos dois caminhos de mídia.
 *
 * `VoiceEngine` liga cada pessoa a cada pessoa: o vídeo sobe uma vez por
 * ouvinte, e a partir de umas quatro pessoas o upload de casa não dá conta.
 * `SfuEngine` sobe uma vez pro servidor da Cloudflare, que replica, e o custo de
 * quem transmite deixa de crescer com o tamanho da call.
 *
 * O que decide qual dos dois roda é o servidor: com credenciais do SFU
 * configuradas ele responde `sfu: true` no `identify`, e o cliente escolhe. Sem
 * elas, nada muda em relação ao que sempre funcionou.
 */

export interface TrackProfile {
  maxBitrate: number;
  /** Só vale pra vídeo. */
  degradationPreference?: RTCDegradationPreference;
  /** Divisor de resolução. `1` é o tamanho capturado. */
  scaleResolutionDownBy?: number;
}

/** Uma trilha que existe na call e pode ser recebida. */
export interface RemoteTrackRef {
  memberId: string;
  slot: MediaSlot;
  /**
   * Sessão do dono no SFU, ou `null` em malha. Faz parte da referência porque uma
   * reconexão troca a sessão sem trocar a pessoa: sem isso a assinatura antiga
   * continuaria valendo e a segunda entrada dela ficaria muda.
   */
  sessionId: string | null;
}

/** Uma rodada de leitura das conexões. */
export interface EngineSample {
  /** Por pessoa, na chave que a interface usa pra achar o rótulo do tile. */
  peers: Array<readonly [string, PeerStats]>;
  /** Leituras do que está subindo daqui, que é o que a adaptação observa. */
  uplink: PeerStats[];
}

export interface CallEngine {
  /** Anexa (ou remove, com `null`) uma trilha local. Não renegocia. */
  setLocalTrack(slot: MediaSlot, track: MediaStreamTrack | null): Promise<void>;
  localTrack(slot: MediaSlot): MediaStreamTrack | null;
  setTrackProfile(slot: MediaSlot, profile: TrackProfile): Promise<void>;
  /** Ajusta o conjunto de trilhas remotas recebidas. Idempotente. */
  syncRemote(tracks: RemoteTrackRef[]): void;
  /** Esquece tudo o que vinha desta pessoa, inclusive o que já foi assinado. */
  removePeer(memberId: string): void;
  /** Sinalização em malha. O SFU ignora: quem negocia com ele é o servidor. */
  handleSignal(from: string, payload: unknown): void;
  sample(): Promise<EngineSample>;
  close(): void;
}

/** Aplica teto de banda e preferência de degradação num sender já conectado. */
export async function applyProfile(
  sender: RTCRtpSender,
  profile: TrackProfile | undefined,
): Promise<void> {
  const track = sender.track;
  if (!profile || !track) return;
  try {
    const params = sender.getParameters();
    if (!params.encodings?.length) params.encodings = [{}];
    params.encodings[0].maxBitrate = profile.maxBitrate;
    // Resolução e degradação não existem em áudio, e alguns navegadores recusam o
    // `setParameters` inteiro quando aparecem ali, inclusive o teto de banda.
    if (track.kind === "video") {
      params.encodings[0].scaleResolutionDownBy = profile.scaleResolutionDownBy ?? 1;
      if (profile.degradationPreference) {
        params.degradationPreference = profile.degradationPreference;
      }
    }
    await sender.setParameters(params);
  } catch {
    // Sender sem parâmetros ainda: a próxima transição de estado repete.
  }
}
