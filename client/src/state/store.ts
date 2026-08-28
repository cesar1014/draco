import { create } from "zustand";
import {
  DEFAULT_AUDIO_SETTINGS,
  DEFAULT_CAMERA_OPTIONS,
  DEFAULT_SCREEN_OPTIONS,
  MediaManager,
  cameraBitrate,
  describeCameraError,
  describeMicrophoneError,
  describeScreenShareError,
  normalizeCameraOptions,
  normalizeScreenOptions,
  screenBitrate,
  screenDegradation,
  screenShareSupported,
  userCancelled,
  type AudioSettings,
  type CameraFacing,
  type CameraOptions,
  type DeviceList,
  type ScreenShareOptions,
} from "@/rtc/MediaManager";
import { SpeakingDetector, resumeAudio } from "@/rtc/SpeakingDetector";
import { SfuEngine, type SfuTransport } from "@/rtc/SfuEngine";
import { VoiceEngine } from "@/rtc/VoiceEngine";
import { AdaptiveController, scaleProfile } from "@/rtc/adaptive";
import {
  DENOISE_MODES,
  DENOISE_STRENGTHS,
  type DenoiseMode,
  type DenoiseStrength,
} from "@/rtc/denoise";
import type { CallEngine, RemoteTrackRef, TrackProfile } from "@/rtc/engine";
import { loadIceConfig } from "@/rtc/iceConfig";
import { forgetStats, type PeerStats } from "@/rtc/stats";
import { playCue, setSoundVolume, setSoundsEnabled } from "@/rtc/sounds";
import {
  createSocket,
  describeSocketError,
  identify,
  joinVoiceChannel,
  loadChatHistory,
  sfuJoin,
  sfuPublish,
  sfuRenegotiate,
  sfuSubscribe,
  type AppSocket,
  type VoiceFlags,
} from "@/socket";
import {
  SLOT_ORDER,
  type Channel,
  type Guild,
  type IceConfigResponse,
  type MediaSlot,
  type Member,
  type Message,
  type ServerSnapshot,
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
let engine: CallEngine | null = null;
let detector: SpeakingDetector | null = null;
let statsTimer: ReturnType<typeof setInterval> | null = null;
let credentials = { username: "", password: "" };
let lastConnectError: string | null = null;
/** O servidor respondeu que tem SFU: a mídia sobe uma vez, não uma por pessoa. */
let sfuAvailable = false;
/** Teto que a pessoa escolheu, antes de a adaptação mexer. */
const chosenProfiles = new Map<MediaSlot, TrackProfile>();
const adaptive = new AdaptiveController();
/**
 * Uma entrada de cada vez. Um clique repetido ou uma reconexão em cima de outra
 * fariam duas negociações concorrentes na mesma call, e a segunda derrubaria as
 * trilhas da primeira.
 */
let joining = false;
let lastRestart = 0;
/** Reentradas gastas nesta permanência no canal. Zera ao entrar por clique. */
let restartAttempts = 0;
/**
 * A próxima entrada precisa de configuração de ICE nova, não da guardada. Vira
 * verdadeiro quando a mídia caiu: se a credencial de TURN foi o motivo, reusá-la
 * levaria à mesma falha, e o cliente ficaria preso em STUN até recarregar.
 */
let refreshIce = false;

export interface PeerMedia {
  streams: Partial<Record<MediaSlot, MediaStream>>;
  /** `false` enquanto a trilha existe mas ainda não chega imagem/som. */
  live: Partial<Record<MediaSlot, boolean>>;
}

export interface Settings extends AudioSettings {
  cameraDeviceId: string | null;
  /** Lente pedida quando não há dispositivo fixo: vale no celular. */
  cameraFacing: CameraFacing;
  outputDeviceId: string | null;
  camera: CameraOptions;
  /** Espelhar a própria câmera, como um espelho de verdade. */
  mirrorSelf: boolean;
  pushToTalk: boolean;
  pushToTalkKey: string;
  sounds: boolean;
  soundVolume: number;
  /** Desliga desfoque e animações em máquina fraca. */
  liteMode: boolean;
  showStats: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  ...DEFAULT_AUDIO_SETTINGS,
  cameraDeviceId: null,
  cameraFacing: "user",
  outputDeviceId: null,
  camera: DEFAULT_CAMERA_OPTIONS,
  mirrorSelf: true,
  pushToTalk: false,
  pushToTalkKey: "Space",
  sounds: true,
  soundVolume: 0.7,
  liteMode: false,
  showStats: false,
};

/** Preferência de volume/mute por pessoa, microfone e transmissão em separado. */
export interface PersonPrefs {
  volume: number;
  muted: boolean;
  screenVolume: number;
  screenMuted: boolean;
}

const DEFAULT_PREFS: PersonPrefs = { volume: 1, muted: false, screenVolume: 1, screenMuted: false };

/** Dobro do normal. Serve pra quem tem microfone fraco; acima disso só sobra chiado. */
export const MAX_PERSON_VOLUME = 2;

const SETTINGS_KEY = "draco:settings";
const SCREEN_KEY = "draco:screen";
const PEOPLE_KEY = "draco:people";
const SESSION_KEY = "draco:session";
const STATS_INTERVAL_MS = 2000;
/** Espaço entre duas tentativas de refazer a call por queda de mídia. */
const RESTART_COOLDOWN_MS = 5000;
/** Depois disto a call não volta sozinha: insistir só esconde o problema real. */
const MAX_RESTARTS = 3;

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

/**
 * Token de sessão, guardado no navegador. É o que permite reconectar como a
 * mesma pessoa: sem ele, cada oscilação de Wi-Fi criaria um membro novo na lista
 * de todos e apagaria o volume que os outros ajustaram pra você.
 *
 * Guarda o token, não o identificador. Quem decide de quem é a identidade é o
 * servidor, que só a devolve pra quem apresenta a assinatura dele: antes bastava
 * conhecer o id de alguém pra entrar como essa pessoa.
 */
function readSessionToken(): string | null {
  const raw = readJson(SESSION_KEY);
  return typeof raw === "string" && raw.length > 0 && raw.length <= 512 ? raw : null;
}

function loadSettings(): Settings {
  const raw = (readJson(SETTINGS_KEY) ?? {}) as Partial<Settings> & { noiseSuppression?: boolean };
  const pick = <K extends keyof Settings>(key: K): Settings[K] =>
    typeof raw[key] === typeof DEFAULT_SETTINGS[key] ? (raw[key] as Settings[K]) : DEFAULT_SETTINGS[key];

  return {
    micDeviceId: typeof raw.micDeviceId === "string" ? raw.micDeviceId : null,
    cameraDeviceId: typeof raw.cameraDeviceId === "string" ? raw.cameraDeviceId : null,
    cameraFacing: raw.cameraFacing === "environment" ? "environment" : "user",
    outputDeviceId: typeof raw.outputDeviceId === "string" ? raw.outputDeviceId : null,
    echoCancellation: pick("echoCancellation"),
    // Antes daqui era um booleano de liga/desliga; quem tinha desligado continua sem.
    denoise: DENOISE_MODES.includes(raw.denoise as DenoiseMode)
      ? (raw.denoise as DenoiseMode)
      : raw.noiseSuppression === false
        ? "off"
        : DEFAULT_SETTINGS.denoise,
    denoiseStrength: DENOISE_STRENGTHS.includes(raw.denoiseStrength as DenoiseStrength)
      ? (raw.denoiseStrength as DenoiseStrength)
      : DEFAULT_SETTINGS.denoiseStrength,
    autoGainControl: pick("autoGainControl"),
    camera: normalizeCameraOptions(raw.camera),
    mirrorSelf: pick("mirrorSelf"),
    pushToTalk: pick("pushToTalk"),
    pushToTalkKey: pick("pushToTalkKey"),
    sounds: pick("sounds"),
    soundVolume:
      typeof raw.soundVolume === "number"
        ? Math.min(1, Math.max(0, raw.soundVolume))
        : DEFAULT_SETTINGS.soundVolume,
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
  const level = (value: unknown) =>
    typeof value === "number" ? Math.min(MAX_PERSON_VOLUME, Math.max(0, value)) : 1;

  const out: Record<string, PersonPrefs> = {};
  for (const [key, value] of Object.entries(raw as Record<string, Partial<PersonPrefs>>)) {
    out[key] = {
      volume: level(value?.volume),
      muted: Boolean(value?.muted),
      screenVolume: level(value?.screenVolume),
      screenMuted: Boolean(value?.screenMuted),
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
  /**
   * Por canal: ainda existe conversa antes da mais antiga que temos. Vem do
   * servidor e é o que decide se rolar até o topo pede mais ou para ali.
   */
  history: Record<string, boolean>;
  /** Canal com um pedido de histórico em curso, pra não disparar dois. */
  loadingHistory: string | null;

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
  /** Lente que a câmera própria está usando de fato, ou `null` fora do celular. */
  liveFacing: CameraFacing | null;
  /** Tecla de push-to-talk pressionada agora. */
  talking: boolean;
  remote: Record<string, PeerMedia>;
  peerStates: Record<string, RTCPeerConnectionState>;
  stats: Record<string, PeerStats>;
  /**
   * Volume e mute por pessoa, indexado pelo apelido. Até 100% quem aplica é o
   * `volume` do `<audio>`; acima disso o som passa por um ganho da Web Audio e
   * volta pro mesmo elemento, que segue mandando na saída e no mudo.
   */
  people: Record<string, PersonPrefs>;
  /**
   * Tiles em destaque, na ordem em que foram fixados. Formato `peerId:slot`.
   * Cabem dois: com três o palco vira uma grade normal de novo.
   */
  focusedTiles: string[];
  /**
   * Telas que a pessoa mandou tocar. Transmissão de tela não abre sozinha, é o
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
  /** Aviso discreto que não interrompe nada, some sozinho na interface. */
  notice: string | null;
  ice: IceConfigResponse | null;
  /** A mídia está passando por servidor (SFU) em vez de malha direta. */
  viaServer: boolean;
  /**
   * Degrau da qualidade adaptativa: 0 é o teto escolhido, e cada degrau acima
   * significa que a rede não estava dando conta. O painel de estatísticas mostra.
   */
  qualityStep: number;
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
  loadOlderMessages: (channelId: string) => Promise<void>;
  joinVoice: (channelId: string) => Promise<void>;
  leaveVoice: () => void;
  toggleMute: () => void;
  toggleDeafen: () => void;
  setTalking: (talking: boolean) => void;
  toggleCamera: () => Promise<void>;
  switchCamera: () => Promise<void>;
  toggleScreen: () => Promise<void>;
  startScreen: (options: ScreenShareOptions, sourceId?: string | null) => Promise<void>;
  setScreenOptions: (options: ScreenShareOptions) => Promise<void>;
  openScreenPicker: () => void;
  closeScreenPicker: () => void;
  setPersonVolume: (username: string, volume: number) => void;
  togglePersonMuted: (username: string) => void;
  setScreenVolume: (username: string, volume: number) => void;
  toggleScreenMuted: (username: string) => void;
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
  dismissNotice: () => void;
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

  /**
   * Amostra as conexões e, na mesma passada, decide se o teto de banda precisa
   * mudar. Junto porque é a mesma informação: as estatísticas que aparecem no
   * tile são as que dizem se a rede está dando conta.
   */
  const startStats = () => {
    if (statsTimer) clearInterval(statsTimer);
    statsTimer = setInterval(() => {
      const current = engine;
      if (!current) return;
      void current.sample().then(({ peers, uplink }) => {
        if (engine !== current) return;
        if (peers.length) {
          set((state) => ({ stats: { ...state.stats, ...Object.fromEntries(peers) } }));
        }

        // Só faz sentido adaptar enquanto há vídeo subindo: com só microfone no ar
        // o teto não é o gargalo e mexer nele não muda nada.
        if (!get().camOn && !get().screenOn) return;
        const decision = adaptive.observe(uplink);
        if (!decision.changed) return;
        set({ qualityStep: decision.step });
        for (const slot of ["camera", "screen"] as const) {
          const chosen = chosenProfiles.get(slot);
          if (chosen) void current.setTrackProfile(slot, scaleProfile(chosen, decision));
        }
      });
    }, STATS_INTERVAL_MS);
  };

  const stopStats = () => {
    if (statsTimer) clearInterval(statsTimer);
    statsTimer = null;
    forgetStats();
    // A escada volta ao topo porque o degrau em que ela estava dizia respeito a
    // conexões que não existem mais. O teto escolhido pela pessoa não: numa
    // reconexão ele é reaplicado nas conexões novas.
    adaptive.reset();
    set({ qualityStep: 0 });
  };

  /**
   * Teto escolhido pela pessoa. Guardar em separado é o que permite à adaptação
   * descer e voltar: o degrau é sempre calculado sobre este valor, não sobre o
   * último que foi aplicado.
   */
  const setProfile = async (slot: MediaSlot, profile: TrackProfile) => {
    chosenProfiles.set(slot, profile);
    await engine?.setTrackProfile(slot, scaleProfile(profile, adaptive.current()));
  };

  /**
   * Parou de enviar este slot. Sem vídeo nenhum no ar a escada volta ao topo: o
   * degrau em que ela estava dizia respeito a uma transmissão que já não existe.
   */
  const dropProfile = (slot: MediaSlot) => {
    chosenProfiles.delete(slot);
    if (chosenProfiles.size === 0) {
      adaptive.reset();
      set({ qualityStep: 0 });
    }
  };

  /** Trilhas que devem estar chegando: quem está na call, com o que ligou. */
  const desiredRemote = (): RemoteTrackRef[] => {
    const { members, voiceChannelId, selfId } = get();
    const refs: RemoteTrackRef[] = [];
    for (const member of membersInVoice(members, voiceChannelId)) {
      if (member.id === selfId) continue;
      for (const slot of SLOT_ORDER) {
        // Em malha as quatro trilhas existem desde a primeira oferta; com SFU só
        // se assina o que o dono publicou de fato.
        if (!sfuAvailable) {
          refs.push({ memberId: member.id, slot, sessionId: null });
          continue;
        }
        if (!member.sfuSessionId || !member.sfuTracks?.[slot]) continue;
        refs.push({ memberId: member.id, slot, sessionId: member.sfuSessionId });
      }
    }
    return refs;
  };

  const syncRemote = () => engine?.syncRemote(desiredRemote());

  /** Um tile some quando a pessoa sai; as trilhas dela também. */
  const dropPeer = (memberId: string) => {
    engine?.removePeer(memberId);
    forgetStats(memberId);
    set((state) => {
      if (!state.remote[memberId] && !state.peerStates[memberId] && !state.stats[memberId]) {
        return state;
      }
      const remote = { ...state.remote };
      const peerStates = { ...state.peerStates };
      const stats = { ...state.stats };
      delete remote[memberId];
      // O estado da conexão de quem saiu ficaria pendurado em `disconnected`, e a
      // barra de voz leria isso como a call inteira com problema.
      delete peerStates[memberId];
      delete stats[memberId];
      return { remote, peerStates, stats };
    });
  };

  const onRemoteTrack = (
    peerId: string,
    slot: MediaSlot,
    stream: MediaStream,
    live: boolean,
  ) => {
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
  };

  /**
   * Ponte entre o `SfuEngine` e o socket. O engine não conhece Socket.IO e o
   * servidor é o único que fala com a Cloudflare: tudo passa por aqui.
   */
  const sfuTransport = (s: AppSocket): SfuTransport => ({
    join: async () => (await sfuJoin(s)).ok,
    publish: async (description, tracks) => {
      const reply = await sfuPublish(s, description, tracks);
      // `stale-session` é a sessão que trocou durante a publicação: a call vai ser
      // refeita de qualquer jeito, e distingui-la evita mostrar "o servidor
      // recusou" pra algo que foi só uma reconexão.
      return {
        description: reply.ok ? (reply.description ?? null) : null,
        stale: reply.error === "stale-session",
      };
    },
    subscribe: async (refs) => {
      // A sessão vai no pedido pra o servidor conferir que a trilha ainda é
      // daquela sessão: a pessoa pode ter reconectado nesse intervalo.
      const tracks = refs
        .filter((ref) => ref.sessionId !== null)
        .map((ref) => ({ memberId: ref.memberId, slot: ref.slot, sessionId: ref.sessionId! }));
      if (tracks.length === 0) return null;
      const reply = await sfuSubscribe(s, tracks);
      if (!reply.ok) return null;
      return { description: reply.description ?? null, tracks: reply.tracks ?? [] };
    },
    renegotiate: async (role, description) => (await sfuRenegotiate(s, role, description)).ok,
  });

  /**
   * Reentrar é a recuperação de última instância: quando a conexão com o SFU
   * morre, refazer a call devolve imagem e som sem a pessoa ter que sair e voltar
   * à mão. As duas conexões podem falhar juntas, e uma tentativa por vez com um
   * limite é o que impede que isso vire um laço de reentradas.
   */
  const restartCall = (channelId: string, reason: string) => {
    if (get().voiceChannelId !== channelId || joining) return;
    const now = Date.now();
    if (now - lastRestart < RESTART_COOLDOWN_MS) return;
    lastRestart = now;

    if (restartAttempts >= MAX_RESTARTS) {
      set({
        notice: null,
        mediaError: `A conexão de mídia não se restabeleceu (${reason}). Saia e entre no canal de voz de novo.`,
      });
      return;
    }
    restartAttempts += 1;
    // A configuração guardada pode ser justamente o problema: credencial de TURN
    // revogada ou vencida derruba o ICE, e insistir na mesma repetiria a falha.
    refreshIce = true;
    set({ notice: `A conexão de mídia caiu (${reason}). Reconectando…` });
    void get().joinVoice(channelId);
  };

  /**
   * Entra na call. Quem escolhe o caminho da mídia é o servidor, e a escolha vale
   * pra todos: com credenciais do SFU a mídia sobe uma vez e ele replica; sem
   * elas, cada pessoa liga em cada pessoa. Não há meio caminho: um cliente que
   * decidisse sozinho ir de malha tentaria falar com quem está esperando pelo SFU,
   * e o resultado seria uma call muda sem erro que explique o porquê.
   *
   * Reconexão passa por aqui também, porque as conexões de mídia não sobrevivem à queda
   * do socket, e refazê-las é o que devolve som e imagem.
   */
  const enterVoice = async (s: AppSocket, channelId: string) => {
    let micTrack: MediaStreamTrack;
    try {
      micTrack = await media.openMic(get().settings);
    } catch (error) {
      set({ mediaError: describeMicrophoneError(error) });
      return;
    }
    micTrack.enabled = !micSilent();

    // Sempre pelo cache com prazo, nunca pelo que ficou no estado: uma sessão
    // longa precisa de credencial de TURN válida agora, não da de quando entrou.
    const ice = await loadIceConfig(refreshIce);
    refreshIce = false;
    set({ ice });
    const selfId = get().selfId;
    if (!selfId) return;

    engine?.close();
    engine = null;
    stopStats();
    set({ remote: {}, peerStates: {}, stats: {} });

    const configuration: RTCConfiguration = {
      iceServers: ice.iceServers,
      iceTransportPolicy: ice.iceTransportPolicy,
    };

    const reply = await joinVoiceChannel(s, channelId);
    if (!reply.ok || !reply.peers) {
      set({ mediaError: describeSocketError(reply.error) });
      return;
    }

    // A resposta do `voice:join` é a informação mais recente sobre o caminho:
    // credenciais podem ter mudado desde o `identify`.
    sfuAvailable = reply.sfu === true;

    remember(reply.peers);
    set({
      voiceChannelId: channelId,
      activeChannelId: channelId,
      sidebarOpen: false,
      viaServer: sfuAvailable,
    });

    const call: CallEngine = sfuAvailable
      ? new SfuEngine({
          configuration,
          transport: sfuTransport(s),
          onRemoteTrack,
          onConnectionState: (role, connectionState) => {
            // Conectou: o que veio antes está resolvido, e a próxima queda merece
            // as tentativas de novo em vez de esbarrar num limite antigo.
            if (role === "send" && connectionState === "connected") restartAttempts = 0;
            set((state) => ({
              peerStates: { ...state.peerStates, [`sfu:${role}`]: connectionState },
            }));
          },
          onFailure: (reason) => restartCall(channelId, reason),
        })
      : new VoiceEngine({
          selfId,
          configuration,
          sendSignal: (to, payload) => s.emit("rtc:signal", { to, ...payload }),
          onRemoteTrack,
          onPeerConnectionState: (peerId, connectionState) => {
            if (connectionState === "connected") restartAttempts = 0;
            set((state) => ({ peerStates: { ...state.peerStates, [peerId]: connectionState } }));
          },
        });
    engine = call;

    // A pessoa pode ter saído, ou trocado de canal, enquanto o `voice:join` ia e
    // voltava. Sem esta conferência ficaria uma conexão órfã enviando microfone.
    if (get().voiceChannelId !== channelId) {
      call.close();
      if (engine === call) engine = null;
      return;
    }

    await call.setLocalTrack("mic", micTrack);

    // Reconexão em cima de uma câmera ou tela que já estava no ar: as trilhas
    // continuam vivas, só a conexão que as levava é nova. Reanexar aqui é o que
    // evita fazer a pessoa desligar e religar a transmissão.
    const localTracks: Array<[MediaSlot, MediaStreamTrack | null]> = [
      ["camera", media.cameraTrack],
      ["screen", media.screenTrack],
      ["screenAudio", media.screenAudioTrack],
    ];
    for (const [slot, track] of localTracks) {
      if (track) await call.setLocalTrack(slot, track);
    }
    for (const [slot, profile] of chosenProfiles) {
      await call.setTrackProfile(slot, scaleProfile(profile, adaptive.current()));
    }

    if (engine !== call) return;

    // Só agora: com as trilhas anexadas, a primeira oferta já sai completa.
    syncRemote();

    startDetector();
    startStats();
    playCue("join");

    publishVoiceState({
      muted: micSilent(),
      deafened: get().deafened,
      camOn: get().camOn,
      screenOn: get().screenOn,
    });
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
    history: snapshot.history ?? {},
    loadingHistory: null,
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
        const fresh = get().status !== "ready";
        const reply = await identify(s, credentials.username, credentials.password, readSessionToken());
        if (!reply.ok || !reply.state || !reply.selfId) {
          set({ status: "join", joinError: describeSocketError(reply.error), reconnecting: false });
          s.disconnect();
          return;
        }

        // Guardar o token é o que faz a próxima reconexão voltar como a mesma
        // pessoa. Ele só vem quando muda; o de antes continua valendo.
        if (reply.token) writeJson(SESSION_KEY, reply.token);
        sfuAvailable = reply.sfu === true;

        set({
          status: "ready",
          selfId: reply.selfId,
          joinError: null,
          reconnecting: false,
          ...fromSnapshot(reply.state),
        });
        ensureSelection();
        // Só na entrada de verdade: reconexão de socket não é um login novo.
        if (fresh) playCue("login");

        // A identidade sobrevive à reconexão, mas as conexões de mídia não: elas
        // são refeitas do zero, e é isso que devolve imagem e som depois de uma
        // queda de rede sem a pessoa ter que sair e entrar de novo.
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

    s.on("member:state", (member) => {
      remember([member]);
      // Uma trilha nova publicada no SFU aparece como mudança de estado: é o
      // gatilho pra assinar a câmera que a pessoa acabou de ligar.
      if (sfuAvailable && member.voiceChannelId === get().voiceChannelId) syncRemote();
    });

    s.on("member:left", ({ id }) => {
      dropPeer(id);
      set((state) => {
        const members = { ...state.members };
        delete members[id];
        return { members };
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
      syncRemote();
      playCue("join");
    });

    s.on("voice:peer-left", ({ channelId, memberId }) => {
      if (get().voiceChannelId !== channelId) return;
      dropPeer(memberId);
      playCue("leave");
    });

    s.on("rtc:signal", ({ from, ...payload }) => engine?.handleSignal(from, payload));
  };

  const initialSettings = loadSettings();
  setSoundsEnabled(initialSettings.sounds);
  setSoundVolume(initialSettings.soundVolume);

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
    history: {},
    loadingHistory: null,

    activeGuildId: "",
    activeChannelId: "",
    sidebarOpen: false,

    voiceChannelId: null,
    muted: false,
    deafened: false,
    camOn: false,
    screenOn: false,
    talking: false,
    liveFacing: null,
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
    notice: null,
    ice: null,
    viaServer: false,
    qualityStep: 0,
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
        // "timeout" é o Socket.IO desistindo: serviço acordando, não recusa.
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

    async loadOlderMessages(channelId) {
      const s = socket;
      const oldest = get().messages[channelId]?.[0];
      // Sem âncora não há de onde continuar, e um segundo pedido em cima do
      // primeiro devolveria a mesma página duas vezes.
      if (!s || !oldest || !get().history[channelId] || get().loadingHistory) return;

      set({ loadingHistory: channelId });
      const reply = await loadChatHistory(s, channelId, oldest.id);
      if (!reply.ok || !reply.messages) {
        // Um erro que apaga o aviso de "há mais" faria a conversa parecer completa;
        // deixar como está permite tentar de novo ao rolar outra vez.
        set({ loadingHistory: null });
        return;
      }

      set((state) => {
        const current = state.messages[channelId] ?? [];
        // A página pedida pode ter chegado depois de a pessoa trocar de canal e
        // voltar, com o snapshot já refeito: só entra o que ainda não está aqui.
        const known = new Set(current.map((message) => message.id));
        const older = reply.messages!.filter((message) => !known.has(message.id));
        return {
          messages: { ...state.messages, [channelId]: [...older, ...current] },
          history: { ...state.history, [channelId]: reply.more === true },
          loadingHistory: null,
        };
      });
    },

    async joinVoice(channelId) {
      // Entrar parte de um clique, e é o momento certo de destravar o áudio.
      resumeAudio();
      const s = socket;
      if (!s || joining) return;
      // Canal diferente do que está no ar é entrada nova, não recuperação: as
      // tentativas gastas antes não têm nada a ver com esta call.
      if (get().voiceChannelId !== channelId) restartAttempts = 0;
      joining = true;
      try {
        await enterVoice(s, channelId);
      } finally {
        joining = false;
      }
    },

    leaveVoice() {
      detector?.stop();
      detector = null;
      engine?.close();
      engine = null;
      stopStats();
      chosenProfiles.clear();
      media.closeAll();
      socket?.emit("voice:leave");
      playCue("leave");
      restartAttempts = 0;
      set({
        voiceChannelId: null,
        camOn: false,
        screenOn: false,
        talking: false,
        liveFacing: null,
        remote: {},
        peerStates: {},
        stats: {},
        focusedTiles: [],
        watching: {},
        flipped: {},
        screenPickerOpen: false,
        viaServer: false,
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
        dropProfile("camera");
        set({ camOn: false, liveFacing: null });
        publishVoiceState({ camOn: false });
        return;
      }
      try {
        const { camera: options, cameraDeviceId, cameraFacing } = get().settings;
        const track = await media.openCamera(cameraDeviceId, options, cameraFacing);
        // Webcam desconectada no meio da call: some o tile em vez de congelar.
        track.onended = () => {
          if (get().camOn) void get().toggleCamera();
        };
        await engine?.setLocalTrack("camera", track);
        await setProfile("camera", {
          maxBitrate: cameraBitrate(options),
          degradationPreference: "maintain-framerate",
        });
        set({ camOn: true, liveFacing: media.cameraFacing });
        publishVoiceState({ camOn: true });
        // Os rótulos e ids das câmeras só existem depois da permissão concedida.
        void get().refreshDevices();
      } catch (error) {
        set({ mediaError: describeCameraError(error) });
      }
    },

    /**
     * Frontal ↔ traseira. O celular diz qual lente está na trilha, e aí basta
     * pedir a outra; no PC ninguém informa isso, então a troca é entre os
     * dispositivos que apareceram na lista.
     */
    async switchCamera() {
      if (!get().camOn) return;
      const facing = media.cameraFacing;
      if (facing) {
        await get().applySettings({
          cameraFacing: facing === "user" ? "environment" : "user",
          cameraDeviceId: null,
        });
        return;
      }
      const devices = await media.listDevices();
      set({ devices });
      const ids = devices.cameras.map((camera) => camera.deviceId).filter(Boolean);
      if (ids.length < 2) return;
      // O id que a trilha informa nem sempre está na lista; aí vale o escolhido antes.
      const current = [media.cameraDeviceId, get().settings.cameraDeviceId].find(
        (id) => id && ids.includes(id),
      );
      await get().applySettings({ cameraDeviceId: ids[(ids.indexOf(current ?? "") + 1) % ids.length] });
    },

    async toggleScreen() {
      if (!get().voiceChannelId) return;
      if (get().screenOn) {
        media.closeScreen();
        await engine?.setLocalTrack("screen", null);
        await engine?.setLocalTrack("screenAudio", null);
        dropProfile("screen");
        set({ screenOn: false });
        publishVoiceState({ screenOn: false });
        return;
      }
      if (!screenShareSupported()) {
        set({
          mediaError:
            "Compartilhar tela só funciona no computador. Nenhum navegador de celular deixa uma página capturar a tela: nem o Chrome no Android, nem o Safari no iPhone.",
        });
        return;
      }
      // Abre o painel de qualidade; quem captura é o botão dele. Assim a
      // resolução escolhida vale desde o primeiro quadro.
      set({ screenPickerOpen: true });
    },

    async startScreen(options, sourceId = null) {
      if (!get().voiceChannelId) return;
      set({ screenPickerOpen: false, screenOptions: options });
      writeJson(SCREEN_KEY, options);

      try {
        const { video, audio, systemAudioFailed } = await media.openScreen(options, sourceId);
        // O "Parar de compartilhar" do navegador termina a trilha: sem escutar
        // isso, os outros ficariam vendo o último quadro pra sempre.
        video.onended = () => {
          if (get().screenOn) void get().toggleScreen();
        };
        await engine?.setLocalTrack("screen", video);
        await engine?.setLocalTrack("screenAudio", audio);
        await setProfile("screen", {
          maxBitrate: screenBitrate(options),
          degradationPreference: screenDegradation(options.content),
        });
        set({
          screenOn: true,
          notice: systemAudioFailed
            ? "Não foi possível capturar o áudio do sistema. A transmissão foi iniciada sem áudio."
            : null,
        });
        publishVoiceState({ screenOn: true });
      } catch (error) {
        if (!userCancelled(error)) set({ mediaError: describeScreenShareError(error) });
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
        await setProfile("screen", {
          maxBitrate: screenBitrate(options),
          degradationPreference: screenDegradation(options.content),
        });
      } catch (error) {
        set({ mediaError: describeScreenShareError(error) });
      }
    },

    setPersonVolume(username, volume) {
      updatePerson(username, { volume: Math.min(MAX_PERSON_VOLUME, Math.max(0, volume)) });
    },

    togglePersonMuted(username) {
      const current = get().people[personKey(username)];
      updatePerson(username, { muted: !current?.muted });
    },

    setScreenVolume(username, volume) {
      updatePerson(username, { screenVolume: Math.min(MAX_PERSON_VOLUME, Math.max(0, volume)) });
    },

    toggleScreenMuted(username) {
      const current = get().people[personKey(username)];
      updatePerson(username, { screenMuted: !current?.screenMuted });
    },

    resetPerson(username) {
      updatePerson(username, DEFAULT_PREFS);
    },

    async applySettings(patch) {
      const settings = { ...get().settings, ...patch };
      set({ settings });
      writeJson(SETTINGS_KEY, settings);

      if (patch.sounds !== undefined) setSoundsEnabled(settings.sounds);
      if (patch.soundVolume !== undefined) setSoundVolume(settings.soundVolume);
      if (patch.pushToTalk !== undefined) {
        set({ talking: false });
        applyMicEnabled();
        publishVoiceState({ muted: micSilent() });
      }

      // A força da supressão é uma mensagem pro filtro que já está no ar; só o
      // resto do processamento obriga a reabrir o dispositivo. A trilha nova entra
      // por `replaceTrack`, sem renegociar nem cortar o áudio.
      const tuned = patch.denoiseStrength !== undefined && media.tuneDenoise(settings.denoiseStrength);
      const audioChanged =
        patch.micDeviceId !== undefined ||
        patch.echoCancellation !== undefined ||
        patch.denoise !== undefined ||
        patch.autoGainControl !== undefined ||
        (patch.denoiseStrength !== undefined && !tuned);

      if (audioChanged && get().voiceChannelId) {
        try {
          const track = await media.openMic(settings);
          track.enabled = !micSilent();
          await engine?.setLocalTrack("mic", track);
          startDetector();
        } catch (error) {
          set({ mediaError: describeMicrophoneError(error) });
        }
      }

      // Trocar de lente ou de dispositivo obriga a reabrir; só resolução e fps
      // cabem na trilha que já está no ar.
      const lensChanged = patch.cameraDeviceId !== undefined || patch.cameraFacing !== undefined;

      if (patch.camera !== undefined && !lensChanged && get().camOn) {
        // Só resolução/fps: ajusta a trilha viva, sem piscar a imagem.
        try {
          await media.applyCameraOptions(settings.camera);
          await setProfile("camera", {
            maxBitrate: cameraBitrate(settings.camera),
            degradationPreference: "maintain-framerate",
          });
        } catch (error) {
          set({ mediaError: describeCameraError(error) });
        }
        return;
      }

      if (lensChanged && get().camOn) {
        try {
          const track = await media.openCamera(
            settings.cameraDeviceId,
            settings.camera,
            settings.cameraFacing,
          );
          track.onended = () => {
            if (get().camOn) void get().toggleCamera();
          };
          await engine?.setLocalTrack("camera", track);
          await setProfile("camera", {
            maxBitrate: cameraBitrate(settings.camera),
            degradationPreference: "maintain-framerate",
          });
          set({ liveFacing: media.cameraFacing });
        } catch (error) {
          set({ mediaError: describeCameraError(error) });
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

    dismissNotice() {
      set({ notice: null });
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
  return people[personKey(username)] ?? DEFAULT_PREFS;
}
