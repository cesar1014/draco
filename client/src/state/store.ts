import { create } from "zustand";
import {
  confirmLoginAddress as confirmLoginAddressRequest,
  completePasswordReset,
  describeAuthError,
  loginAccount,
  logoutAccount,
  registerAccount,
  requestOwnPasswordChange,
  requestPasswordReset,
  resumeAccountSession,
  verifyAccountEmail,
} from "@/auth";
import {
  DEFAULT_AUDIO_SETTINGS,
  DEFAULT_CAMERA_OPTIONS,
  DEFAULT_SCREEN_OPTIONS,
  MediaManager,
  cameraBitrate,
  describeCameraError,
  describeMicrophoneError,
  describeScreenShareError,
  describeSystemAudioFailure,
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
import { loadIceConfig, setIceConfigProvider } from "@/rtc/iceConfig";
import { forgetStats, type PeerStats } from "@/rtc/stats";
import { playCue, setSoundVolume, setSoundsEnabled } from "@/rtc/sounds";
import { isDesktopApp, showDesktopNotification } from "@/desktop";
import {
  acceptInvite,
  banMember,
  createChannel,
  createGuild,
  createInvite,
  createRole as createGuildRole,
  createSocket,
  deleteChannel,
  deleteGuild as deleteGuildRequest,
  describeSocketError,
  identify,
  identifyGuest,
  joinVoiceChannel,
  leaveGuild,
  loadChatHistory,
  loadGuildAdmin,
  loadDirect,
  openDirect,
  requestIceConfig,
  requestFriend,
  changeFriendship,
  updatePresence as updatePresenceRequest,
  markRead,
  mutateMessage,
  kickMember as kickGuildMember,
  timeoutMember as timeoutGuildMember,
  removeMemberTimeout,
  loadChannelPermissions as loadChannelPermissionsRequest,
  saveChannelPermissions as saveChannelPermissionsRequest,
  reorderChannels as reorderGuildChannels,
  reorderRoles as reorderGuildRoles,
  revokeInvite,
  sendDirect,
  sendChannel,
  setScreenWatching,
  sfuJoin,
  sfuPublish,
  sfuRenegotiate,
  sfuSubscribe,
  unbanMember,
  updateRole as updateGuildRole,
  deleteRole as deleteGuildRole,
  assignRole as assignGuildRole,
  type AppSocket,
  type VoiceFlags,
} from "@/socket";
import {
  SLOT_ORDER,
  type BanEntry,
  type Account,
  type Channel,
  type Guild,
  type GuildPermission,
  type IceConfigResponse,
  type Invite,
  type MediaSlot,
  type Member,
  type Message,
  type DirectMessage,
  type DirectThread,
  type RosterEntry,
  type ServerSnapshot,
  type Role,
  type Relationships,
  type PresenceMode,
  type DracoNotification,
  type UnreadState,
  type TimeoutEntry,
  type AuditEntry,
  type ChannelOverwrite,
  type SfuHealth,
  type ScreenViewer,
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
let identity:
  | { token: string | null; guest?: never }
  | { token?: never; guest: { username: string; inviteCode: string; age: number; token?: string } } = {
  token: null,
};
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
let restartTimer: ReturnType<typeof setTimeout> | null = null;
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
// Reagir em um segundo impede a fila de envio de crescer por vários segundos
// antes de a adaptação reduzir o teto.
const STATS_INTERVAL_MS = 1000;
/** Espaço entre duas tentativas de refazer a call por queda de mídia. */
const RESTART_COOLDOWN_MS = 5000;
/** Depois disto a call não volta sozinha: insistir só esconde o problema real. */
const MAX_RESTARTS = 3;

const EMPTY_RELATIONSHIPS: Relationships = {
  friends: [], incomingRequests: [], outgoingRequests: [], blocked: [],
};

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
function clearSessionToken(): void {
  try {
    localStorage.removeItem(SESSION_KEY);
  } catch {
    // Sessão em memória continua podendo ser encerrada mesmo sem armazenamento.
  }
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
  account: Account | null;
  joinError: string | null;
  reconnecting: boolean;
  emailReady: boolean;
  turnstileSiteKey: string | null;

  // --- servidor -----------------------------------------------------------
  guilds: Guild[];
  channels: Channel[];
  members: Record<string, Member>;
  /**
   * Por servidor: quem pertence a ele, conectado ou não. Vem do banco, enquanto
   * `members` é presença. Ter os dois é o que permite listar quem está offline
   * sem inventar estado de call pra quem nem está aqui.
   */
  roster: Record<string, RosterEntry[]>;
  messages: Record<string, Message[]>;
  permissions: Record<string, GuildPermission[]>;
  roles: Record<string, Role[]>;
  memberRoles: Record<string, Record<string, string[]>>;
  directThreads: DirectThread[];
  directMessages: Record<string, DirectMessage[]>;
  activeDirectId: string;
  replyingTo: Message | null;
  relationships: Relationships;
  unread: Record<string, UnreadState>;
  notifications: DracoNotification[];
  channelOverwrites: Record<string, ChannelOverwrite[]>;
  sfuHealth: SfuHealth | null;
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
  /**
   * Painel de membros da direita. Fechado por padrão: canais e conversa ganham a
   * largura, e quem quer ver quem está por aqui abre pelo contador do topo.
   */
  membersOpen: boolean;
  /** Painel de administração do servidor, quando aberto. */
  admin: AdminState | null;

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
  screenViewers: Record<string, ScreenViewer[]>;
  /** Espelhamento manual por tile, aplicado sobre o padrão. */
  flipped: Record<string, boolean>;

  // --- dispositivos e diagnóstico -----------------------------------------
  settings: Settings;
  devices: DeviceList;
  mediaError: string | null;
  mediaRecovery: "idle" | "reconnecting" | "failed";
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
  connect: (email: string, password: string, botToken?: string | null) => Promise<void>;
  connectGuest: (username: string, inviteCode: string, age: number) => Promise<void>;
  register: (
    email: string,
    username: string,
    age: number,
    password: string,
    passwordConfirmation: string,
    botToken?: string | null,
  ) => Promise<string | null>;
  verifyEmail: (token: string) => Promise<string | null>;
  confirmLoginAddress: (token: string) => Promise<string | null>;
  requestPassword: (email: string, botToken?: string | null) => Promise<string | null>;
  completePassword: (token: string, password: string) => Promise<string | null>;
  requestOwnPassword: () => Promise<string | null>;
  logout: () => void;
  selectGuild: (guildId: string) => void;
  selectChannel: (channelId: string) => void;
  setSidebarOpen: (open: boolean) => void;
  setMembersOpen: (open: boolean) => void;
  sendChat: (content: string) => Promise<Message | null>;
  openDirect: (userId: string) => Promise<string | null>;
  selectDirect: (threadId: string) => Promise<void>;
  sendDirect: (content: string) => Promise<DirectMessage | null>;
  setReplyingTo: (message: Message | null) => void;
  editMessage: (scope: "chat" | "direct", messageId: string, content: string) => Promise<string | null>;
  deleteMessage: (scope: "chat" | "direct", messageId: string) => Promise<string | null>;
  reactMessage: (scope: "chat" | "direct", messageId: string, emoji: string) => Promise<string | null>;
  requestFriend: (username: string) => Promise<string | null>;
  changeFriendship: (
    action: "accept" | "reject" | "cancel" | "remove" | "block" | "unblock",
    userId: string,
  ) => Promise<string | null>;
  updatePresence: (mode: PresenceMode, status: string | null, expiresAt?: number | null) => Promise<string | null>;
  loadOlderMessages: (channelId: string) => Promise<void>;
  joinVoice: (channelId: string) => Promise<void>;
  retryMedia: () => void;
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

  // --- administração ------------------------------------------------------
  createGuild: (name: string) => Promise<string | null>;
  deleteGuild: (guildId: string) => Promise<string | null>;
  leaveGuild: (guildId: string) => Promise<string | null>;
  joinByInvite: (code: string) => Promise<string | null>;
  createChannel: (guildId: string, type: "text" | "voice", name: string) => Promise<string | null>;
  deleteChannel: (channelId: string) => Promise<string | null>;
  reorderChannels: (guildId: string, orderedIds: string[]) => Promise<string | null>;
  openAdmin: (guildId: string) => Promise<void>;
  closeAdmin: () => void;
  createInvite: (options?: { maxUses?: number | null; expiresInHours?: number | null }) => Promise<string | null>;
  revokeInvite: (code: string) => Promise<void>;
  banMember: (userId: string, reason?: string) => Promise<string | null>;
  unbanMember: (userId: string) => Promise<void>;
  kickMember: (userId: string, reason?: string) => Promise<string | null>;
  timeoutMember: (userId: string, durationMs: number, reason?: string) => Promise<string | null>;
  removeTimeout: (userId: string) => Promise<string | null>;
  loadChannelPermissions: (channelId: string) => Promise<void>;
  saveChannelPermissions: (channelId: string, targetType: "role" | "member", targetId: string, allow: GuildPermission[], deny: GuildPermission[]) => Promise<string | null>;
  createRole: (name: string, color: string | null, permissions: GuildPermission[]) => Promise<string | null>;
  updateRole: (roleId: string, name: string, color: string | null, permissions: GuildPermission[]) => Promise<string | null>;
  deleteRole: (roleId: string) => Promise<string | null>;
  assignRole: (userId: string, roleId: string, assigned: boolean) => Promise<string | null>;
  reorderRoles: (orderedIds: string[]) => Promise<string | null>;
}

/**
 * Painel de administração do servidor. Vive no estado porque é um pedido só ao
 * servidor: elenco, convites e banimentos chegam juntos, e recarregar cada parte
 * em separado renderia três idas ao banco pra abrir uma tela.
 */
export interface AdminState {
  guildId: string;
  /** Dono ou cargos autorizados recebem as seções administrativas correspondentes. */
  owner: boolean;
  roster: RosterEntry[];
  invites: Invite[];
  bans: BanEntry[];
  timeouts: TimeoutEntry[];
  auditLog: AuditEntry[];
  permissions: GuildPermission[];
  roles: Role[];
  memberRoles: Record<string, string[]>;
  availablePermissions: GuildPermission[];
  /** Uma ação por vez: dois cliques no mesmo botão criariam dois convites. */
  busy: boolean;
  error: string | null;
  /** Código recém-criado, pro botão de copiar aparecer em destaque. */
  lastCode: string | null;
}

/** Nível atual do próprio microfone (0 a 1), pro medidor das configurações. */
export const micLevel = () => detector?.level ?? 0;
const trackEnded = (track: MediaStreamTrack) => track.readyState === "ended";

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
        if (slot === "camera" && !member.camOn) continue;
        if ((slot === "screen" || slot === "screenAudio") && !member.screenOn) continue;
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
      if (!state.remote[memberId] && !state.peerStates[memberId] && !state.stats[memberId] && !state.screenViewers[memberId]) {
        return state;
      }
      const remote = { ...state.remote };
      const peerStates = { ...state.peerStates };
      const stats = { ...state.stats };
      const screenViewers = { ...state.screenViewers };
      delete remote[memberId];
      // O estado da conexão de quem saiu ficaria pendurado em `disconnected`, e a
      // barra de voz leria isso como a call inteira com problema.
      delete peerStates[memberId];
      delete stats[memberId];
      delete screenViewers[memberId];
      return { remote, peerStates, stats, screenViewers };
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
    if (slot === "screen" && peerId !== get().selfId) {
      const watching = live && get().watching[`${peerId}:screen`] === true;
      if (socket) void setScreenWatching(socket, peerId, watching);
    }
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
      if (!reply.ok) {
        if (reply.error === "no-tracks") return null;
        const reason = reply.error === "stale-session" || reply.error === "no-session"
          ? "a sessão de recepção do SFU expirou"
          : "o servidor de mídia recusou a assinatura";
        throw new Error(reason);
      }
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
    if (get().voiceChannelId !== channelId) return;
    if (joining) {
      restartTimer ??= setTimeout(() => {
        restartTimer = null;
        restartCall(channelId, reason);
      }, 250);
      return;
    }
    const now = Date.now();
    if (now - lastRestart < RESTART_COOLDOWN_MS) {
      restartTimer ??= setTimeout(() => {
        restartTimer = null;
        restartCall(channelId, reason);
      }, RESTART_COOLDOWN_MS - (now - lastRestart));
      return;
    }
    lastRestart = now;

    if (restartAttempts >= MAX_RESTARTS) {
      set({
        notice: null,
        mediaRecovery: "failed",
        mediaError: `A conexão de mídia não se restabeleceu (${reason}). Saia e entre no canal de voz de novo.`,
      });
      return;
    }
    restartAttempts += 1;
    // A configuração guardada pode ser justamente o problema: credencial de TURN
    // revogada ou vencida derruba o ICE, e insistir na mesma repetiria a falha.
    refreshIce = true;
    set({ mediaRecovery: "reconnecting", notice: `A conexão de mídia caiu (${reason}). Reconectando…` });
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
    set({ remote: {}, peerStates: {}, stats: {}, screenViewers: {} });

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
    if (reply.sfuHealth) set({ sfuHealth: reply.sfuHealth });

    remember(reply.peers);
    set({
      voiceChannelId: channelId,
      activeChannelId: channelId,
      sidebarOpen: false,
      viaServer: sfuAvailable,
      screenViewers: reply.screenViewers ?? {},
    });

    const call: CallEngine = sfuAvailable
      ? new SfuEngine({
          configuration,
          transport: sfuTransport(s),
          onRemoteTrack,
          onConnectionState: (role, connectionState) => {
            // Conectou: o que veio antes está resolvido, e a próxima queda merece
            // as tentativas de novo em vez de esbarrar num limite antigo.
            if (connectionState === "connected") {
              restartAttempts = 0;
              set({ mediaRecovery: "idle", notice: null });
            }
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
            if (connectionState === "connected") {
              restartAttempts = 0;
              set({ mediaRecovery: "idle", notice: null });
            }
            if (connectionState === "failed") {
              if (get().watching[`${peerId}:screen`]) void setScreenWatching(s, peerId, false);
              restartCall(channelId, `conexão com ${get().members[peerId]?.username ?? "participante"} caiu`);
            }
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
    roster: snapshot.roster ?? {},
    messages: snapshot.messages,
    history: snapshot.history ?? {},
    permissions: snapshot.permissions ?? {},
    roles: snapshot.roles ?? {},
    memberRoles: snapshot.memberRoles ?? {},
    directThreads: snapshot.directThreads ?? [],
    directMessages: snapshot.directMessages ?? {},
    relationships: snapshot.relationships ?? EMPTY_RELATIONSHIPS,
    unread: snapshot.unread ?? {},
    notifications: snapshot.notifications ?? [],
    sfuHealth: snapshot.sfuHealth ?? null,
    loadingHistory: null,
  });

  /**
   * Garante que a seleção aponte pra algo que existe. Numa reconexão o canal já
   * está escolhido e a pessoa continua onde estava; depois de sair de um servidor
   * ou de ter um canal apagado, a seleção antiga aponta pro vazio, e aí cai no
   * primeiro canal de texto disponível.
   */
  const ensureSelection = () => {
    const { guilds, channels, activeGuildId, activeChannelId } = get();
    const guild = guilds.find((item) => item.id === activeGuildId) ?? guilds[0];
    if (!guild) {
      set({ activeGuildId: "", activeChannelId: "" });
      return;
    }

    const current = channels.find((c) => c.id === activeChannelId && c.guildId === guild.id);
    if (current && guild.id === activeGuildId) return;

    const first = channels.find((c) => c.guildId === guild.id && c.type === "text");
    set({ activeGuildId: guild.id, activeChannelId: first?.id ?? "" });
  };

  const wire = (s: AppSocket) => {
    s.on("connect", () => {
      void (async () => {
        const fresh = get().status !== "ready";
        const reply = identity.guest
          ? await identifyGuest(
              s,
              identity.guest.username,
              identity.guest.inviteCode,
              identity.guest.age,
              identity.guest.token,
            )
          : await identify(s, null);
        if (!reply.ok || !reply.state || !reply.selfId) {
          set({ status: "join", joinError: describeSocketError(reply.error), reconnecting: false });
          s.disconnect();
          return;
        }

        if (reply.guestToken && identity.guest) {
          identity = { guest: { ...identity.guest, token: reply.guestToken } };
        }
        sfuAvailable = reply.sfu === true;
        setIceConfigProvider((refresh) => requestIceConfig(s, refresh));

        set({
          status: "ready",
          selfId: reply.selfId,
          account: reply.account ?? null,
          joinError: null,
          reconnecting: false,
          ...fromSnapshot(reply.state),
        });
        // O primeiro login chega no Início. Numa reconexão, preserva e valida o
        // servidor/canal em que a pessoa já estava.
        if (!fresh) ensureSelection();
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
      const selfId = get().selfId;
      if (message.authorId !== selfId && get().activeChannelId !== message.channelId) {
        set((state) => ({
          unread: {
            ...state.unread,
            [`channel:${message.channelId}`]: {
              ...(state.unread[`channel:${message.channelId}`] ?? { mentions: 0, lastReadSequence: 0 }),
              unread: true,
            },
          },
        }));
      } else if (get().activeChannelId === message.channelId) {
        void markRead(s, "channel", message.channelId, message.sequence);
      }
    });

    s.on("chat:updated", (message) => {
      set((state) => ({
        messages: {
          ...state.messages,
          [message.channelId]: (state.messages[message.channelId] ?? []).map((item) => item.id === message.id ? message : item),
        },
      }));
    });

    s.on("direct:thread", (thread) => {
      set((state) => ({
        directThreads: [thread, ...state.directThreads.filter((item) => item.id !== thread.id)],
      }));
    });

    s.on("direct:message", (message) => {
      set((state) => {
        const current = state.directMessages[message.threadId] ?? [];
        const thread = state.directThreads.find((item) => item.id === message.threadId);
        return {
          directMessages: current.some((item) => item.id === message.id)
            ? state.directMessages
            : { ...state.directMessages, [message.threadId]: [...current, message] },
          directThreads: thread
            ? [
                { ...thread, lastContent: message.content, lastAt: message.at },
                ...state.directThreads.filter((item) => item.id !== message.threadId),
              ]
            : state.directThreads,
        };
      });
      const selfId = get().selfId;
      if (message.authorId !== selfId && get().activeDirectId !== message.threadId) {
        set((state) => ({
          unread: {
            ...state.unread,
            [`direct:${message.threadId}`]: {
              ...(state.unread[`direct:${message.threadId}`] ?? { mentions: 0, lastReadSequence: 0 }),
              unread: true,
            },
          },
        }));
      } else if (get().activeDirectId === message.threadId) {
        void markRead(s, "direct", message.threadId, message.sequence);
      }
    });

    s.on("direct:updated", (message) => {
      set((state) => ({
        directMessages: {
          ...state.directMessages,
          [message.threadId]: (state.directMessages[message.threadId] ?? []).map((item) => item.id === message.id ? message : item),
        },
      }));
    });

    s.on("relationship:update", (relationships) => set({ relationships }));
    s.on("notification:new", (notification) => {
      set((state) => ({ notifications: [notification, ...state.notifications].slice(0, 100) }));
      if (document.visibilityState === "visible" || get().members[get().selfId ?? ""]?.presence === "dnd") return;
      const title = notification.kind === "friend_request" ? "Nova solicitação de amizade" : "Nova notificação";
      const body = String(notification.metadata.username ?? "Draco");
      if (isDesktopApp()) {
        void showDesktopNotification({ title, body, conversationType: notification.conversationType, conversationId: notification.conversationId });
        return;
      }
      if ("Notification" in window && Notification.permission === "granted") {
        new Notification(title, { body });
      }
    });
    s.on("sfu:health", (sfuHealth) => {
      set({ sfuHealth, notice: sfuHealth.status === "UNAVAILABLE" ? "O servidor de mídia está indisponível. A chamada tentará se recuperar sem trocar o modo dos participantes." : null });
    });
    s.on("screen:viewers", ({ channelId, ownerId, viewers }) => {
      if (get().voiceChannelId !== channelId) return;
      set((state) => ({ screenViewers: { ...state.screenViewers, [ownerId]: viewers } }));
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

    // --- catálogo e associação ---------------------------------------------

    s.on("channel:created", ({ channel }) => {
      set((state) =>
        state.channels.some((item) => item.id === channel.id)
          ? state
          : { channels: [...state.channels, channel] },
      );
    });

    s.on("channel:deleted", ({ channelId }) => {
      set((state) => {
        const messages = { ...state.messages };
        const history = { ...state.history };
        delete messages[channelId];
        delete history[channelId];
        return {
          channels: state.channels.filter((channel) => channel.id !== channelId),
          messages,
          history,
        };
      });
      ensureSelection();
    });

    /** O canal em que a pessoa estava foi apagado: sair é o único caminho. */
    s.on("voice:channel-closed", ({ channelId }) => {
      if (get().voiceChannelId !== channelId) return;
      get().leaveVoice();
      set({ notice: "O canal de voz em que você estava foi apagado." });
    });

    s.on("voice:moderated", ({ channelId, reason }) => {
      if (get().voiceChannelId !== channelId) return;
      get().leaveVoice();
      set({
        notice: reason === "ban"
          ? "Você foi removido da chamada após um banimento."
          : reason === "kick"
            ? "Você foi removido da chamada após ser expulso do servidor."
            : "Você foi removido da chamada durante uma restrição temporária.",
      });
    });

    s.on("guild:member-joined", ({ guildId, member }) => {
      set((state) => {
        const current = state.roster[guildId] ?? [];
        if (current.some((entry) => entry.id === member.id)) return state;
        return { roster: { ...state.roster, [guildId]: [...current, member] } };
      });
    });

    s.on("guild:member-left", ({ guildId, userId }) => {
      set((state) => ({
        roster: {
          ...state.roster,
          [guildId]: (state.roster[guildId] ?? []).filter((entry) => entry.id !== userId),
        },
      }));
      // O painel de administração aberto mostra o elenco; sem isto ele exibiria
      // alguém que acabou de sair até a pessoa reabrir a tela.
      set((state) =>
        state.admin?.guildId === guildId
          ? {
              admin: {
                ...state.admin,
                roster: state.admin.roster.filter((entry) => entry.id !== userId),
              },
            }
          : state,
      );
    });

    s.on("channels:reordered", ({ guildId, channels }) => {
      set((state) => ({
        channels: [...state.channels.filter((channel) => channel.guildId !== guildId), ...channels]
          .sort((left, right) => left.position - right.position),
      }));
    });

    s.on("role:changed", ({ guildId, roles, memberRoles }) => {
      set((state) => ({
        roles: { ...state.roles, [guildId]: roles },
        memberRoles: { ...state.memberRoles, [guildId]: memberRoles },
      }));
      if (get().admin?.guildId === guildId) void get().openAdmin(guildId);
    });

    /** Banido: o servidor sai da lista, com aviso, em vez de sumir sem explicação. */
    s.on("guild:banned", ({ guildId }) => {
      const guild = get().guilds.find((item) => item.id === guildId);
      const channelIds = new Set(
        get().channels.filter((channel) => channel.guildId === guildId).map((channel) => channel.id),
      );
      if (channelIds.has(get().voiceChannelId ?? "")) get().leaveVoice();

      set((state) => {
        const roster = { ...state.roster };
        delete roster[guildId];
        return {
          guilds: state.guilds.filter((item) => item.id !== guildId),
          channels: state.channels.filter((channel) => channel.guildId !== guildId),
          roster,
          admin: state.admin?.guildId === guildId ? null : state.admin,
          notice: `Você não faz mais parte de ${guild?.name ?? "um servidor"}.`,
        };
      });
      ensureSelection();
    });

    s.on("guild:kicked", ({ guildId }) => {
      const guild = get().guilds.find((item) => item.id === guildId);
      const channelIds = new Set(get().channels.filter((channel) => channel.guildId === guildId).map((channel) => channel.id));
      if (channelIds.has(get().voiceChannelId ?? "")) get().leaveVoice();
      set((state) => {
        const roster = { ...state.roster };
        delete roster[guildId];
        return {
          guilds: state.guilds.filter((item) => item.id !== guildId),
          channels: state.channels.filter((channel) => channel.guildId !== guildId),
          roster,
          admin: state.admin?.guildId === guildId ? null : state.admin,
          notice: `Você foi removido de ${guild?.name ?? "um servidor"}.`,
        };
      });
      ensureSelection();
    });

    s.on("guild:deleted", ({ guildId, name }) => {
      const channelIds = new Set(
        get().channels.filter((channel) => channel.guildId === guildId).map((channel) => channel.id),
      );
      if (channelIds.has(get().voiceChannelId ?? "")) get().leaveVoice();

      set((state) => {
        const roster = { ...state.roster };
        const roles = { ...state.roles };
        const memberRoles = { ...state.memberRoles };
        const permissions = { ...state.permissions };
        const messages = { ...state.messages };
        const history = { ...state.history };
        delete roster[guildId];
        delete roles[guildId];
        delete memberRoles[guildId];
        delete permissions[guildId];
        for (const channelId of channelIds) {
          delete messages[channelId];
          delete history[channelId];
        }
        return {
          guilds: state.guilds.filter((guild) => guild.id !== guildId),
          channels: state.channels.filter((channel) => channel.guildId !== guildId),
          roster,
          roles,
          memberRoles,
          permissions,
          messages,
          history,
          admin: state.admin?.guildId === guildId ? null : state.admin,
          notice: `${name || "O servidor"} foi excluído permanentemente.`,
        };
      });
      ensureSelection();
    });
  };

  const startConnection = async () => {
    lastConnectError = null;
    set({ status: "connecting", joinError: null });
    if (!socket) {
      socket = createSocket();
      wire(socket);
    }
    socket.connect();

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
      const failure =
        !lastConnectError || lastConnectError === "timeout"
          ? describeSocketError("timeout")
          : `Conexão recusada pelo servidor: ${lastConnectError}`;
      set({ status: "join", joinError: get().joinError ?? failure });
      return;
    }
    void loadIceConfig().then((ice) => set({ ice }));
    void get().refreshDevices();
  };

  const initialSettings = loadSettings();
  setSoundsEnabled(initialSettings.sounds);
  setSoundVolume(initialSettings.soundVolume);

  return {
    status: "join",
    selfId: null,
    account: null,
    joinError: null,
    reconnecting: false,
    emailReady: false,
    turnstileSiteKey: null,

    guilds: [],
    channels: [],
    members: {},
    roster: {},
    messages: {},
    permissions: {},
    roles: {},
    memberRoles: {},
    directThreads: [],
    directMessages: {},
    relationships: EMPTY_RELATIONSHIPS,
    unread: {},
    notifications: [],
    channelOverwrites: {},
    sfuHealth: null,
    activeDirectId: "",
    replyingTo: null,
    history: {},
    loadingHistory: null,

    activeGuildId: "",
    activeChannelId: "",
    sidebarOpen: false,
    membersOpen: false,
    admin: null,

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
    screenViewers: {},
    flipped: {},

    settings: initialSettings,
    devices: { mics: [], cameras: [], speakers: [] },
    mediaError: null,
    mediaRecovery: "idle",
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
        const config = (await response.json()) as { emailReady?: boolean; turnstileSiteKey?: string | null };
        set({
          emailReady: config.emailReady === true,
          turnstileSiteKey: typeof config.turnstileSiteKey === "string" ? config.turnstileSiteKey : null,
        });
      } catch {
        set({ emailReady: false, turnstileSiteKey: null });
      }
      if (get().status === "join" && await resumeAccountSession()) {
        identity = { token: null };
        await startConnection();
      }
    },

    async connect(email, password, botToken = null) {
      set({ status: "connecting", joinError: null });
      const reply = await loginAccount(email.trim(), password, botToken);
      if (!reply.ok) {
        set({ status: "join", joinError: describeAuthError(reply.error) });
        return;
      }
      clearSessionToken();
      identity = { token: null };
      await startConnection();
    },

    async connectGuest(username, inviteCode, age) {
      clearSessionToken();
      identity = {
        guest: { username: username.trim(), inviteCode: inviteCode.trim().toUpperCase(), age },
      };
      await startConnection();
    },

    async register(email, username, age, password, passwordConfirmation, botToken = null) {
      const reply = await registerAccount(email, username, age, password, passwordConfirmation, botToken);
      return reply.ok ? null : describeAuthError(reply.error);
    },

    async verifyEmail(token) {
      const reply = await verifyAccountEmail(token);
      return reply.ok ? null : describeAuthError(reply.error);
    },

    async confirmLoginAddress(token) {
      const reply = await confirmLoginAddressRequest(token);
      return reply.ok ? null : describeAuthError(reply.error);
    },

    async requestPassword(email, botToken = null) {
      const reply = await requestPasswordReset(email, botToken);
      return reply.ok ? null : describeAuthError(reply.error);
    },

    async completePassword(token, password) {
      const reply = await completePasswordReset(token, password);
      if (!reply.ok) return describeAuthError(reply.error);
      clearSessionToken();
      identity = { token: null };
      await startConnection();
      return get().status === "ready" ? null : get().joinError;
    },

    async requestOwnPassword() {
      const reply = await requestOwnPasswordChange();
      return reply.ok ? null : describeAuthError(reply.error);
    },

    logout() {
      void logoutAccount();
      get().leaveVoice();
      socket?.disconnect();
      socket = null;
      setIceConfigProvider(null);
      clearSessionToken();
      identity = { token: null };
      set({
        status: "join",
        selfId: null,
        account: null,
        guilds: [],
        channels: [],
        members: {},
        roster: {},
        messages: {},
        permissions: {},
        directThreads: [],
        directMessages: {},
        relationships: EMPTY_RELATIONSHIPS,
        unread: {},
        notifications: [],
        channelOverwrites: {},
        sfuHealth: null,
        activeDirectId: "",
        replyingTo: null,
        activeGuildId: "",
        activeChannelId: "",
      });
    },

    selectGuild(guildId) {
      const first = get().channels.find((c) => c.guildId === guildId && c.type === "text");
      set({ activeGuildId: guildId, activeChannelId: first?.id ?? "", activeDirectId: "" });
    },

    selectChannel(channelId) {
      set({ activeChannelId: channelId, activeDirectId: "", sidebarOpen: false });
      const messages = get().messages[channelId] ?? [];
      const latest = messages[messages.length - 1];
      if (latest && socket) {
        void markRead(socket, "channel", channelId, latest.sequence);
        set((state) => ({ unread: { ...state.unread, [`channel:${channelId}`]: { unread: false, mentions: 0, lastReadSequence: state.unread[`channel:${channelId}`]?.lastReadSequence ?? 0 } } }));
      }
    },

    setSidebarOpen(open) {
      set({ sidebarOpen: open });
    },

    setMembersOpen(open) {
      set({ membersOpen: open });
    },

    async sendChat(content) {
      const channelId = get().activeChannelId;
      const trimmed = content.trim();
      if (!socket || !trimmed || !channelId) return null;
      const response = await sendChannel(socket, channelId, trimmed, get().replyingTo?.id ?? null);
      if (response.ok) set({ replyingTo: null });
      return response.ok && response.message && "channelId" in response.message ? response.message : null;
    },

    async openDirect(userId) {
      const s = socket;
      if (!s || get().account?.guest) return "Entre na sua conta para conversar em privado.";
      const reply = await openDirect(s, userId);
      if (!reply.ok || !reply.thread) return describeSocketError(reply.error);
      set((state) => ({
        directThreads: [reply.thread!, ...state.directThreads.filter((item) => item.id !== reply.thread!.id)],
        directMessages: { ...state.directMessages, [reply.thread!.id]: reply.messages ?? [] },
        activeDirectId: reply.thread!.id,
        activeChannelId: "",
        membersOpen: false,
      }));
      return null;
    },

    async selectDirect(threadId) {
      const s = socket;
      if (!s) return;
      set({ activeDirectId: threadId, activeChannelId: "", sidebarOpen: false });
      const cached = get().directMessages[threadId];
      let loaded = cached;
      if (!cached) {
        const reply = await loadDirect(s, threadId);
        if (reply.ok) {
          loaded = reply.messages ?? [];
          set((state) => ({ directMessages: { ...state.directMessages, [threadId]: loaded! } }));
        }
      }
      const latest = (loaded ?? []).at(-1);
      if (latest) {
        void markRead(s, "direct", threadId, latest.sequence);
        set((state) => ({ unread: { ...state.unread, [`direct:${threadId}`]: { unread: false, mentions: 0, lastReadSequence: latest.sequence } } }));
      }
    },

    async sendDirect(content) {
      const threadId = get().activeDirectId;
      const trimmed = content.trim();
      if (!socket || !threadId || !trimmed) return null;
      const response = await sendDirect(socket, threadId, trimmed, get().replyingTo?.id ?? null);
      if (response.ok) set({ replyingTo: null });
      return response.ok && response.message && "threadId" in response.message ? response.message : null;
    },

    setReplyingTo(message) {
      set({ replyingTo: message });
    },

    async editMessage(scope, messageId, content) {
      if (!socket) return "Sem conexão com o servidor.";
      const reply = await mutateMessage(socket, scope, "edit", messageId, content);
      return reply.ok ? null : describeSocketError(reply.error);
    },

    async deleteMessage(scope, messageId) {
      if (!socket) return "Sem conexão com o servidor.";
      const reply = await mutateMessage(socket, scope, "delete", messageId);
      return reply.ok ? null : describeSocketError(reply.error);
    },

    async reactMessage(scope, messageId, emoji) {
      if (!socket) return "Sem conexão com o servidor.";
      const reply = await mutateMessage(socket, scope, "react", messageId, emoji);
      return reply.ok ? null : describeSocketError(reply.error);
    },

    async requestFriend(username) {
      if (!socket) return "Sem conexão com o servidor.";
      const reply = await requestFriend(socket, username.trim());
      if (!reply.ok) return describeSocketError(reply.error);
      if (reply.relationships) set({ relationships: reply.relationships });
      return null;
    },

    async changeFriendship(action, userId) {
      if (!socket) return "Sem conexão com o servidor.";
      const reply = await changeFriendship(socket, action, userId);
      if (!reply.ok) return describeSocketError(reply.error);
      if (reply.relationships) set({ relationships: reply.relationships });
      return null;
    },

    async updatePresence(mode, status, expiresAt = null) {
      if (!socket) return "Sem conexão com o servidor.";
      const reply = await updatePresenceRequest(socket, mode, status?.trim() || null, expiresAt);
      return reply.ok ? null : describeSocketError(reply.error);
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

    retryMedia() {
      const channelId = get().voiceChannelId;
      if (!channelId || joining) return;
      restartAttempts = 0;
      lastRestart = 0;
      set({ mediaRecovery: "reconnecting", mediaError: null });
      void get().joinVoice(channelId);
    },

    leaveVoice() {
      if (restartTimer) clearTimeout(restartTimer);
      restartTimer = null;
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
        screenViewers: {},
        flipped: {},
        screenPickerOpen: false,
        viaServer: false,
        mediaRecovery: "idle",
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
          if (media.cameraTrack !== track) return;
          media.closeCamera();
          void engine?.setLocalTrack("camera", null);
          dropProfile("camera");
          set({ camOn: false, liveFacing: null });
          publishVoiceState({ camOn: false });
        };
        await engine?.setLocalTrack("camera", track);
        if (trackEnded(track) || media.cameraTrack !== track) return;
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
        const { video, audio, systemAudioFailure } = await media.openScreen(options, sourceId);
        // O "Parar de compartilhar" do navegador termina a trilha: sem escutar
        // isso, os outros ficariam vendo o último quadro pra sempre.
        video.onended = () => {
          if (media.screenTrack !== video) return;
          media.closeScreen();
          void engine?.setLocalTrack("screen", null);
          void engine?.setLocalTrack("screenAudio", null);
          dropProfile("screen");
          set({ screenOn: false });
          publishVoiceState({ screenOn: false });
        };
        await engine?.setLocalTrack("screen", video);
        if (trackEnded(video) || media.screenTrack !== video) return;
        await engine?.setLocalTrack("screenAudio", audio);
        await setProfile("screen", {
          maxBitrate: screenBitrate(options),
          maxFramerate: options.frameRate,
          degradationPreference: screenDegradation(options.content),
        });
        if (trackEnded(video) || media.screenTrack !== video) return;
        set({
          screenOn: true,
          notice: systemAudioFailure ? describeSystemAudioFailure(systemAudioFailure) : null,
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
          maxFramerate: options.frameRate,
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
      const [ownerId, slot] = tile.split(":");
      if (slot === "screen" && ownerId !== get().selfId && socket) {
        const connected = get().remote[ownerId]?.live.screen === true;
        void setScreenWatching(socket, ownerId, on && connected);
      }
    },

    /**
     * Some quem saiu da call ou fechou a transmissão. Sem isso, uma tela
     * reaberta voltaria já tocando e ainda fixada de uma sessão anterior.
     */
    pruneTiles(keys) {
      const liveKeys = new Set(keys);
      for (const [key, watching] of Object.entries(get().watching)) {
        if (!watching || liveKeys.has(key) || !key.endsWith(":screen") || !socket) continue;
        void setScreenWatching(socket, key.slice(0, -":screen".length), false);
      }
      set((state) => {
        const live = liveKeys;
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

    // --- administração ------------------------------------------------------
    // Todas devolvem `null` quando dá certo e a mensagem de erro quando não. É a
    // forma que o formulário aberto precisa: ele mostra a falha ao lado do campo
    // em vez de deixar um toast global explicar o que a pessoa acabou de tentar.

    async createGuild(name) {
      const s = socket;
      if (!s) return "Sem conexão com o servidor.";
      const reply = await createGuild(s, name);
      if (!reply.ok || !reply.state || !reply.guild) return describeSocketError(reply.error);

      const guildId = reply.guild.id;
      set(fromSnapshot(reply.state));
      // Vai direto pro servidor novo: criar e continuar olhando o antigo obrigaria
      // um segundo clique pra ver o que acabou de nascer.
      const first = reply.state.channels.find((c) => c.guildId === guildId && c.type === "text");
      set({ activeGuildId: guildId, activeChannelId: first?.id ?? "", sidebarOpen: false });
      return null;
    },

    async deleteGuild(guildId) {
      const s = socket;
      const admin = get().admin;
      if (!s) return "Sem conexão com o servidor.";
      if (admin?.busy) return "Aguarde a ação atual terminar.";
      if (admin?.guildId === guildId) set({ admin: { ...admin, busy: true, error: null } });

      const reply = await deleteGuildRequest(s, guildId);
      if (!reply.ok || !reply.state) {
        const error = describeSocketError(reply.error);
        const current = get().admin;
        if (current?.guildId === guildId) set({ admin: { ...current, busy: false, error } });
        return error;
      }

      set(fromSnapshot(reply.state));
      set({ admin: null });
      ensureSelection();
      return null;
    },

    async leaveGuild(guildId) {
      const s = socket;
      if (!s) return "Sem conexão com o servidor.";
      const reply = await leaveGuild(s, guildId);
      if (!reply.ok || !reply.state) return describeSocketError(reply.error);

      set(fromSnapshot(reply.state));
      set((state) => (state.admin?.guildId === guildId ? { admin: null } : state));
      ensureSelection();
      return null;
    },

    async joinByInvite(code) {
      const s = socket;
      if (!s) return "Sem conexão com o servidor.";
      const reply = await acceptInvite(s, code);
      if (!reply.ok || !reply.state || !reply.guildId) return describeSocketError(reply.error);

      const guildId = reply.guildId;
      set(fromSnapshot(reply.state));
      const first = reply.state.channels.find((c) => c.guildId === guildId && c.type === "text");
      set({ activeGuildId: guildId, activeChannelId: first?.id ?? "", sidebarOpen: false });
      return null;
    },

    async createChannel(guildId, type, name) {
      const s = socket;
      if (!s) return "Sem conexão com o servidor.";
      const reply = await createChannel(s, guildId, type, name);
      if (!reply.ok || !reply.channel) return describeSocketError(reply.error);

      // O evento `channel:created` também chega, e os dois caminhos convergem: a
      // inserção confere se o canal já está na lista antes de adicioná-lo.
      const channel = reply.channel;
      set((state) =>
        state.channels.some((item) => item.id === channel.id)
          ? state
          : { channels: [...state.channels, channel] },
      );
      return null;
    },

    async deleteChannel(channelId) {
      const s = socket;
      if (!s) return "Sem conexão com o servidor.";
      const reply = await deleteChannel(s, channelId);
      return reply.ok ? null : describeSocketError(reply.error);
    },

    async openAdmin(guildId) {
      const s = socket;
      if (!s) return;
      set({
        admin: {
          guildId,
          owner: false,
          roster: [],
          invites: [],
          bans: [],
          timeouts: [],
          auditLog: [],
          permissions: [],
          roles: [],
          memberRoles: {},
          availablePermissions: [],
          busy: true,
          error: null,
          lastCode: null,
        },
      });

      const reply = await loadGuildAdmin(s, guildId);
      // A pessoa pode ter fechado o painel, ou trocado de servidor, na ida e volta.
      if (get().admin?.guildId !== guildId) return;
      if (!reply.ok) {
        set((state) =>
          state.admin ? { admin: { ...state.admin, busy: false, error: describeSocketError(reply.error) } } : state,
        );
        return;
      }
      set({
        admin: {
          guildId,
          owner: reply.owner === true,
          roster: reply.roster ?? [],
          invites: reply.invites ?? [],
          bans: reply.bans ?? [],
          timeouts: reply.timeouts ?? [],
          auditLog: reply.auditLog ?? [],
          permissions: reply.permissions ?? [],
          roles: reply.roles ?? [],
          memberRoles: reply.memberRoles ?? {},
          availablePermissions: reply.availablePermissions ?? [],
          busy: false,
          error: null,
          lastCode: null,
        },
      });
    },

    closeAdmin() {
      set({ admin: null });
    },

    async createInvite(options = {}) {
      const s = socket;
      const admin = get().admin;
      if (!s || !admin || admin.busy) return null;

      set({ admin: { ...admin, busy: true, error: null } });
      const reply = await createInvite(s, admin.guildId, options);
      const current = get().admin;
      if (current?.guildId !== admin.guildId) return null;

      if (!reply.ok || !reply.code) {
        set({ admin: { ...current, busy: false, error: describeSocketError(reply.error) } });
        return null;
      }
      set({
        admin: {
          ...current,
          invites: reply.invites ?? current.invites,
          busy: false,
          error: null,
          lastCode: reply.code,
        },
      });
      return reply.code;
    },

    async revokeInvite(code) {
      const s = socket;
      const admin = get().admin;
      if (!s || !admin || admin.busy) return;

      set({ admin: { ...admin, busy: true, error: null } });
      const reply = await revokeInvite(s, admin.guildId, code);
      const current = get().admin;
      if (current?.guildId !== admin.guildId) return;
      set({
        admin: {
          ...current,
          invites: reply.invites ?? current.invites,
          busy: false,
          error: reply.ok ? null : describeSocketError(reply.error),
          lastCode: current.lastCode === code ? null : current.lastCode,
        },
      });
    },

    async banMember(userId, reason) {
      const s = socket;
      const admin = get().admin;
      const guildId = admin?.guildId ?? get().activeGuildId;
      if (!s || !guildId || admin?.busy) return "Nada a fazer agora.";

      if (admin) set({ admin: { ...admin, busy: true, error: null } });
      const reply = await banMember(s, guildId, userId, reason);
      const current = get().admin;
      const error = reply.ok ? null : describeSocketError(reply.error);
      if (current?.guildId === guildId) set({
        admin: {
          ...current,
          roster: reply.ok ? current.roster.filter((entry) => entry.id !== userId) : current.roster,
          bans: reply.bans ?? current.bans,
          busy: false,
          error,
        },
      });
      return error;
    },

    async unbanMember(userId) {
      const s = socket;
      const admin = get().admin;
      if (!s || !admin || admin.busy) return;

      set({ admin: { ...admin, busy: true, error: null } });
      const reply = await unbanMember(s, admin.guildId, userId);
      const current = get().admin;
      if (current?.guildId !== admin.guildId) return;
      set({
        admin: {
          ...current,
          bans: reply.bans ?? current.bans,
          busy: false,
          error: reply.ok ? null : describeSocketError(reply.error),
        },
      });
    },

    async kickMember(userId, reason) {
      const s = socket;
      const admin = get().admin;
      const guildId = admin?.guildId ?? get().activeGuildId;
      if (!s || !guildId) return "Sem conexão com o servidor.";
      const reply = await kickGuildMember(s, guildId, userId, reason);
      if (!reply.ok) return describeSocketError(reply.error);
      if (admin?.guildId === guildId) {
        set({ admin: { ...admin, roster: admin.roster.filter((entry) => entry.id !== userId) } });
      }
      return null;
    },

    async timeoutMember(userId, durationMs, reason) {
      const s = socket;
      const admin = get().admin;
      if (!s || !admin) return "Sem conexão com o servidor.";
      const reply = await timeoutGuildMember(s, admin.guildId, userId, durationMs, reason);
      if (!reply.ok) return describeSocketError(reply.error);
      set({ admin: { ...admin, timeouts: reply.timeouts ?? admin.timeouts } });
      return null;
    },

    async removeTimeout(userId) {
      const s = socket;
      const admin = get().admin;
      if (!s || !admin) return "Sem conexão com o servidor.";
      const reply = await removeMemberTimeout(s, admin.guildId, userId);
      if (!reply.ok) return describeSocketError(reply.error);
      set({ admin: { ...admin, timeouts: reply.timeouts ?? admin.timeouts } });
      return null;
    },

    async loadChannelPermissions(channelId) {
      if (!socket) return;
      const reply = await loadChannelPermissionsRequest(socket, channelId);
      if (reply.ok) set((state) => ({ channelOverwrites: { ...state.channelOverwrites, [channelId]: reply.overwrites ?? [] } }));
    },

    async saveChannelPermissions(channelId, targetType, targetId, allow, deny) {
      if (!socket) return "Sem conexão com o servidor.";
      const reply = await saveChannelPermissionsRequest(socket, channelId, targetType, targetId, allow, deny);
      if (!reply.ok) return describeSocketError(reply.error);
      set((state) => ({ channelOverwrites: { ...state.channelOverwrites, [channelId]: reply.overwrites ?? [] } }));
      return null;
    },
    async reorderChannels(guildId, orderedIds) {
      const s = socket;
      if (!s) return "Sem conexão.";
      const reply = await reorderGuildChannels(s, guildId, orderedIds);
      if (!reply.ok || !reply.channels) return describeSocketError(reply.error);
      set((state) => ({
        channels: [...state.channels.filter((channel) => channel.guildId !== guildId), ...reply.channels!]
          .sort((left, right) => left.position - right.position),
      }));
      return null;
    },

    async createRole(name, color, permissions) {
      const s = socket;
      const admin = get().admin;
      if (!s || !admin) return "Sem conexão com o servidor.";
      const reply = await createGuildRole(s, admin.guildId, name, color, permissions);
      if (!reply.ok) return describeSocketError(reply.error);
      set({ admin: { ...admin, roles: reply.roles ?? admin.roles, error: null } });
      return null;
    },

    async updateRole(roleId, name, color, permissions) {
      const s = socket;
      const admin = get().admin;
      if (!s || !admin) return "Sem conexão com o servidor.";
      const reply = await updateGuildRole(s, admin.guildId, roleId, name, color, permissions);
      if (!reply.ok) return describeSocketError(reply.error);
      set({ admin: { ...admin, roles: reply.roles ?? admin.roles, error: null } });
      return null;
    },

    async deleteRole(roleId) {
      const s = socket;
      const admin = get().admin;
      if (!s || !admin) return "Sem conexão com o servidor.";
      const reply = await deleteGuildRole(s, admin.guildId, roleId);
      if (!reply.ok) return describeSocketError(reply.error);
      set({
        admin: {
          ...admin,
          roles: reply.roles ?? admin.roles,
          memberRoles: reply.memberRoles ?? admin.memberRoles,
          error: null,
        },
      });
      return null;
    },

    async assignRole(userId, roleId, assigned) {
      const s = socket;
      const admin = get().admin;
      if (!s || !admin) return "Sem conexão com o servidor.";
      const reply = await assignGuildRole(s, admin.guildId, userId, roleId, assigned);
      if (!reply.ok) return describeSocketError(reply.error);
      set({ admin: { ...admin, memberRoles: reply.memberRoles ?? admin.memberRoles, error: null } });
      return null;
    },
    async reorderRoles(orderedIds) {
      const admin = get().admin;
      const s = socket;
      if (!admin || !s) return "Sem conexão.";
      const reply = await reorderGuildRoles(s, admin.guildId, orderedIds);
      if (!reply.ok || !reply.roles) return describeSocketError(reply.error);
      set((state) => ({
        roles: { ...state.roles, [admin.guildId]: reply.roles! },
        admin: state.admin ? { ...state.admin, roles: reply.roles!, error: null } : null,
      }));
      return null;
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
