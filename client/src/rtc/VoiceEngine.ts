import { SLOT_KIND, SLOT_ORDER, type MediaSlot, type SignalPayload } from "@/types";

/**
 * Uma conexão direta por par de pessoas na call (topologia mesh). Cada conexão
 * carrega quatro trilhas em ordem fixa — microfone, câmera, tela, áudio da tela.
 *
 * Três ideias fazem isso funcionar sem engasgo:
 *
 * 1. **Só um dos dois lados oferta.** Quem tem o id maior cria os quatro
 *    transceivers e manda a oferta; o outro não cria nada e espera. Isso não é
 *    preferência de estilo: transceiver criado com `addTransceiver` *não* é
 *    reaproveitado pra responder a uma oferta que chega. Se os dois lados
 *    criassem os seus, quem respondesse ficaria com oito — os quatro próprios
 *    órfãos e mais quatro que o `setRemoteDescription` cria — e a posição
 *    deixaria de identificar a trilha.
 *
 * 2. **Quem responde adota os transceivers que a oferta criou**, vira todos pra
 *    `sendrecv` e anexa suas trilhas *antes* de gerar a resposta. Assim os dois
 *    lados enviam e recebem, com uma única negociação.
 *
 * 3. **Ligar ou desligar mídia é `replaceTrack`**, nunca `addTrack`/`removeTrack`.
 *    Não renegocia nada. Um clone que renegocia a cada botão apertado é de onde
 *    vem o vídeo que trava e o áudio que corta.
 */

export interface VoiceEngineOptions {
  selfId: string;
  configuration: RTCConfiguration;
  sendSignal: (to: string, payload: SignalPayload) => void;
  /**
   * `live` vem do `muted` da trilha recebida. Serve pra saber quando a mídia
   * *começa* a chegar — é o que tira o tile do "conectando…". Não serve pro
   * contrário: `replaceTrack(null)` para de enviar sem o navegador prometer um
   * evento de `mute`. Quem anuncia câmera ou tela desligada é o socket.
   */
  onRemoteTrack: (peerId: string, slot: MediaSlot, stream: MediaStream, live: boolean) => void;
  onPeerConnectionState?: (peerId: string, state: RTCPeerConnectionState) => void;
}

/** Tetos por trilha. Em mesh, cada pessoa envia pra todas as outras: sem teto, 6 pessoas entopem o upload. */
const MAX_BITRATE: Partial<Record<MediaSlot, number>> = {
  camera: 1_200_000,
  screen: 2_500_000,
};

const DEGRADATION: Partial<Record<MediaSlot, RTCDegradationPreference>> = {
  // Rosto travando incomoda mais que rosto borrado.
  camera: "maintain-framerate",
  // Em tela é o contrário: texto ilegível é inútil, 15 fps serve.
  screen: "maintain-resolution",
};

/** Quanto tempo tolerar "disconnected" antes de forçar ICE restart. */
const DISCONNECT_GRACE_MS = 6000;

/** Quanto quem espera a oferta aguarda antes de cobrar. */
const OFFER_WAIT_MS = 4000;

interface Peer {
  id: string;
  pc: RTCPeerConnection;
  /**
   * Quem é "polite" cede em caso de colisão de ofertas — e, aqui, é também quem
   * espera a oferta em vez de ofertar. Comparar os ids dá o mesmo resultado nas
   * duas pontas com sinal oposto, que é exatamente o que as duas regras exigem.
   */
  polite: boolean;
  makingOffer: boolean;
  ignoreOffer: boolean;
  settingRemoteAnswerPending: boolean;
  senders: Map<MediaSlot, RTCRtpSender>;
  /** Transceiver → slot. Preenchido na criação (quem oferta) ou na adoção (quem responde). */
  slots: Map<RTCRtpTransceiver, MediaSlot>;
  /** Fila que serializa a sinalização — ver comentário em `handleSignal`. */
  queue: Promise<void>;
  disconnectTimer: ReturnType<typeof setTimeout> | null;
  offerTimer: ReturnType<typeof setTimeout> | null;
  negotiations: number;
}

export class VoiceEngine {
  readonly #peers = new Map<string, Peer>();
  readonly #localTracks = new Map<MediaSlot, MediaStreamTrack | null>();
  #closed = false;

  constructor(private options: VoiceEngineOptions) {}

  get peerIds(): string[] {
    return [...this.#peers.keys()];
  }

  /** Quantas negociações aquele par já fez. O teste usa isso pra provar que ligar a câmera não renegocia. */
  negotiationCount(peerId: string): number {
    return this.#peers.get(peerId)?.negotiations ?? 0;
  }

  connectionState(peerId: string): RTCPeerConnectionState | null {
    return this.#peers.get(peerId)?.pc.connectionState ?? null;
  }

  peerConnection(peerId: string): RTCPeerConnection | null {
    return this.#peers.get(peerId)?.pc ?? null;
  }

  addPeer(peerId: string): void {
    if (this.#closed || peerId === this.options.selfId || this.#peers.has(peerId)) return;

    const pc = new RTCPeerConnection(this.options.configuration);
    const peer: Peer = {
      id: peerId,
      pc,
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
        await pc.setLocalDescription();
        if (pc.localDescription) this.options.sendSignal(peerId, { description: pc.localDescription });
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
      // Do lado que responde este evento acontece durante o `setRemoteDescription`,
      // antes da adoção. Mapear aqui (só leitura) garante que o slot já é conhecido.
      this.#mapTransceivers(peer);
      const slot = peer.slots.get(event.transceiver);
      if (!slot) return;

      // Embrulhar a trilha num stream próprio, em vez de usar `event.streams[0]`:
      // depois de um `replaceTrack` o stream de origem pode vir vazio.
      const stream = new MediaStream([event.track]);
      const report = (live: boolean) => this.options.onRemoteTrack(peerId, slot, stream, live);

      // `muted` aqui não é o mute do usuário — é "ainda não chega mídia". As
      // trilhas nascem assim, porque os transceivers existem antes das câmeras.
      report(!event.track.muted);
      event.track.onunmute = () => report(true);
      event.track.onmute = () => report(false);
      event.track.onended = () => report(false);
    };

    pc.onconnectionstatechange = () => {
      this.options.onPeerConnectionState?.(peerId, pc.connectionState);
      // Assim que conecta dá pra ajustar bitrate: antes disso o sender ainda
      // não tem parâmetros de envio e `setParameters` recusaria.
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
        // "disconnected" muitas vezes se resolve sozinho (troca de Wi-Fi pra
        // cabo, por exemplo). Espera antes de gastar uma renegociação.
        peer.disconnectTimer = setTimeout(() => {
          if (pc.iceConnectionState === "disconnected") this.#recover(peer);
        }, DISCONNECT_GRACE_MS);
      }
    };

    this.#peers.set(peerId, peer);

    if (peer.polite) {
      // Espera a oferta do outro lado. A cobrança existe pro caso de o outro
      // lado ainda não saber de nós: sem ela, a conexão ficaria "new" pra sempre.
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

  /**
   * Reconcilia a lista de pares com a verdade do servidor. Idempotente de
   * propósito: depois de uma reconexão de socket, chamar isso conserta tanto
   * quem entrou enquanto estávamos fora quanto conexão que morreu no caminho.
   */
  syncPeers(desired: string[]): void {
    const wanted = new Set(desired.filter((id) => id !== this.options.selfId));
    for (const id of this.#peers.keys()) if (!wanted.has(id)) this.removePeer(id);
    for (const id of wanted) this.addPeer(id);
  }

  /**
   * Liga ou desliga uma trilha em todos os pares de uma vez. `null` desliga.
   * É `replaceTrack`, então não dispara renegociação.
   */
  async setLocalTrack(slot: MediaSlot, track: MediaStreamTrack | null): Promise<void> {
    this.#localTracks.set(slot, track);
    await Promise.all(
      [...this.#peers.values()].map(async (peer) => {
        // Par que ainda espera a oferta não tem sender; a adoção anexa depois.
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

  /**
   * Processa o que chegou do outro lado.
   *
   * Cada par tem sua fila porque estes passos não podem se sobrepor: se dois
   * `setRemoteDescription` intercalarem, ou se um candidato ICE for aplicado
   * antes da descrição remota existir, a conexão morre com `InvalidStateError`.
   * Socket.IO entrega em ordem; a fila garante que a gente *processe* em ordem.
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
      // Cobrança de quem está esperando. Se os transceivers ainda não existem, é
      // a primeira oferta; se já existem, a anterior se perdeu e `restartIce`
      // provoca uma nova sem duplicar m-line.
      if (peer.slots.size === 0) this.#createTransceivers(peer);
      else pc.restartIce();
      return;
    }

    if (description) {
      const readyForOffer =
        !peer.makingOffer && (pc.signalingState === "stable" || peer.settingRemoteAnswerPending);
      const offerCollision = description.type === "offer" && !readyForOffer;

      // Colisão: os dois ofertaram junto. Com um ofertante só isso praticamente
      // não acontece, mas um ICE restart simultâneo ainda produz. O impolido
      // ignora a oferta do outro e segue com a sua; o polido aceita a de fora.
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
        // Antes de responder: adotar os transceivers que a oferta criou, abrir o
        // envio e anexar o que já está ligado. Tudo isso entra na própria
        // resposta — daí não custar uma renegociação extra.
        this.#mapTransceivers(peer);
        await this.#openForSending(peer);
        await pc.setLocalDescription();
        if (pc.localDescription) this.options.sendSignal(peer.id, { description: pc.localDescription });
      }
      return;
    }

    if (candidate) {
      try {
        await pc.addIceCandidate(candidate);
      } catch (error) {
        // Candidato de uma oferta que a gente decidiu ignorar chega órfão. Só
        // relança se não era esse o caso.
        if (!peer.ignoreOffer) throw error;
      }
    }
  }

  /**
   * Conserta uma conexão que caiu. Quem reinicia o ICE é sempre o mesmo lado — o
   * que oferta; o outro cobra uma oferta nova. A queda costuma ser vista pelas
   * duas pontas ao mesmo tempo, e sem essa assimetria as duas reiniciariam
   * juntas: duas ofertas cruzadas no pior momento possível, com a conexão já
   * ruim. Assim a recuperação continua sendo uma negociação só.
   */
  #recover(peer: Peer): void {
    if (peer.polite) this.options.sendSignal(peer.id, { requestOffer: true });
    else peer.pc.restartIce();
  }

  /** Lado que oferta: cria as quatro trilhas na ordem do contrato. */
  #createTransceivers(peer: Peer): void {
    for (const slot of SLOT_ORDER) {
      const transceiver = peer.pc.addTransceiver(SLOT_KIND[slot], { direction: "sendrecv" });
      peer.slots.set(transceiver, slot);
      peer.senders.set(slot, transceiver.sender);
    }
    void this.#attachLocalTracks(peer);
  }

  /**
   * Associa cada transceiver ao seu slot pela posição. Só leitura do lado do
   * WebRTC — pode ser chamado de dentro de um evento sem risco de atropelar o
   * `setRemoteDescription` em andamento.
   */
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

  /**
   * Lado que responde: a oferta cria os transceivers como `recvonly`, o que
   * deixaria a gente só ouvindo. Virar pra `sendrecv` aqui, antes da resposta,
   * é o que permite falar sem gastar uma segunda negociação.
   */
  async #openForSending(peer: Peer): Promise<void> {
    for (const transceiver of peer.slots.keys()) {
      if (transceiver.direction !== "sendrecv") transceiver.direction = "sendrecv";
    }
    await this.#attachLocalTracks(peer);
  }

  /** Põe no par o que já está ligado localmente. */
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

  /**
   * Aplica teto de banda e preferência de degradação. Falha silenciosa é
   * aceitável: `setParameters` recusa antes de a conexão ficar de pé, e o
   * `onconnectionstatechange` chama de novo no momento certo.
   */
  async #applyEncodings(peer: Peer): Promise<void> {
    for (const [slot, sender] of peer.senders) {
      const maxBitrate = MAX_BITRATE[slot];
      if (!maxBitrate || !sender.track) continue;
      try {
        const params = sender.getParameters();
        if (!params.encodings?.length) params.encodings = [{}];
        params.encodings[0].maxBitrate = maxBitrate;
        const degradation = DEGRADATION[slot];
        if (degradation) params.degradationPreference = degradation;
        await sender.setParameters(params);
      } catch {
        // Tentado antes da hora; a próxima transição de estado repete.
      }
    }
  }

  close(): void {
    this.#closed = true;
    for (const id of [...this.#peers.keys()]) this.removePeer(id);
    this.#localTracks.clear();
  }
}
