import { create } from "zustand";
import {
  DEFAULT_AUDIO_SETTINGS,
  MediaManager,
  describeMediaError,
  type AudioSettings,
  type DeviceList,
} from "@/rtc/MediaManager";
import { SpeakingDetector, resumeAudio } from "@/rtc/SpeakingDetector";
import { VoiceEngine } from "@/rtc/VoiceEngine";
import { loadIceConfig } from "@/rtc/iceConfig";
import {
  createSocket,
  describeSocketError,
  identify,
  joinVoiceChannel,
  type AppSocket,
  type VoiceFlags,
} from "@/socket";
import type {
  Channel,
  Guild,
  IceConfigResponse,
  MediaSlot,
  Member,
  Message,
  ServerSnapshot,
} from "@/types";

/**
 * Estado da aplicação e, junto, a orquestração da call.
 *
 * O motor de WebRTC, o acesso aos dispositivos e o detector de fala vivem em
 * variáveis de módulo, **fora** do estado do React. Isso é de propósito: são
 * objetos vivos, com trilhas e sockets dentro, e colocá-los no estado faria a
 * árvore inteira re-renderizar a cada mudança de conexão. O que entra no estado
 * é só o que a tela precisa desenhar.
 *
 * O nome de cada campo segue o servidor (`server/state.js`) pra não haver
 * tradução no meio do caminho.
 */

export const media = new MediaManager();

let socket: AppSocket | null = null;
let engine: VoiceEngine | null = null;
let detector: SpeakingDetector | null = null;
/** Guardado pra reconexão: o socket cai, o apelido continua o mesmo. */
let credentials = { username: "", password: "" };
/** Último motivo de handshake recusado, pra tela de entrada dizer a causa real. */
let lastConnectError: string | null = null;

/** Mídia recebida de um par, indexada pelo slot que o motor identificou. */
export interface PeerMedia {
  streams: Partial<Record<MediaSlot, MediaStream>>;
  /** `false` enquanto a trilha existe mas ainda não chega imagem/som. */
  live: Partial<Record<MediaSlot, boolean>>;
}

export interface Settings extends AudioSettings {
  cameraDeviceId: string | null;
  outputDeviceId: string | null;
}

export const DEFAULT_SETTINGS: Settings = {
  ...DEFAULT_AUDIO_SETTINGS,
  cameraDeviceId: null,
  outputDeviceId: null,
};

interface Store {
  // --- sessão -------------------------------------------------------------
  status: "join" | "connecting" | "ready";
  selfId: string | null;
  joinError: string | null;
  /** Verdadeiro entre a queda do socket e a reidentificação. Vira a tarja no topo. */
  reconnecting: boolean;
  requiresPassword: boolean;

  // --- servidor -----------------------------------------------------------
  guilds: Guild[];
  channels: Channel[];
  members: Record<string, Member>;
  messages: Record<string, Message[]>;

  // --- navegação ----------------------------------------------------------
  activeGuildId: string;
  activeChannelId: string;

  // --- voz ----------------------------------------------------------------
  voiceChannelId: string | null;
  /** Intenção do usuário. O que vale pro microfone é `muted || deafened`. */
  muted: boolean;
  deafened: boolean;
  camOn: boolean;
  screenOn: boolean;
  remote: Record<string, PeerMedia>;
  peerStates: Record<string, RTCPeerConnectionState>;
  /**
   * Volume por pessoa, 0 a 1. Ausente significa 1. O teto é 1 porque quem aplica
   * é o `volume` do `<audio>`; passar disso exigiria rotear por Web Audio, e aí
   * se perderia o `setSinkId` — escolher a saída de som vale mais que amplificar.
   */
  peerVolumes: Record<string, number>;
  /** Tile em destaque (clique duplo). Formato `peerId:slot`. */
  focusedTile: string | null;

  // --- dispositivos e diagnóstico -----------------------------------------
  settings: Settings;
  devices: DeviceList;
  mediaError: string | null;
  ice: IceConfigResponse | null;
  settingsOpen: boolean;

  // --- ações --------------------------------------------------------------
  bootstrap: () => Promise<void>;
  connect: (username: string, password: string) => Promise<void>;
  selectGuild: (guildId: string) => void;
  selectChannel: (channelId: string) => void;
  sendChat: (content: string) => void;
  joinVoice: (channelId: string) => Promise<void>;
  leaveVoice: () => void;
  toggleMute: () => void;
  toggleDeafen: () => void;
  toggleCamera: () => Promise<void>;
  toggleScreen: () => Promise<void>;
  setPeerVolume: (peerId: string, volume: number) => void;
  applySettings: (patch: Partial<Settings>) => Promise<void>;
  refreshDevices: () => Promise<void>;
  setFocusedTile: (tile: string | null) => void;
  openSettings: () => void;
  closeSettings: () => void;
  dismissMediaError: () => void;
}

/** Nível atual do próprio microfone (0 a 1), pro medidor das configurações. */
export const micLevel = () => detector?.level ?? 0;

const byId = (members: Member[]) => Object.fromEntries(members.map((m) => [m.id, m]));

export const useStore = create<Store>()((set, get) => {
  /** Guarda o estado de voz no servidor. Ele repassa pra todos verem os ícones. */
  const publishVoiceState = (patch: Partial<VoiceFlags>) => socket?.emit("voice:state", patch);

  /** Mutar é `enabled = false`: a conexão continua de pé e religar é instantâneo. */
  const applyMicEnabled = () => {
    const track = media.micTrack;
    if (track) track.enabled = !(get().muted || get().deafened);
  };

  const remember = (members: Member[]) =>
    set((state) => ({ members: { ...state.members, ...byId(members) } }));

  /**
   * Liga o detector de fala no microfone atual. Vale pra entrada na call e pra
   * troca de dispositivo — em qualquer um dos dois o stream anterior morreu, e um
   * detector apontado pra stream morto simplesmente nunca mais acusa fala.
   */
  const startDetector = () => {
    detector?.stop();
    const micStream = media.micStream;
    if (!micStream) return;
    detector = new SpeakingDetector(micStream, (speaking) => {
      publishVoiceState({ speaking });
      // Eco local: o anel verde no próprio avatar não espera a ida e volta.
      const selfId = get().selfId;
      const selfMember = selfId ? get().members[selfId] : null;
      if (selfMember) remember([{ ...selfMember, speaking }]);
    });
  };

  const fromSnapshot = (snapshot: ServerSnapshot) => ({
    guilds: snapshot.guilds,
    channels: snapshot.channels,
    members: byId(snapshot.members),
    messages: snapshot.messages,
  });

  /**
   * Primeira seleção depois de entrar: primeiro servidor, primeiro canal de
   * texto. Se já houver canal escolhido não mexe — numa reconexão a pessoa
   * continua onde estava em vez de ser jogada de volta pro começo.
   */
  const ensureSelection = () => {
    if (get().activeChannelId) return;
    const guild = get().guilds[0];
    if (!guild) return;
    const channel = get().channels.find((c) => c.guildId === guild.id && c.type === "text");
    set({ activeGuildId: guild.id, activeChannelId: channel?.id ?? "" });
  };

  /**
   * Toda a fiação de eventos num lugar só, ligada uma vez por socket. Reconexão
   * reaproveita estes mesmos ouvintes — o Socket.IO mantém o objeto, só troca o
   * transporte por baixo.
   */
  const wire = (s: AppSocket) => {
    s.on("connect", () => {
      void (async () => {
        const reply = await identify(s, credentials.username, credentials.password);
        if (!reply.ok || !reply.state || !reply.selfId) {
          set({ status: "join", joinError: describeSocketError(reply.error), reconnecting: false });
          s.disconnect();
          return;
        }

        set({
          status: "ready",
          selfId: reply.selfId,
          joinError: null,
          reconnecting: false,
          ...fromSnapshot(reply.state),
        });
        ensureSelection();

        // Se a queda pegou a gente dentro de uma call, volta pra ela. O socket
        // novo tem outro id, então não há como remendar: os pares são refeitos.
        const channelId = get().voiceChannelId;
        if (channelId) void get().joinVoice(channelId);
      })();
    });

    s.on("disconnect", (reason) => {
      // "io client disconnect" é a gente mesmo saindo; não é queda.
      if (reason !== "io client disconnect") set({ reconnecting: true });
    });

    /**
     * Handshake recusado — CORS errado, servidor caído, proxy no caminho. Só
     * guarda o motivo: abortar aqui atropelaria a reconexão automática, que
     * costuma acertar na segunda tentativa. Quem reporta é a rede de segurança
     * em `connect`, e aí com a causa em vez de uma mensagem genérica.
     */
    s.on("connect_error", (error) => {
      lastConnectError = error.message;
    });

    s.on("member:joined", (member) => remember([member]));
    s.on("member:state", (member) => remember([member]));

    s.on("member:left", ({ id }) => {
      engine?.removePeer(id);
      set((state) => {
        const members = { ...state.members };
        const remote = { ...state.remote };
        delete members[id];
        delete remote[id];
        return { members, remote };
      });
    });

    s.on("chat:message", (message) => {
      set((state) => ({
        messages: {
          ...state.messages,
          [message.channelId]: [...(state.messages[message.channelId] ?? []), message],
        },
      }));
    });

    s.on("voice:peer-joined", ({ channelId, member }) => {
      remember([member]);
      if (get().voiceChannelId !== channelId) return;
      engine?.addPeer(member.id);
    });

    s.on("voice:peer-left", ({ channelId, memberId }) => {
      if (get().voiceChannelId !== channelId) return;
      engine?.removePeer(memberId);
      set((state) => {
        const remote = { ...state.remote };
        delete remote[memberId];
        return { remote };
      });
    });

    s.on("rtc:signal", ({ from, ...payload }) => engine?.handleSignal(from, payload));
  };

  return {
    status: "join",
    selfId: null,
    joinError: null,
    reconnecting: false,
    requiresPassword: false,

    guilds: [],
    channels: [],
    members: {},
    messages: {},

    activeGuildId: "",
    activeChannelId: "",

    voiceChannelId: null,
    muted: false,
    deafened: false,
    camOn: false,
    screenOn: false,
    remote: {},
    peerStates: {},
    peerVolumes: {},
    focusedTile: null,

    settings: DEFAULT_SETTINGS,
    devices: { mics: [], cameras: [], speakers: [] },
    mediaError: null,
    ice: null,
    settingsOpen: false,

    async bootstrap() {
      try {
        const response = await fetch("/api/config");
        const config = (await response.json()) as { requiresPassword?: boolean };
        set({ requiresPassword: Boolean(config.requiresPassword) });
      } catch {
        // Sem resposta o campo de senha não aparece; se houver senha, o erro
        // volta no `identify` com a mensagem certa. Não vale travar a tela aqui.
      }
    },

    async connect(username, password) {
      credentials = { username: username.trim(), password };
      lastConnectError = null;
      set({ status: "connecting", joinError: null });

      if (!socket) {
        socket = createSocket();
        wire(socket);
      }
      socket.connect();

      // A tela de entrada sai quando o `identify` responde, dentro de `wire`.
      // Aqui só resta esperar por isso — e desistir se nada voltar. O prazo é
      // maior que o `timeout` do socket de propósito: assim o socket já falhou e
      // deixou o motivo em `lastConnectError` antes desta rede de segurança agir.
      await new Promise<void>((resolve) => {
        if (get().status === "ready") return resolve();
        const timer = setTimeout(resolve, 50000);
        const unsubscribe = useStore.subscribe((state) => {
          if (state.status !== "ready" && !state.joinError) return;
          clearTimeout(timer);
          unsubscribe();
          resolve();
        });
      });

      if (get().status !== "ready") {
        socket.disconnect();
        // "timeout" é o próprio Socket.IO desistindo, e aí a causa provável é
        // serviço acordando — não uma recusa. Qualquer outro texto é a recusa de
        // verdade e vale mostrar cru: é o que permite descobrir o motivo.
        const failure =
          !lastConnectError || lastConnectError === "timeout"
            ? describeSocketError("timeout")
            : `Conexão recusada pelo servidor: ${lastConnectError}`;
        set({ status: "join", joinError: get().joinError ?? failure });
        return;
      }

      void loadIceConfig().then((ice) => set({ ice }));
      void get().refreshDevices();
    },

    selectGuild(guildId) {
      const first = get().channels.find((c) => c.guildId === guildId && c.type === "text");
      set({ activeGuildId: guildId, activeChannelId: first?.id ?? "" });
    },

    selectChannel(channelId) {
      set({ activeChannelId: channelId });
    },

    sendChat(content) {
      const channelId = get().activeChannelId;
      const trimmed = content.trim();
      if (!trimmed || !channelId) return;
      socket?.emit("chat:send", { channelId, content: trimmed });
    },

    async joinVoice(channelId) {
      // Entrar sempre parte de um clique, e é o momento certo de destravar o
      // áudio: navegador nasce com o contexto suspenso e sem isso a pessoa
      // entra na call sem ouvir ninguém.
      resumeAudio();
      const s = socket;
      if (!s) return;

      let micTrack: MediaStreamTrack;
      try {
        micTrack = await media.openMic(get().settings);
      } catch (error) {
        set({ mediaError: describeMediaError(error) });
        return;
      }
      micTrack.enabled = !(get().muted || get().deafened);

      const ice = get().ice ?? (await loadIceConfig());
      const selfId = get().selfId;
      if (!selfId) return;

      // Uma call por vez: sair antes de entrar deixa o estado limpo mesmo quando
      // isso é uma reconexão em cima de uma call que já existia.
      engine?.close();
      set({ remote: {}, peerStates: {} });

      engine = new VoiceEngine({
        selfId,
        configuration: { iceServers: ice.iceServers, iceTransportPolicy: ice.iceTransportPolicy },
        sendSignal: (to, payload) => s.emit("rtc:signal", { to, ...payload }),
        onRemoteTrack: (peerId, slot, stream, live) => {
          set((state) => {
            const current = state.remote[peerId] ?? { streams: {}, live: {} };
            if (current.streams[slot] === stream && current.live[slot] === live) return state;
            return {
              remote: {
                ...state.remote,
                [peerId]: {
                  streams: { ...current.streams, [slot]: stream },
                  live: { ...current.live, [slot]: live },
                },
              },
            };
          });
        },
        onPeerConnectionState: (peerId, connectionState) => {
          set((state) => ({ peerStates: { ...state.peerStates, [peerId]: connectionState } }));
        },
      });

      const reply = await joinVoiceChannel(s, channelId);
      if (!reply.ok || !reply.peers) {
        engine.close();
        engine = null;
        set({ mediaError: describeSocketError(reply.error) });
        return;
      }

      remember(reply.peers);
      set({ voiceChannelId: channelId, activeChannelId: channelId });

      await engine.setLocalTrack("mic", micTrack);
      // Só agora: com o microfone já anexado, a primeira oferta já sai com áudio.
      engine.syncPeers(reply.peers.map((peer) => peer.id));

      startDetector();

      publishVoiceState({
        muted: get().muted || get().deafened,
        deafened: get().deafened,
        camOn: false,
        screenOn: false,
      });
    },

    leaveVoice() {
      detector?.stop();
      detector = null;
      engine?.close();
      engine = null;
      media.closeAll();
      socket?.emit("voice:leave");
      set({
        voiceChannelId: null,
        camOn: false,
        screenOn: false,
        remote: {},
        peerStates: {},
        focusedTile: null,
      });
    },

    toggleMute() {
      const muted = !get().muted;
      // Desmutar com o ouvido fechado não faz sentido — o Discord também abre os
      // dois de uma vez.
      const deafened = muted ? get().deafened : false;
      set({ muted, deafened });
      applyMicEnabled();
      publishVoiceState({ muted: muted || deafened, deafened });
    },

    toggleDeafen() {
      const deafened = !get().deafened;
      set({ deafened });
      applyMicEnabled();
      // `muted` continua guardando a intenção anterior, então tirar o deafen
      // devolve o microfone ao estado em que a pessoa o tinha deixado.
      publishVoiceState({ muted: get().muted || deafened, deafened });
    },

    async toggleCamera() {
      if (!get().voiceChannelId) return;
      if (get().camOn) {
        media.closeCamera();
        await engine?.setLocalTrack("camera", null);
        set({ camOn: false });
        publishVoiceState({ camOn: false });
        return;
      }
      try {
        const track = await media.openCamera(get().settings.cameraDeviceId);
        // Webcam desconectada no meio da call: some o tile em vez de congelar.
        track.onended = () => {
          if (get().camOn) void get().toggleCamera();
        };
        await engine?.setLocalTrack("camera", track);
        set({ camOn: true });
        publishVoiceState({ camOn: true });
      } catch (error) {
        set({ mediaError: describeMediaError(error) });
      }
    },

    async toggleScreen() {
      if (!get().voiceChannelId) return;
      if (get().screenOn) {
        media.closeScreen();
        await engine?.setLocalTrack("screen", null);
        await engine?.setLocalTrack("screenAudio", null);
        set({ screenOn: false });
        publishVoiceState({ screenOn: false });
        return;
      }
      try {
        const { video, audio } = await media.openScreen();
        // O botão "Parar de compartilhar" do próprio navegador termina a trilha:
        // sem escutar isso, os outros ficariam vendo o último quadro pra sempre.
        video.onended = () => {
          if (get().screenOn) void get().toggleScreen();
        };
        await engine?.setLocalTrack("screen", video);
        await engine?.setLocalTrack("screenAudio", audio);
        set({ screenOn: true });
        publishVoiceState({ screenOn: true });
      } catch (error) {
        // Cancelar o seletor de janelas cai aqui como `NotAllowedError`, e não é
        // erro nenhum — não vale abrir aviso vermelho por desistir de compartilhar.
        const aborted = error instanceof Error && /NotAllowed|Abort/.test(error.name);
        if (!aborted) set({ mediaError: describeMediaError(error) });
      }
    },

    setPeerVolume(peerId, volume) {
      set((state) => ({ peerVolumes: { ...state.peerVolumes, [peerId]: volume } }));
    },

    async applySettings(patch) {
      const settings = { ...get().settings, ...patch };
      set({ settings });

      // Trocar microfone ou processamento de áudio exige abrir o dispositivo de
      // novo; a trilha nova entra por `replaceTrack`, sem renegociar nem cortar
      // o áudio de quem está ouvindo.
      const audioChanged =
        patch.micDeviceId !== undefined ||
        patch.echoCancellation !== undefined ||
        patch.noiseSuppression !== undefined ||
        patch.autoGainControl !== undefined;

      if (audioChanged && get().voiceChannelId) {
        try {
          const track = await media.openMic(settings);
          track.enabled = !(get().muted || get().deafened);
          await engine?.setLocalTrack("mic", track);
          startDetector();
        } catch (error) {
          set({ mediaError: describeMediaError(error) });
        }
      }

      if (patch.cameraDeviceId !== undefined && get().camOn) {
        try {
          const track = await media.openCamera(settings.cameraDeviceId);
          await engine?.setLocalTrack("camera", track);
        } catch (error) {
          set({ mediaError: describeMediaError(error) });
        }
      }
    },

    async refreshDevices() {
      set({ devices: await media.listDevices() });
    },

    setFocusedTile(tile) {
      set({ focusedTile: tile });
    },

    openSettings() {
      void get().refreshDevices();
      set({ settingsOpen: true });
    },

    closeSettings() {
      set({ settingsOpen: false });
    },

    dismissMediaError() {
      set({ mediaError: null });
    },
  };
});

/** Membros de um canal de voz, em ordem estável de nome. */
export function membersInVoice(members: Record<string, Member>, channelId: string | null): Member[] {
  if (!channelId) return [];
  return Object.values(members)
    .filter((member) => member.voiceChannelId === channelId)
    .sort((a, b) => a.username.localeCompare(b.username, "pt-BR"));
}
