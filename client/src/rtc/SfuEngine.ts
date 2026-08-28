import {
  applyProfile,
  type CallEngine,
  type EngineSample,
  type RemoteTrackRef,
  type TrackProfile,
} from "@/rtc/engine";
import { tuneAudioSdp } from "@/rtc/sdp";
import { sampleScopes } from "@/rtc/stats";
import { SLOT_KIND, type MediaSlot } from "@/types";

/**
 * Caminho por servidor: a mídia sobe uma vez pro SFU da Cloudflare, que replica
 * pra todo mundo na call. É a diferença entre "cada pessoa que entra custa outro
 * tanto do seu upload" e "custa nada": 1080p pra oito pessoas é a mesma banda
 * que pra uma.
 *
 * Duas conexões, e é o ponto do desenho: uma só envia, a outra só recebe.
 * Alguém entrando na call renegocia apenas a de recepção; a que está carregando
 * a sua tela nem sabe que houve visita.
 *
 * Este módulo nunca fala com a Cloudflare direto. O segredo do app é do
 * servidor. Tudo passa por `sfu:*` no socket.
 */

export interface SfuTrackReply {
  mid: string | null;
  trackName: string | null;
}

export interface SfuTransport {
  join(): Promise<boolean>;
  publish(
    description: RTCSessionDescriptionInit,
    tracks: Array<{ mid: string; slot: MediaSlot }>,
  ): Promise<RTCSessionDescriptionInit | null>;
  subscribe(tracks: RemoteTrackRef[]): Promise<{
    description: RTCSessionDescriptionInit | null;
    tracks: SfuTrackReply[];
  } | null>;
  renegotiate(description: RTCSessionDescriptionInit): Promise<boolean>;
}

export interface SfuEngineOptions {
  configuration: RTCConfiguration;
  transport: SfuTransport;
  onRemoteTrack: (memberId: string, slot: MediaSlot, stream: MediaStream, live: boolean) => void;
  onConnectionState?: (role: "send" | "recv", state: RTCPeerConnectionState) => void;
  /** Chamado quando a sessão morre de vez: o dono decide se recria. */
  onFailure?: (reason: string) => void;
}

const DEFAULT_PROFILES: Partial<Record<MediaSlot, TrackProfile>> = {
  mic: { maxBitrate: 96_000 },
  camera: { maxBitrate: 2_000_000, degradationPreference: "maintain-framerate" },
  screen: { maxBitrate: 4_000_000, degradationPreference: "maintain-resolution" },
  screenAudio: { maxBitrate: 192_000 },
};

/** Uma trilha remota que já foi pedida ao SFU. */
interface Subscription {
  ref: RemoteTrackRef;
  mid: string | null;
  track: MediaStreamTrack | null;
}

/** Recorte do que sobe daqui. Não é o id de ninguém: não colide com um `memberId`. */
const UPLINK_KEY = "sfu|uplink";

const slotKey = (memberId: string, slot: MediaSlot) => `${memberId}|${slot}`;

export class SfuEngine implements CallEngine {
  readonly #send: RTCPeerConnection;
  readonly #recv: RTCPeerConnection;
  readonly #localTracks = new Map<MediaSlot, MediaStreamTrack | null>();
  readonly #senders = new Map<MediaSlot, RTCRtpSender>();
  readonly #published = new Set<MediaSlot>();
  readonly #profiles = new Map<MediaSlot, TrackProfile>(
    Object.entries(DEFAULT_PROFILES) as [MediaSlot, TrackProfile][],
  );
  /**
   * `memberId|slot` já pedido ao SFU. A sessão do dono fica guardada junto: uma
   * reconexão dele cria outra sessão, e a assinatura antiga aponta pra uma que o
   * SFU já descartou.
   */
  readonly #subscriptions = new Map<string, Subscription>();
  #ready: Promise<boolean> | null = null;
  /** Uma fila por conexão: dois `setLocalDescription` sobrepostos derrubam a sessão. */
  #sendQueue: Promise<void> = Promise.resolve();
  #recvQueue: Promise<void> = Promise.resolve();
  #publishFailed = false;
  #closed = false;

  constructor(private options: SfuEngineOptions) {
    this.#send = new RTCPeerConnection(options.configuration);
    this.#recv = new RTCPeerConnection(options.configuration);

    this.#send.onconnectionstatechange = () => {
      const state = this.#send.connectionState;
      this.options.onConnectionState?.("send", state);
      if (state === "connected") void this.#applyEncodings();
      if (state === "failed") this.options.onFailure?.("envio caiu");
    };

    this.#recv.onconnectionstatechange = () => {
      const state = this.#recv.connectionState;
      // Sozinho na call não há nada pra receber, e a conexão fica em `new` pra
      // sempre. Anunciar isso apareceria como "conectando" que nunca termina.
      if (this.#subscriptions.size > 0) this.options.onConnectionState?.("recv", state);
      if (state === "failed") this.options.onFailure?.("recepção caiu");
    };
  }

  /**
   * Duas conexões, dois papéis. O que interessa por pessoa está na de recepção,
   * separado pelos `mid` das trilhas dela; a decisão de qualidade sai da de envio,
   * que é uma só: com SFU o upload não depende de quantas pessoas escutam.
   */
  async sample(): Promise<EngineSample> {
    const byMember = new Map<string, Set<string>>();
    for (const { ref, mid } of this.#subscriptions.values()) {
      if (!mid) continue;
      const mids = byMember.get(ref.memberId) ?? new Set<string>();
      mids.add(mid);
      byMember.set(ref.memberId, mids);
    }

    const [peers, uplink] = await Promise.all([
      sampleScopes(
        this.#recv,
        [...byMember].map(([memberId, mids]) => ({ key: memberId, mids })),
      ),
      sampleScopes(this.#send, [{ key: UPLINK_KEY }]),
    ]);

    return { peers, uplink: uplink.map(([, sample]) => sample) };
  }

  /** Em malha isto é sinalização entre pares; aqui não existe. */
  handleSignal(): void {}

  localTrack(slot: MediaSlot): MediaStreamTrack | null {
    return this.#localTracks.get(slot) ?? null;
  }

  /** Cria as duas sessões no SFU. Uma vez só: as chamadas seguintes reaproveitam. */
  start(): Promise<boolean> {
    this.#ready ??= this.options.transport.join();
    return this.#ready;
  }

  async setLocalTrack(slot: MediaSlot, track: MediaStreamTrack | null): Promise<void> {
    if (this.#closed) return;
    this.#localTracks.set(slot, track);

    const sender = this.#senders.get(slot);
    if (sender) {
      try {
        await sender.replaceTrack(track);
      } catch (error) {
        console.error(`[sfu] replaceTrack(${slot}) falhou:`, error);
      }
      if (track) await this.#applyEncodings();
      return;
    }

    // Sem trilha ainda não há o que publicar: o SFU precisa de mídia real no
    // `m=` pra dar nome à trilha, então câmera e tela só sobem quando ligam.
    if (!track) return;
    await this.#publish(slot, track);
    await this.#applyEncodings();
  }

  async setTrackProfile(slot: MediaSlot, profile: TrackProfile): Promise<void> {
    this.#profiles.set(slot, profile);
    await this.#applyEncodings();
  }

  /**
   * Alinha as assinaturas com o que existe na call. Uma trilha que o dono
   * desligou continua assinada e vira silêncio, e quem decide se o tile existe é
   * o estado que veio pelo socket, então derrubá-la só compraria uma renegociação
   * a cada mute. O que sai são as trilhas de sessões que já não valem: quem
   * reconectou tem sessão nova, e a antiga não entrega mais nada.
   */
  syncRemote(tracks: RemoteTrackRef[]): void {
    if (this.#closed) return;

    const wanted = new Map(tracks.map((ref) => [slotKey(ref.memberId, ref.slot), ref]));
    for (const [key, current] of [...this.#subscriptions]) {
      const ref = wanted.get(key);
      if (ref && ref.sessionId === current.ref.sessionId) continue;
      this.#release(key);
    }

    const missing = [...wanted]
      .filter(([key]) => !this.#subscriptions.has(key))
      .map(([, ref]) => ref);
    if (missing.length === 0) return;
    for (const ref of missing) {
      this.#subscriptions.set(slotKey(ref.memberId, ref.slot), { ref, mid: null, track: null });
    }
    void this.#enqueueRecv(() => this.#subscribe(missing));
  }

  /**
   * Esquece as assinaturas de quem saiu. É o que permite reassinar quando a mesma
   * pessoa volta: sem isso a chave continuaria marcada e a segunda entrada dela
   * ficaria sem imagem e sem som.
   */
  removePeer(memberId: string): void {
    for (const [key, { ref }] of [...this.#subscriptions]) {
      if (ref.memberId === memberId) this.#release(key);
    }
  }

  close(): void {
    this.#closed = true;
    for (const key of [...this.#subscriptions.keys()]) this.#release(key);
    for (const pc of [this.#send, this.#recv]) {
      pc.onconnectionstatechange = null;
      pc.ontrack = null;
      pc.close();
    }
    this.#localTracks.clear();
    this.#senders.clear();
    this.#published.clear();
  }

  /** Solta os listeners de uma trilha recebida; a mídia em si é do `RTCRtpReceiver`. */
  #release(key: string): void {
    const current = this.#subscriptions.get(key);
    this.#subscriptions.delete(key);
    const track = current?.track;
    if (!track) return;
    track.onunmute = null;
    track.onmute = null;
    track.onended = null;
  }

  // --- envio -----------------------------------------------------------------

  #enqueueSend(work: () => Promise<void>): Promise<void> {
    this.#sendQueue = this.#sendQueue.then(work).catch((error) => {
      console.error("[sfu] publicação falhou:", error);
    });
    return this.#sendQueue;
  }

  #enqueueRecv(work: () => Promise<void>): Promise<void> {
    this.#recvQueue = this.#recvQueue.then(work).catch((error) => {
      console.error("[sfu] assinatura falhou:", error);
    });
    return this.#recvQueue;
  }

  /**
   * Sobe uma trilha nova. O `mid` só existe depois de `setLocalDescription`, e é
   * ele que amarra "esta linha do SDP" ao nome que os outros vão assinar.
   */
  #publish(slot: MediaSlot, track: MediaStreamTrack): Promise<void> {
    return this.#enqueueSend(async () => {
      if (this.#closed || !(await this.start())) return;
      if (this.#senders.has(slot)) {
        await this.#senders.get(slot)?.replaceTrack(track);
        return;
      }

      const transceiver = this.#send.addTransceiver(track, { direction: "sendonly" });
      this.#senders.set(slot, transceiver.sender);

      const offer = await this.#send.createOffer();
      await this.#setLocal(this.#send, offer);

      // Todas as pendentes de uma vez: o SDP que acabou de ser criado descreve
      // tudo, e mandar só a última deixaria as outras sem nome no SFU.
      const pending: Array<{ mid: string; slot: MediaSlot }> = [];
      for (const [candidate, sender] of this.#senders) {
        if (this.#published.has(candidate)) continue;
        const mid = this.#send.getTransceivers().find((t) => t.sender === sender)?.mid;
        if (!mid) continue;
        pending.push({ mid, slot: candidate });
      }
      if (pending.length === 0) return;

      const answer = await this.options.transport.publish(this.#send.localDescription!, pending);
      if (!answer) {
        // A oferta já está aplicada localmente e o SFU não a conhece: esta conexão
        // não publica mais nada. Quem pode resolver é o dono, refazendo a call.
        // Tentar de novo aqui só empilharia `m=` que ninguém vai atender.
        if (!this.#publishFailed) {
          this.#publishFailed = true;
          this.options.onFailure?.("o servidor de mídia recusou a transmissão");
        }
        throw new Error(`o SFU não aceitou ${slot}`);
      }
      await this.#send.setRemoteDescription(answer);
      for (const entry of pending) this.#published.add(entry.slot);
    });
  }

  async #applyEncodings(): Promise<void> {
    for (const [slot, sender] of this.#senders) {
      await applyProfile(sender, this.#profiles.get(slot));
    }
  }

  // --- recepção --------------------------------------------------------------

  /**
   * Pede as trilhas e resolve a oferta que a Cloudflare devolve. O `mid` de cada
   * trilha vem na resposta, e é por ele que se sabe qual `m=` é a câmera de quem,
   * sem depender de ordem, que é o que o caminho em malha precisa fazer.
   */
  async #subscribe(refs: RemoteTrackRef[]): Promise<void> {
    // Uma pessoa pode ter saído entre o pedido e a vez dele na fila.
    const live = refs.filter((ref) => this.#pending(ref));
    if (live.length === 0) return;
    if (this.#closed || !(await this.start())) {
      for (const ref of live) this.#forget(ref);
      return;
    }

    let result: Awaited<ReturnType<SfuTransport["subscribe"]>>;
    try {
      result = await this.options.transport.subscribe(live);
    } catch (error) {
      // Falha aqui não pode deixar a trilha marcada como assinada, senão ela
      // nunca seria tentada de novo nesta call.
      for (const ref of live) this.#forget(ref);
      throw error;
    }
    if (!result) {
      for (const ref of live) this.#forget(ref);
      return;
    }

    if (result.description) {
      await this.#recv.setRemoteDescription(result.description);
      const answer = await this.#recv.createAnswer();
      await this.#setLocal(this.#recv, answer);
      const accepted = await this.options.transport.renegotiate(this.#recv.localDescription!);
      if (!accepted) {
        for (const ref of live) this.#forget(ref);
        return;
      }
    }

    // Nome → dono. O servidor batiza cada trilha como `<memberId>-<slot>`, e é
    // esse nome que volta aqui associado ao `mid`.
    const byName = new Map(live.map((ref) => [`${ref.memberId}-${ref.slot}`, ref]));
    const attached = new Set<string>();
    for (const entry of result.tracks) {
      if (!entry.mid || !entry.trackName) continue;
      const ref = byName.get(entry.trackName);
      if (!ref || !this.#pending(ref)) continue;
      const transceiver = this.#recv.getTransceivers().find((t) => t.mid === entry.mid);
      const track = transceiver?.receiver.track;
      if (!track || track.kind !== SLOT_KIND[ref.slot]) continue;
      this.#attach(ref, track, entry.mid);
      attached.add(slotKey(ref.memberId, ref.slot));
    }

    // O que o SFU não devolveu não está chegando: soltar a marca é o que permite
    // pedir de novo quando o dono republicar.
    for (const ref of live) {
      if (!attached.has(slotKey(ref.memberId, ref.slot))) this.#forget(ref);
    }
  }

  /** Esta referência ainda é a que está pendurada nesta chave? */
  #pending(ref: RemoteTrackRef): boolean {
    const current = this.#subscriptions.get(slotKey(ref.memberId, ref.slot));
    return current?.ref.sessionId === ref.sessionId;
  }

  #forget(ref: RemoteTrackRef): void {
    if (this.#pending(ref)) this.#release(slotKey(ref.memberId, ref.slot));
  }

  /** Stream próprio por trilha: o do evento pode vir vazio depois de um `replaceTrack`. */
  #attach(ref: RemoteTrackRef, track: MediaStreamTrack, mid: string): void {
    const key = slotKey(ref.memberId, ref.slot);
    this.#release(key);
    this.#subscriptions.set(key, { ref, mid, track });
    const stream = new MediaStream([track]);
    const report = (live: boolean) =>
      this.options.onRemoteTrack(ref.memberId, ref.slot, stream, live);
    // `muted` aqui é "ainda não chega mídia", não o mute do usuário.
    report(!track.muted);
    track.onunmute = () => report(true);
    track.onmute = () => report(false);
    track.onended = () => report(false);
  }

  /** O Opus ajustado vale nos dois sentidos; recusado, segue o original. */
  async #setLocal(pc: RTCPeerConnection, local: RTCSessionDescriptionInit): Promise<void> {
    try {
      await pc.setLocalDescription({ type: local.type, sdp: tuneAudioSdp(local.sdp) });
    } catch (error) {
      console.warn("[sfu] SDP ajustado recusado; seguindo com o original:", error);
      await pc.setLocalDescription(local);
    }
  }
}
