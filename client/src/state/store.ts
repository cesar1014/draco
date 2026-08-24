import { create } from "zustand";
import { type DesktopSource } from "@/desktop";
import {
  DEFAULT_AUDIO_SETTINGS,
  DEFAULT_CAMERA_OPTIONS,
  DEFAULT_SCREEN_OPTIONS,
  MediaManager,
  cameraBitrate,
  describeMediaError,
  normalizeCameraOptions,
  normalizeScreenOptions,
  screenBitrate,
  type AudioSettings,
  type CameraOptions,
  type DeviceList,
  type ScreenShareOptions,
} from "@/rtc/MediaManager";
import { SpeakingDetector, resumeAudio } from "@/rtc/SpeakingDetector";
import { VoiceEngine } from "@/rtc/VoiceEngine";
import { loadIceConfig } from "@/rtc/iceConfig";
import { forgetStats, samplePeer, type PeerStats } from "@/rtc/stats";
import { playCue, setSoundsEnabled } from "@/rtc/sounds";
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
 * Estado da aplicação e orquestração da call.
 *
 * O motor de WebRTC, o acesso aos dispositivos e o detector de fala vivem em
 * variáveis de módulo, fora do estado do React: são objetos vivos e colocá-los no
 * estado faria a árvore inteira re-renderizar a cada mudança de conexão.
 */

export const media = new MediaManager();

let socket: AppSocket | null = null;
let engine: VoiceEngine | null = null;
let detector: SpeakingDetector | null = null;
let statsTimer: ReturnType<typeof setInterval> | null = null;
let credentials = { username: "", password: "" };
let lastConnectError: string | null = null;

export interface PeerMedia {
  streams: Partial<Record<MediaSlot, MediaStream>>;
  /** `false` enquanto a trilha existe mas ainda não chega imagem/som. */
  live: Partial<Record<MediaSlot, boolean>>;
}

export interface Settings extends AudioSettings {
  cameraDeviceId: string | null;
  outputDeviceId: string | null;
  camera: CameraOptions;
  /** Espelhar a própria câmera, como um espelho de verdade. */
  mirrorSelf: boolean;
  pushToTalk: boolean;
  pushToTalkKey: string;
  sounds: boolean;
  /** Desliga desfoque e animações em máquina fraca. */
  liteMode: boolean;
  showStats: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  ...DEFAULT_AUDIO_SETTINGS,
  cameraDeviceId: null,
  outputDeviceId: null,
  camera: DEFAULT_CAMERA_OPTIONS,
  mirrorSelf: true,
  pushToTalk: false,
  pushToTalkKey: "Space",
  sounds: true,
  liteMode: false,
  showStats: false,
};

/** Preferência de volume/mute por pessoa. */
export interface PersonPrefs {
  volume: number;
  muted: boolean;
}

const SETTINGS_KEY = "draco:settings";
const SCREEN_KEY = "draco:screen";
const PEOPLE_KEY = "draco:people";
const STATS_INTERVAL_MS = 2000;

function readJson(key: string): unknown {
  try {
    return JSON.parse(localStorage.getItem(key) ?? "null");
  } catch {
    return null;
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Modo privado com armazenamento bloqueado: vale só nesta sessão.
  }
}

function loadSettings(): Settings {
  const raw = (readJson(SETTINGS_KEY) ?? {}) as Partial<Settings>;
  const pick = <K extends keyof Settings>(key: K): Settings[K] =>
    typeof raw[key] === typeof DEFAULT_SETTINGS[key] ? (raw[key] as Settings[K]) : DEFAULT_SETTINGS[key];

  return {
    micDeviceId: typeof raw.micDeviceId === "string" ? raw.micDeviceId : null,
    cameraDeviceId: typeof raw.cameraDeviceId === "string" ? raw.cameraDeviceId : null,
    outputDeviceId: typeof raw.outputDeviceId === "string" ? raw.outputDeviceId : null,
    echoCancellation: pick("echoCancellation"),
    noiseSuppression: pick("noiseSuppression"),
    autoGainControl: pick("autoGainControl"),
    camera: normalizeCameraOptions(raw.camera),
    mirrorSelf: pick("mirrorSelf"),
    pushToTalk: pick("pushToTalk"),
    pushToTalkKey: pick("pushToTalkKey"),
    sounds: pick("sounds"),
    liteMode: pick("liteMode"),
    showStats: pick("showStats"),
  };
}

/**
 * Preferências por pessoa vão pelo apelido, não pelo id do socket: o id muda a
 * cada reconexão e o volume que você ajustou voltaria ao padrão sozinho.
 */
function loadPeople(): Record<string, PersonPrefs> {
  const raw = readJson(PEOPLE_KEY);
  if (!raw || typeof raw !== "object") return {};
  const out: Record<string, PersonPrefs> = {};
  for (const [key, value] of Object.entries(raw as Record<string, Partial<PersonPrefs>>)) {
    out[key] = {
      volume: typeof value?.volume === "number" ? Math.min(1, Math.max(0, value.volume)) : 1,
      muted: Boolean(value?.muted),
    };
  }
  return out;
}

export const personKey = (username: string): string => username.trim().toLowerCase();

interface Store {
  // --- sessão -------------------------------------------------------------
  status: "join" | "connecting" | "ready";
  selfId: string | null;
  joinError: string | null;
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
  /** Gaveta lateral no celular. */
  sidebarOpen: boolean;

  // --- voz ----------------------------------------------------------------
  voiceChannelId: string | null;
  /** Intenção do usuário. O que vale pro microfone é `muted || deafened`. */
  muted: boolean;
  deafened: boolean;
  camOn: boolean;
  screenOn: boolean;
  /** Tecla de push-to-talk pressionada agora. */
  talking: boolean;
  remote: Record<string, PeerMedia>;
  peerStates: Record<string, RTCPeerConnectionState>;
  stats: Record<string, PeerStats>;
  /**
   * Volume e mute por pessoa, indexado pelo apelido. O teto de volume é 1 porque
   * quem aplica é o `volume` do `<audio>`; passar disso exigiria rotear por Web
   * Audio e aí se perderia o `setSinkId`.
   */
  people: Record<string, PersonPrefs>;
  /**
   * Tiles em destaque, na ordem em que foram fixados. Formato `peerId:slot`.
   * Cabem dois: com três o palco vira uma grade normal de novo.
   */
  focusedTiles: string[];
  /**
   * Telas que a pessoa mandou tocar. Transmissão de tela não abre sozinha — é o
   * clique que liga, como no que já era costume em app de call, e assim ninguém
   * paga decodificação de 1440p que não pediu.
   */
  watching: Record<string, boolean>;
  /** Espelhamento manual por tile, aplicado sobre o padrão. */
  flipped: Record<string, boolean>;

  // --- dispositivos e diagnóstico -----------------------------------------
  settings: Settings;
  devices: DeviceList;
  mediaError: string | null;
  ice: IceConfigResponse | null;
  settingsOpen: boolean;
  screenPickerOpen: boolean;
  screenOptions: ScreenShareOptions;

  // --- ações --------------------------------------------------------------
  bootstrap: () => Promise<void>;
  connect: (username: string, password: string) => Promise<void>;
  selectGuild: (guildId: string) => void;
  selectChannel: (channelId: string) => void;
  setSidebarOpen: (open: boolean) => void;
  sendChat: (content: string) => void;
  joinVoice: (channelId: string) => Promise<void>;
  leaveVoice: () => void;
  toggleMute: () => void;
  toggleDeafen: () => void;
  setTalking: (talking: boolean) => void;
  toggleCamera: () => Promise<void>;
  toggleScreen: () => Promise<void>;
  startScreen: (options: ScreenShareOptions, source?: DesktopSource | null) => Promise<void>;
  setScreenOptions: (options: ScreenShareOptions) => Promise<void>;
  openScreenPicker: () => void;
  closeScreenPicker: () => void;
  setPersonVolume: (username: string, volume: number) => void;
  togglePersonMuted: (username: string) => void;
  resetPerson: (username: string) => void;
  applySettings: (patch: Partial<Settings>) => Promise<void>;
  refreshDevices: () => Promise<void>;
  toggleFocus: (tile: string) => void;
  clearFocus: () => void;
  watch: (tile: string, on: boolean) => void;
  pruneTiles: (keys: string[]) => void;
  toggleFlip: (tile: string) => void;
  openSettings: () => void;
  closeSettings: () => void;
  dismissMediaError: () => void;
}

/** Nível atual do próprio microfone (0 a 1), pro medidor das configurações. */
export const micLevel = () => detector?.level ?? 0;

const byId = (members: Member[]) => Object.fromEntries(members.map((m) => [m.id, m]));

export const useStore = create<Store>()((set, get) => {
  const publishVoiceState = (patch: Partial<VoiceFlags>) => socket?.emit("voice:state", patch);

  /** Mutar é `enabled = false`: a conexão continua de pé e religar é instantâneo. */
  const applyMicEnabled = () => {
    const track = media.micTrack;
    if (!track) return;
    const { muted, deafened, talking, settings } = get();
    track.enabled = !(muted || deafened) && (!settings.pushToTalk || talking);
  };

  /** Mudo pros outros quando o push-to-talk está solto. */
  const micSilent = () => {
    const { muted, deafened, talking, settings } = get();
    return muted || deafened || (settings.pushToTalk && !talking);
  };

  const remember = (members: Member[]) =>
    set((state) => ({ members: { ...state.members, ...byId(members) } }));

  /**
   * O detector precisa ser refeito a cada troca de microfone: apontado pra um
   * stream morto ele simplesmente nunca mais acusa fala.
   */
  const startDetector = () => {
    detector?.stop();
    const micStream = media.micStream;
    if (!micStream) return;
    detector = new SpeakingDetector(micStream, (speaking) => {
      const live = speaking && !micSilent();
      publishVoiceState({ speaking: live });
      const selfId = get().selfId;
      const selfMember = selfId ? get().members[selfId] : null;
      if (selfMember) remember([{ ...selfMember, speaking: live }]);
    });
  };

  const startStats = () => {
    if (statsTimer) clearInterval(statsTimer);
    statsTimer = setInterval(() => {
      if (!engine) return;
      void Promise.all(
        engine.peerIds.map(async (peerId) => {
          const pc = engine?.peerConnection(peerId);
          if (!pc) return null;
          const sample = await samplePeer(peerId, pc);
          return sample ? ([peerId, sample] as const) : null;
        }),
      ).then((entries) => {
        const fresh = entries.filter(Boolean) as (readonly [string, PeerStats])[];
        if (!fresh.length) return;
        set((state) => ({ stats: { ...state.stats, ...Object.fromEntries(fresh) } }));
      });
    }, STATS_INTERVAL_MS);
  };

  const stopStats = () => {
    if (statsTimer) clearInterval(statsTimer);
    statsTimer = null;
    forgetStats();
  };

  const persistPeople = () => writeJson(PEOPLE_KEY, get().people);

  const updatePerson = (username: string, patch: Partial<PersonPrefs>) => {
    const key = personKey(username);
    set((state) => ({
      people: {
        ...state.people,
        [key]: { ...prefsFor(state.people, username), ...patch },
      },
    }));
    persistPeople();
  };

  const fromSnapshot = (snapshot: ServerSnapshot) => ({
    guilds: snapshot.guilds,
    channels: snapshot.channels,
    members: byId(snapshot.members),
    messages: snapshot.messages,
  });

  /** Numa reconexão o canal já está escolhido e a pessoa continua onde estava. */
  const ensureSelection = () => {
    if (get().activeChannelId) return;
    const guild = get().guilds[0];
    if (!guild) return;
    const channel = get().channels.find((c) => c.guildId === guild.id && c.type === "text");
    set({ activeGuildId: guild.id, activeChannelId: channel?.id ?? "" });
  };

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

        // O socket novo tem outro id, então os pares são refeitos do zero.
        const channelId = get().voiceChannelId;
        if (channelId) void get().joinVoice(channelId);
      })();
    });

    s.on("disconnect", (reason) => {
      if (reason !== "io client disconnect") set({ reconnecting: true });
    });

    /**
     * Só guarda o motivo: abortar aqui atropelaria a reconexão automática, que
     * costuma acertar na segunda tentativa. Quem reporta é a rede em `connect`.
     */
    s.on("connect_error", (error) => {
      lastConnectError = error.message;
    });

    s.on("member:joined", (member) => remember([member]));
    s.on("member:state", (member) => remember([member]));

    s.on("member:left", ({ id }) => {
      engine?.removePeer(id);
      forgetStats(id);
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
      playCue("join");
    });

    s.on("voice:peer-left", ({ channelId, memberId }) => {
      if (get().voiceChannelId !== channelId) return;
      engine?.removePeer(memberId);
      forgetStats(memberId);
      playCue("leave");
      set((state) => {
        const remote = { ...state.remote };
        delete remote[memberId];
        return { remote };
      });
    });

    s.on("rtc:signal", ({ from, ...payload }) => engine?.handleSignal(from, payload));
  };

  const initialSettings = loadSettings();
  setSoundsEnabled(initialSettings.sounds);

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
    sidebarOpen: false,

    voiceChannelId: null,
    muted: false,
    deafened: false,
    camOn: false,
    screenOn: false,
    talking: false,
    remote: {},
    peerStates: {},
    stats: {},
    people: loadPeople(),
    focusedTiles: [],
    watching: {},
    flipped: {},

    settings: initialSettings,
    devices: { mics: [], cameras: [], speakers: [] },
    mediaError: null,
    ice: null,
    settingsOpen: false,
    screenPickerOpen: false,
    screenOptions: normalizeScreenOptions(readJson(SCREEN_KEY) ?? DEFAULT_SCREEN_OPTIONS),

    async bootstrap() {
      try {
        const response = await fetch("/api/config");
        const config = (await response.json()) as { requiresPassword?: boolean };
        set({ requiresPassword: Boolean(config.requiresPassword) });
      } catch {
        // Sem resposta o campo de senha não aparece; se houver senha, o erro volta
        // no `identify` com a mensagem certa.
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

      // O prazo é maior que o `timeout` do socket de propósito: assim ele já
      // falhou e deixou o motivo em `lastConnectError` antes desta rede agir.
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
        // "timeout" é o Socket.IO desistindo — serviço acordando, não recusa.
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
      set({ activeChannelId: channelId, sidebarOpen: false });
    },

    setSidebarOpen(open) {
      set({ sidebarOpen: open });
    },

    sendChat(content) {
      const channelId = get().activeChannelId;
      const trimmed = content.trim();
      if (!trimmed || !channelId) return;
      socket?.emit("chat:send", { channelId, content: trimmed });
    },

    async joinVoice(channelId) {
      // Entrar parte de um clique, e é o momento certo de destravar o áudio.
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
      micTrack.enabled = !micSilent();

      const ice = get().ice ?? (await loadIceConfig());
      const selfId = get().selfId;
      if (!selfId) return;

      // Uma call por vez: sair antes de entrar deixa o estado limpo mesmo quando
      // isso é uma reconexão em cima de uma call que já existia.
      engine?.close();
      set({ remote: {}, peerStates: {}, stats: {} });
      forgetStats();

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
      set({ voiceChannelId: channelId, activeChannelId: channelId, sidebarOpen: false });

      await engine.setLocalTrack("mic", micTrack);
      // Só agora: com o microfone anexado, a primeira oferta já sai com áudio.
      engine.syncPeers(reply.peers.map((peer) => peer.id));

      startDetector();
      startStats();
      playCue("join");

      publishVoiceState({
        muted: micSilent(),
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
      stopStats();
      media.closeAll();
      socket?.emit("voice:leave");
      playCue("leave");
      set({
        voiceChannelId: null,
        camOn: false,
        screenOn: false,
        talking: false,
        remote: {},
        peerStates: {},
        stats: {},
        focusedTiles: [],
        watching: {},
        screenPickerOpen: false,
      });
    },

    toggleMute() {
      const muted = !get().muted;
      // Desmutar com o ouvido fechado não faz sentido: abre os dois de uma vez.
      const deafened = muted ? get().deafened : false;
      set({ muted, deafened });
      applyMicEnabled();
      playCue(muted ? "mute" : "unmute");
      publishVoiceState({ muted: micSilent(), deafened });
    },

    toggleDeafen() {
      const deafened = !get().deafened;
      set({ deafened });
      applyMicEnabled();
      playCue(deafened ? "deafen" : "unmute");
      // `muted` guarda a intenção anterior, então tirar o deafen devolve o
      // microfone ao estado em que a pessoa o deixou.
      publishVoiceState({ muted: micSilent(), deafened });
    },

    setTalking(talking) {
      if (get().talking === talking) return;
      set({ talking });
      applyMicEnabled();
      publishVoiceState({ muted: micSilent() });
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
        const options = get().settings.camera;
        const track = await media.openCamera(get().settings.cameraDeviceId, options);
        // Webcam desconectada no meio da call: some o tile em vez de congelar.
        track.onended = () => {
          if (get().camOn) void get().toggleCamera();
        };
        await engine?.setLocalTrack("camera", track);
        await engine?.setMaxBitrate("camera", cameraBitrate(options));
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
      // Abre o painel de qualidade; quem captura é o botão dele. Assim a
      // resolução escolhida vale desde o primeiro quadro.
      set({ screenPickerOpen: true });
    },

    async startScreen(options, source = null) {
      if (!get().voiceChannelId) return;
      set({ screenPickerOpen: false, screenOptions: options });
      writeJson(SCREEN_KEY, options);

      try {
        const { video, audio } = await media.openScreen(options, source);
        // O "Parar de compartilhar" do navegador termina a trilha: sem escutar
        // isso, os outros ficariam vendo o último quadro pra sempre.
        video.onended = () => {
          if (get().screenOn) void get().toggleScreen();
        };
        await engine?.setLocalTrack("screen", video);
        await engine?.setLocalTrack("screenAudio", audio);
        await engine?.setMaxBitrate("screen", screenBitrate(options));
        set({ screenOn: true });
        publishVoiceState({ screenOn: true });
      } catch (error) {
        // Cancelar o seletor de janelas chega como `NotAllowedError` e não é erro.
        const aborted = error instanceof Error && /NotAllowed|Abort/.test(error.name);
        if (!aborted) set({ mediaError: describeMediaError(error) });
      }
    },

    closeScreenPicker() {
      set({ screenPickerOpen: false });
    },

    openScreenPicker() {
      if (get().voiceChannelId) set({ screenPickerOpen: true });
    },

    /** Qualidade mudou com a tela já no ar: ajusta a trilha em vez de recapturar. */
    async setScreenOptions(options) {
      set({ screenOptions: options });
      writeJson(SCREEN_KEY, options);
      if (!get().screenOn) return;
      try {
        await media.applyScreenOptions(options);
        await engine?.setMaxBitrate("screen", screenBitrate(options));
      } catch (error) {
        set({ mediaError: describeMediaError(error) });
      }
    },

    setPersonVolume(username, volume) {
      updatePerson(username, { volume: Math.min(1, Math.max(0, volume)) });
    },

    togglePersonMuted(username) {
      const current = get().people[personKey(username)];
      updatePerson(username, { muted: !current?.muted });
    },

    resetPerson(username) {
      updatePerson(username, { volume: 1, muted: false });
    },

    async applySettings(patch) {
      const settings = { ...get().settings, ...patch };
      set({ settings });
      writeJson(SETTINGS_KEY, settings);

      if (patch.sounds !== undefined) setSoundsEnabled(settings.sounds);
      if (patch.pushToTalk !== undefined) {
        set({ talking: false });
        applyMicEnabled();
        publishVoiceState({ muted: micSilent() });
      }

      // Trocar microfone ou processamento exige reabrir o dispositivo; a trilha
      // nova entra por `replaceTrack`, sem renegociar nem cortar o áudio.
      const audioChanged =
        patch.micDeviceId !== undefined ||
        patch.echoCancellation !== undefined ||
        patch.noiseSuppression !== undefined ||
        patch.autoGainControl !== undefined;

      if (audioChanged && get().voiceChannelId) {
        try {
          const track = await media.openMic(settings);
          track.enabled = !micSilent();
          await engine?.setLocalTrack("mic", track);
          startDetector();
        } catch (error) {
          set({ mediaError: describeMediaError(error) });
        }
      }

      if (patch.camera !== undefined && patch.cameraDeviceId === undefined && get().camOn) {
        // Só resolução/fps: ajusta a trilha viva, sem piscar a imagem.
        try {
          await media.applyCameraOptions(settings.camera);
          await engine?.setMaxBitrate("camera", cameraBitrate(settings.camera));
        } catch (error) {
          set({ mediaError: describeMediaError(error) });
        }
        return;
      }

      if (patch.cameraDeviceId !== undefined && get().camOn) {
        try {
          const track = await media.openCamera(settings.cameraDeviceId, settings.camera);
          track.onended = () => {
            if (get().camOn) void get().toggleCamera();
          };
          await engine?.setLocalTrack("camera", track);
          await engine?.setMaxBitrate("camera", cameraBitrate(settings.camera));
        } catch (error) {
          set({ mediaError: describeMediaError(error) });
        }
      }
    },

    async refreshDevices() {
      set({ devices: await media.listDevices() });
    },

    /**
     * Fixa ou solta um tile. O terceiro empurra o mais antigo em vez de recusar
     * o clique: quem está apontando pra tela nova quer ver a tela nova.
     */
    toggleFocus(tile) {
      set((state) => {
        if (state.focusedTiles.includes(tile)) {
          return { focusedTiles: state.focusedTiles.filter((key) => key !== tile) };
        }
        return { focusedTiles: [...state.focusedTiles, tile].slice(-2) };
      });
    },

    clearFocus() {
      set({ focusedTiles: [] });
    },

    watch(tile, on) {
      set((state) => ({ watching: { ...state.watching, [tile]: on } }));
    },

    /**
     * Some quem saiu da call ou fechou a transmissão. Sem isso, uma tela
     * reaberta voltaria já tocando e ainda fixada de uma sessão anterior.
     */
    pruneTiles(keys) {
      set((state) => {
        const live = new Set(keys);
        const focusedTiles = state.focusedTiles.filter((key) => live.has(key));
        const watching = Object.fromEntries(
          Object.entries(state.watching).filter(([key]) => live.has(key)),
        );
        const same =
          focusedTiles.length === state.focusedTiles.length &&
          Object.keys(watching).length === Object.keys(state.watching).length;
        return same ? state : { focusedTiles, watching };
      });
    },

    toggleFlip(tile) {
      set((state) => ({ flipped: { ...state.flipped, [tile]: !state.flipped[tile] } }));
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

/** Preferências de uma pessoa, com o padrão preenchido. */
export function prefsFor(people: Record<string, PersonPrefs>, username: string): PersonPrefs {
  return people[personKey(username)] ?? { volume: 1, muted: false };
}
