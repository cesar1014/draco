import {
  applyProfile,
  preferLowLatency,
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
  ): Promise<{ description: RTCSessionDescriptionInit | null; stale: boolean }>;
  subscribe(tracks: RemoteTrackRef[]): Promise<{
    description: RTCSessionDescriptionInit | null;
    tracks: SfuTrackReply[];
  } | null>;
  renegotiate(role: "send" | "recv", description: RTCSessionDescriptionInit): Promise<boolean>;
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

/**
 * Estado de uma trilha que sobe daqui.
 *
 * Três estados, e são poucos de propósito: `live` é a publicação que o SFU
 * conhece e aceita `replaceTrack`, `publishing` é a que está sendo negociada
 * agora, e `stale` é a que existiu mas não vale mais — sessão trocada, transporte
 * fechado, transceiver encerrado. `stale` não se reaproveita: ela é republicada.
 *
 * O ciclo que isso resolve é o de sempre: ligar a câmera, desligar, esperar, e
 * ligar de novo. Com um sender guardado e nenhuma noção de validade, a segunda vez
 * fazia `replaceTrack` numa publicação que o SFU já tinha descartado, e a imagem
 * simplesmente não chegava do outro lado, sem erro nenhum.
 */
type PublicationState = "publishing" | "live" | "stale";

interface Publication {
  state: PublicationState;
  transceiver: RTCRtpTransceiver;
  sender: RTCRtpSender;
}

/** Uma trilha remota que já foi pedida ao SFU. */
interface Subscription {
  ref: RemoteTrackRef;
  mid: string | null;
  track: MediaStreamTrack | null;
}

/** Recorte do que sobe daqui. Não é o id de ninguém: não colide com um `memberId`. */
const UPLINK_KEY = "sfu|uplink";

/** Espera antes de tratar `disconnected` como queda: troca de rede se resolve sozinha. */
const ICE_GRACE_MS = 6000;
/** Reinícios de ICE por conexão. Depois disso quem decide é o dono da call. */
const MAX_ICE_RESTARTS = 2;

const slotKey = (memberId: string, slot: MediaSlot) => `${memberId}|${slot}`;

export class SfuEngine implements CallEngine {
  readonly #send: RTCPeerConnection;
  readonly #recv: RTCPeerConnection;
  readonly #localTracks = new Map<MediaSlot, MediaStreamTrack | null>();
  readonly #publications = new Map<MediaSlot, Publication>();
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
  #iceRestarts = { send: 0, recv: 0 };
  #iceTimers: { send: ReturnType<typeof setTimeout> | null; recv: ReturnType<typeof setTimeout> | null } = {
    send: null,
    recv: null,
  };
  #closed = false;

  constructor(private options: SfuEngineOptions) {
    this.#send = new RTCPeerConnection(options.configuration);
    this.#recv = new RTCPeerConnection(options.configuration);

    this.#send.onconnectionstatechange = () => {
      const state = this.#send.connectionState;
      this.options.onConnectionState?.("send", state);
      if (state === "connected") {
        this.#iceRestarts.send = 0;
        void this.#applyEncodings();
      }
      // Transporte morto invalida toda publicação que passava por ele: elas não
      // voltam com `replaceTrack`, e marcar aqui é o que faz a próxima tentativa
      // republicar em vez de escrever numa trilha que não existe mais.
      if (state === "failed" || state === "closed") this.#invalidatePublications();
      if (state === "failed") this.options.onFailure?.("envio caiu");
    };

    this.#recv.onconnectionstatechange = () => {
      const state = this.#recv.connectionState;
      // Sozinho na call não há nada pra receber, e a conexão fica em `new` pra
      // sempre. Anunciar isso apareceria como "conectando" que nunca termina.
      if (this.#subscriptions.size > 0) this.options.onConnectionState?.("recv", state);
      if (state === "connected") this.#iceRestarts.recv = 0;
      if (state === "failed") this.options.onFailure?.("recepção caiu");
    };

    this.#send.oniceconnectionstatechange = () => this.#watchIce("send", this.#send);
    this.#recv.oniceconnectionstatechange = () => this.#watchIce("recv", this.#recv);
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

    const publication = this.#publications.get(slot);
    // Publicação viva aceita a troca sem renegociar, que é o caminho barato: é o
    // que faz mutar e desmutar, ou trocar de câmera, não custar uma negociação.
    if (publication && this.#usable(publication)) {
      try {
        await publication.sender.replaceTrack(track);
        if (track) await this.#applyEncodings();
        return;
      } catch (error) {
        // A troca falhou: a publicação não serve mais, mesmo que o objeto exista.
        console.warn(`[sfu] replaceTrack(${slot}) falhou; republicando:`, error);
        publication.state = "stale";
      }
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
    for (const role of ["send", "recv"] as const) {
      const timer = this.#iceTimers[role];
      if (timer) clearTimeout(timer);
      this.#iceTimers[role] = null;
    }
    for (const pc of [this.#send, this.#recv]) {
      pc.onconnectionstatechange = null;
      pc.oniceconnectionstatechange = null;
      pc.ontrack = null;
      pc.close();
    }
    this.#localTracks.clear();
    this.#publications.clear();
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

  // --- recuperação de rede ---------------------------------------------------

  /**
   * `disconnected` costuma ser uma troca de rede e se resolve sozinho; `failed` é
   * definitivo pro caminho atual e exige ICE novo. O teto de tentativas existe
   * porque reiniciar ICE contra um TURN que não responde só repetiria a falha,
   * e aí quem tem que agir é o dono da call, refazendo-a.
   */
  #watchIce(role: "send" | "recv", pc: RTCPeerConnection): void {
    const timer = this.#iceTimers[role];
    if (timer) {
      clearTimeout(timer);
      this.#iceTimers[role] = null;
    }
    if (this.#closed) return;

    if (pc.iceConnectionState === "failed") {
      void this.#restartIce(role, pc);
      return;
    }
    if (pc.iceConnectionState === "disconnected") {
      this.#iceTimers[role] = setTimeout(() => {
        this.#iceTimers[role] = null;
        if (pc.iceConnectionState === "disconnected") void this.#restartIce(role, pc);
      }, ICE_GRACE_MS);
    }
  }

  async #restartIce(role: "send" | "recv", pc: RTCPeerConnection): Promise<void> {
    if (this.#closed || pc.signalingState === "closed") return;
    if (this.#iceRestarts[role] >= MAX_ICE_RESTARTS) {
      this.options.onFailure?.(role === "send" ? "envio não reconectou" : "recepção não reconectou");
      return;
    }
    this.#iceRestarts[role] += 1;

    const work = async () => {
      if (this.#closed || pc.signalingState === "closed") return;
      const offer = await pc.createOffer({ iceRestart: true });
      await this.#setLocal(pc, offer);
      const accepted = await this.options.transport.renegotiate(role, pc.localDescription!);
      if (accepted) return;
      // O SFU não aceitou o ICE novo: a sessão do outro lado não existe mais.
      if (role === "send") this.#invalidatePublications();
      this.options.onFailure?.(role === "send" ? "envio caiu" : "recepção caiu");
    };

    await (role === "send" ? this.#enqueueSend(work) : this.#enqueueRecv(work));
  }

  /** Toda publicação passa a exigir republicação. Não mexe nas trilhas locais. */
  #invalidatePublications(): void {
    for (const publication of this.#publications.values()) publication.state = "stale";
  }

  /**
   * A publicação continua servindo pra `replaceTrack`? Precisa estar viva no
   * nosso controle e o transceiver precisa continuar de pé: um `stop()` do
   * navegador, ou um transporte que caiu, deixa o objeto lá sem entregar nada.
   */
  #usable(publication: Publication): boolean {
    if (publication.state === "stale") return false;
    if (publication.transceiver.currentDirection === "stopped") return false;
    const state = this.#send.connectionState;
    return state !== "failed" && state !== "closed";
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
   * Sobe uma trilha nova, ou repõe uma que deixou de valer. O `mid` só existe
   * depois de `setLocalDescription`, e é ele que amarra "esta linha do SDP" ao
   * nome que os outros vão assinar.
   */
  #publish(slot: MediaSlot, track: MediaStreamTrack): Promise<void> {
    return this.#enqueueSend(async () => {
      if (this.#closed || !(await this.start())) return;
      // A trilha pode ter sido trocada (ou desligada) enquanto esta subia na fila.
      if (this.#localTracks.get(slot) !== track) return;

      const existing = this.#publications.get(slot);
      if (existing && this.#usable(existing)) {
        await existing.sender.replaceTrack(track);
        return;
      }
      // Transceiver de uma publicação morta não volta: encerrá-lo é o que evita
      // deixar um `m=` mudo ocupando lugar no SDP de cada renegociação seguinte.
      if (existing) {
        this.#publications.delete(slot);
        try {
          existing.transceiver.stop();
        } catch {
          // Navegador antigo sem `stop()`: o `m=` fica, e é só isso.
        }
      }

      const transceiver = this.#send.addTransceiver(track, { direction: "sendonly" });
      this.#publications.set(slot, { state: "publishing", transceiver, sender: transceiver.sender });

      const offer = await this.#send.createOffer();
      await this.#setLocal(this.#send, offer);

      // Todas as pendentes de uma vez: o SDP que acabou de ser criado descreve
      // tudo, e mandar só a última deixaria as outras sem nome no SFU.
      const pending: Array<{ mid: string; slot: MediaSlot }> = [];
      for (const [candidate, publication] of this.#publications) {
        if (publication.state === "live") continue;
        const mid = publication.transceiver.mid;
        if (!mid) continue;
        pending.push({ mid, slot: candidate });
      }
      if (pending.length === 0) return;

      const { description, stale } = await this.options.transport.publish(
        this.#send.localDescription!,
        pending,
      );
      if (!description) {
        // A oferta já está aplicada localmente. `stale` é a sessão que trocou no
        // meio (uma reconexão), e aí a call inteira vai ser refeita de qualquer
        // jeito; qualquer outra recusa é o SFU dizendo que esta conexão não
        // publica mais, e insistir aqui só empilharia `m=` que ninguém atende.
        this.#invalidatePublications();
        this.options.onFailure?.(
          stale ? "a sessão de mídia foi substituída" : "o servidor de mídia recusou a transmissão",
        );
        throw new Error(`o SFU não aceitou ${slot}`);
      }
      await this.#send.setRemoteDescription(description);
      for (const entry of pending) {
        const publication = this.#publications.get(entry.slot);
        if (publication) publication.state = "live";
      }
    });
  }

  async #applyEncodings(): Promise<void> {
    for (const [slot, publication] of this.#publications) {
      if (publication.state === "stale") continue;
      await applyProfile(publication.sender, this.#profiles.get(slot));
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
      const accepted = await this.options.transport.renegotiate("recv", this.#recv.localDescription!);
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
      if (ref.slot === "screen") preferLowLatency(transceiver.receiver);
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
