import {
  applyProfile,
  type CallEngine,
  type EngineSample,
  type RemoteTrackRef,
  type TrackProfile,
} from "@/rtc/engine";
import { tuneAudioSdp } from "@/rtc/sdp";
import { sampleScopes, type PeerStats } from "@/rtc/stats";
import { SLOT_KIND, SLOT_ORDER, type MediaSlot, type SignalPayload } from "@/types";

/**
 * Uma conexão direta por par de pessoas na call. Cada conexão carrega quatro
 * trilhas em ordem fixa: microfone, câmera, tela, áudio da tela.
 *
 * É o caminho usado quando não há SFU configurado. Com SFU, quem manda é o
 * `SfuEngine`: sobe uma vez pro servidor em vez de uma vez por pessoa.
 */

export interface VoiceEngineOptions {
  selfId: string;
  configuration: RTCConfiguration;
  sendSignal: (to: string, payload: SignalPayload) => void;
  onRemoteTrack: (peerId: string, slot: MediaSlot, stream: MediaStream, live: boolean) => void;
  onPeerConnectionState?: (peerId: string, state: RTCPeerConnectionState) => void;
}

/** Em malha cada pessoa envia pra todas as outras: sem teto, 6 pessoas entopem o upload. */
const DEFAULT_PROFILES: Partial<Record<MediaSlot, TrackProfile>> = {
  mic: { maxBitrate: 64_000 },
  camera: { maxBitrate: 1_400_000, degradationPreference: "maintain-framerate" },
  screen: { maxBitrate: 3_000_000, degradationPreference: "maintain-resolution" },
  screenAudio: { maxBitrate: 160_000 },
};

const DISCONNECT_GRACE_MS = 6000;
const OFFER_WAIT_MS = 4000;

interface Peer {
  id: string;
  pc: RTCPeerConnection;
  polite: boolean;
  makingOffer: boolean;
  ignoreOffer: boolean;
  settingRemoteAnswerPending: boolean;
  senders: Map<MediaSlot, RTCRtpSender>;
  slots: Map<RTCRtpTransceiver, MediaSlot>;
  queue: Promise<void>;
  disconnectTimer: ReturnType<typeof setTimeout> | null;
  offerTimer: ReturnType<typeof setTimeout> | null;
  negotiations: number;
}

export class VoiceEngine implements CallEngine {
  readonly #peers = new Map<string, Peer>();
  readonly #localTracks = new Map<MediaSlot, MediaStreamTrack | null>();
  readonly #profiles = new Map<MediaSlot, TrackProfile>(
    Object.entries(DEFAULT_PROFILES) as [MediaSlot, TrackProfile][],
  );
  #closed = false;

  constructor(private options: VoiceEngineOptions) {}

  get peerIds(): string[] {
    return [...this.#peers.keys()];
  }

  negotiationCount(peerId: string): number {
    return this.#peers.get(peerId)?.negotiations ?? 0;
  }

  connectionState(peerId: string): RTCPeerConnectionState | null {
    return this.#peers.get(peerId)?.pc.connectionState ?? null;
  }

  peerConnection(peerId: string): RTCPeerConnection | null {
    return this.#peers.get(peerId)?.pc ?? null;
  }

  /**
   * Uma leitura por par. Em malha o que sobe é o mesmo pra todos, então cada
   * conexão é também uma medida do próprio upload, e a adaptação decide pela
   * pior delas.
   */
  async sample(): Promise<EngineSample> {
    const peers = (
      await Promise.all(
        [...this.#peers.values()].map(async (peer) => {
          const [entry] = await sampleScopes(peer.pc, [{ key: peer.id }]);
          return entry ?? null;
        }),
      )
    ).filter(Boolean) as Array<readonly [string, PeerStats]>;
    return { peers, uplink: peers.map(([, sample]) => sample) };
  }

  /**
   * Em malha o conjunto de trilhas não se escolhe: a conexão já carrega as quatro
   * desde a primeira oferta. Só os pares importam, e é o que se sincroniza.
   */
  syncRemote(tracks: RemoteTrackRef[]): void {
    this.syncPeers([...new Set(tracks.map((ref) => ref.memberId))]);
  }

  addPeer(peerId: string): void {
    if (this.#closed || peerId === this.options.selfId || this.#peers.has(peerId)) return;

    const pc = new RTCPeerConnection(this.options.configuration);
    const peer: Peer = {
      id: peerId,
      pc,
      // Comparar ids dá resultados opostos nas duas pontas, então define de uma vez
      // quem cede na colisão de ofertas e quem é o único a ofertar.
      polite: this.options.selfId < peerId,
      makingOffer: false,
      ignoreOffer: false,
      settingRemoteAnswerPending: false,
      senders: new Map(),
      slots: new Map(),
      queue: Promise.resolve(),
      disconnectTimer: null,
      offerTimer: null,
      negotiations: 0,
    };

    pc.onnegotiationneeded = async () => {
      try {
        peer.makingOffer = true;
        peer.negotiations += 1;
        await this.#describe(peer);
      } catch (error) {
        console.error(`[rtc] falha ao ofertar para ${peerId}:`, error);
      } finally {
        peer.makingOffer = false;
      }
    };

    pc.onicecandidate = ({ candidate }) => {
      if (candidate) this.options.sendSignal(peerId, { candidate: candidate.toJSON() });
    };

    pc.ontrack = (event) => {
      this.#mapTransceivers(peer);
      const slot = peer.slots.get(event.transceiver);
      if (!slot) return;

      // Stream próprio em vez de `event.streams[0]`: depois de um `replaceTrack` o
      // stream de origem pode vir vazio.
      const stream = new MediaStream([event.track]);
      const report = (live: boolean) => this.options.onRemoteTrack(peerId, slot, stream, live);

      // `muted` aqui é "ainda não chega mídia", não o mute do usuário.
      report(!event.track.muted);
      event.track.onunmute = () => report(true);
      event.track.onmute = () => report(false);
      event.track.onended = () => report(false);
    };

    pc.onconnectionstatechange = () => {
      this.options.onPeerConnectionState?.(peerId, pc.connectionState);
      // Antes de conectar o sender não tem parâmetros e `setParameters` recusa.
      if (pc.connectionState === "connected") void this.#applyEncodings(peer);
    };

    pc.oniceconnectionstatechange = () => {
      if (peer.disconnectTimer) {
        clearTimeout(peer.disconnectTimer);
        peer.disconnectTimer = null;
      }
      if (pc.iceConnectionState === "failed") {
        this.#recover(peer);
        return;
      }
      if (pc.iceConnectionState === "disconnected") {
        // Costuma se resolver sozinho numa troca de rede; espera antes de gastar
        // uma renegociação.
        peer.disconnectTimer = setTimeout(() => {
          if (pc.iceConnectionState === "disconnected") this.#recover(peer);
        }, DISCONNECT_GRACE_MS);
      }
    };

    this.#peers.set(peerId, peer);

    if (peer.polite) {
      peer.offerTimer = setTimeout(() => {
        peer.offerTimer = null;
        if (!pc.remoteDescription && pc.signalingState !== "closed") {
          this.options.sendSignal(peerId, { requestOffer: true });
        }
      }, OFFER_WAIT_MS);
    } else {
      this.#createTransceivers(peer);
    }
  }

  removePeer(peerId: string): void {
    const peer = this.#peers.get(peerId);
    if (!peer) return;
    if (peer.disconnectTimer) clearTimeout(peer.disconnectTimer);
    if (peer.offerTimer) clearTimeout(peer.offerTimer);
    peer.pc.onnegotiationneeded = null;
    peer.pc.onicecandidate = null;
    peer.pc.ontrack = null;
    peer.pc.onconnectionstatechange = null;
    peer.pc.oniceconnectionstatechange = null;
    peer.pc.close();
    this.#peers.delete(peerId);
  }

  /** Idempotente: depois de uma reconexão de socket, basta chamar de novo. */
  syncPeers(desired: string[]): void {
    const wanted = new Set(desired.filter((id) => id !== this.options.selfId));
    for (const id of this.#peers.keys()) if (!wanted.has(id)) this.removePeer(id);
    for (const id of wanted) this.addPeer(id);
  }

  /** `replaceTrack` em todos os pares: liga e desliga mídia sem renegociar. */
  async setLocalTrack(slot: MediaSlot, track: MediaStreamTrack | null): Promise<void> {
    this.#localTracks.set(slot, track);
    await Promise.all(
      [...this.#peers.values()].map(async (peer) => {
        const sender = peer.senders.get(slot);
        if (!sender) return;
        try {
          await sender.replaceTrack(track);
        } catch (error) {
          console.error(`[rtc] replaceTrack(${slot}) falhou para ${peer.id}:`, error);
        }
      }),
    );
    if (track) await Promise.all([...this.#peers.values()].map((peer) => this.#applyEncodings(peer)));
  }

  localTrack(slot: MediaSlot): MediaStreamTrack | null {
    return this.#localTracks.get(slot) ?? null;
  }

  /** Sem trocar o teto, pedir 1080p60 só devolve a mesma banda mais borrada. */
  async setTrackProfile(slot: MediaSlot, profile: TrackProfile): Promise<void> {
    this.#profiles.set(slot, profile);
    await Promise.all([...this.#peers.values()].map((peer) => this.#applyEncodings(peer)));
  }

  /**
   * Uma fila por par: dois `setRemoteDescription` sobrepostos, ou um candidato
   * aplicado antes da descrição remota, derrubam a conexão com `InvalidStateError`.
   */
  handleSignal(from: string, payload: SignalPayload): void {
    const peer = this.#peers.get(from);
    if (!peer) return;
    peer.queue = peer.queue
      .then(() => this.#processSignal(peer, payload))
      .catch((error) => console.error(`[rtc] sinal de ${from} falhou:`, error));
  }

  async #processSignal(peer: Peer, { description, candidate, requestOffer }: SignalPayload): Promise<void> {
    const { pc } = peer;
    if (pc.signalingState === "closed") return;

    if (requestOffer) {
      if (peer.slots.size === 0) this.#createTransceivers(peer);
      // `restartIce` provoca oferta nova sem duplicar m-line.
      else pc.restartIce();
      return;
    }

    if (description) {
      const readyForOffer =
        !peer.makingOffer && (pc.signalingState === "stable" || peer.settingRemoteAnswerPending);
      const offerCollision = description.type === "offer" && !readyForOffer;

      peer.ignoreOffer = !peer.polite && offerCollision;
      if (peer.ignoreOffer) return;

      peer.settingRemoteAnswerPending = description.type === "answer";
      await pc.setRemoteDescription(description);
      peer.settingRemoteAnswerPending = false;

      if (peer.offerTimer) {
        clearTimeout(peer.offerTimer);
        peer.offerTimer = null;
      }

      if (description.type === "offer") {
        // Adotar, abrir o envio e anexar antes de responder: tudo entra na própria
        // resposta e não custa uma segunda negociação.
        this.#mapTransceivers(peer);
        await this.#openForSending(peer);
        await this.#describe(peer);
      }
      return;
    }

    if (candidate) {
      try {
        await pc.addIceCandidate(candidate);
      } catch (error) {
        // Candidato de uma oferta ignorada chega órfão.
        if (!peer.ignoreOffer) throw error;
      }
    }
  }

  /**
   * Oferta ou resposta com o Opus ajustado. `setLocalDescription()` sem argumento
   * criaria e aplicaria a descrição no mesmo passo, sem deixar tocar no SDP.
   */
  async #describe(peer: Peer): Promise<void> {
    const { pc } = peer;
    const local =
      pc.signalingState === "have-remote-offer" ? await pc.createAnswer() : await pc.createOffer();
    try {
      await pc.setLocalDescription({ type: local.type, sdp: tuneAudioSdp(local.sdp) });
    } catch (error) {
      console.warn("[rtc] SDP ajustado recusado; seguindo com o original:", error);
      await pc.setLocalDescription(local);
    }
    if (pc.localDescription) this.options.sendSignal(peer.id, { description: pc.localDescription });
  }

  /** Só um lado reinicia o ICE: a queda é vista pelas duas pontas ao mesmo tempo. */
  #recover(peer: Peer): void {
    if (peer.polite) this.options.sendSignal(peer.id, { requestOffer: true });
    else peer.pc.restartIce();
  }

  /**
   * Só o lado impolido cria transceivers. Transceiver criado com `addTransceiver`
   * não é reaproveitado pra responder a uma oferta que chega. Se os dois lados
   * criassem os seus, quem responde ficaria com oito e a posição deixaria de
   * identificar a trilha.
   */
  #createTransceivers(peer: Peer): void {
    for (const slot of SLOT_ORDER) {
      const transceiver = peer.pc.addTransceiver(SLOT_KIND[slot], { direction: "sendrecv" });
      peer.slots.set(transceiver, slot);
      peer.senders.set(slot, transceiver.sender);
    }
    void this.#attachLocalTracks(peer);
  }

  /** Associa transceiver → slot pela posição. Só leitura: seguro dentro de eventos. */
  #mapTransceivers(peer: Peer): void {
    const transceivers = peer.pc.getTransceivers();
    for (let index = 0; index < transceivers.length; index += 1) {
      const slot = SLOT_ORDER[index];
      if (!slot) break;
      const transceiver = transceivers[index];
      if (peer.slots.has(transceiver)) continue;
      if (transceiver.receiver.track.kind !== SLOT_KIND[slot]) {
        console.error(`[rtc] ordem inesperada de trilhas de ${peer.id} na posição ${index}`);
        continue;
      }
      peer.slots.set(transceiver, slot);
      peer.senders.set(slot, transceiver.sender);
    }
  }

  /** A oferta cria os transceivers como `recvonly`; virar aqui evita renegociar. */
  async #openForSending(peer: Peer): Promise<void> {
    for (const transceiver of peer.slots.keys()) {
      if (transceiver.direction !== "sendrecv") transceiver.direction = "sendrecv";
    }
    await this.#attachLocalTracks(peer);
  }

  async #attachLocalTracks(peer: Peer): Promise<void> {
    await Promise.all(
      [...this.#localTracks].map(async ([slot, track]) => {
        if (!track) return;
        try {
          await peer.senders.get(slot)?.replaceTrack(track);
        } catch (error) {
          console.error(`[rtc] não deu pra anexar ${slot} em ${peer.id}:`, error);
        }
      }),
    );
  }

  async #applyEncodings(peer: Peer): Promise<void> {
    for (const [slot, sender] of peer.senders) {
      await applyProfile(sender, this.#profiles.get(slot));
    }
  }

  close(): void {
    this.#closed = true;
    for (const id of [...this.#peers.keys()]) this.removePeer(id);
    this.#localTracks.clear();
  }
}
