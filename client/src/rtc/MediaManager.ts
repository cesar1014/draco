import {
  claimDesktopSource,
  isDesktopApp,
  reportCaptureFailure,
  type CaptureFailure,
  type ClaimFailure,
} from "@/desktop";
import { MicChain, loadDenoise, type DenoiseMode, type DenoiseStrength } from "@/rtc/denoise";

/** Ponto único de acesso a microfone, câmera e tela. */

export interface AudioSettings {
  micDeviceId: string | null;
  echoCancellation: boolean;
  /** `browser` é a do navegador; `draco` é a nossa, espectral. */
  denoise: DenoiseMode;
  denoiseStrength: DenoiseStrength;
  autoGainControl: boolean;
}

export interface DeviceList {
  mics: MediaDeviceInfo[];
  cameras: MediaDeviceInfo[];
  speakers: MediaDeviceInfo[];
}

export const DEFAULT_AUDIO_SETTINGS: AudioSettings = {
  micDeviceId: null,
  echoCancellation: true,
  denoise: "draco",
  denoiseStrength: "medium",
  autoGainControl: true,
};

export type FrameRate = 15 | 24 | 30 | 60;

export const FRAME_RATES: readonly FrameRate[] = [15, 24, 30, 60] as const;

// --- câmera ------------------------------------------------------------------

export type CameraResolution = "360" | "480" | "720" | "1080";

/** Lente do celular: `user` é a de selfie, `environment` a de trás. */
export type CameraFacing = "user" | "environment";

export interface CameraOptions {
  resolution: CameraResolution;
  frameRate: FrameRate;
}

export const CAMERA_RESOLUTIONS: readonly CameraResolution[] = ["360", "480", "720", "1080"] as const;

export const DEFAULT_CAMERA_OPTIONS: CameraOptions = { resolution: "720", frameRate: 30 };

const CAMERA_HEIGHT: Record<CameraResolution, number> = { "360": 360, "480": 480, "720": 720, "1080": 1080 };

const CAMERA_BITRATE: Record<CameraResolution, Record<FrameRate, number>> = {
  "360": { 15: 300_000, 24: 400_000, 30: 500_000, 60: 800_000 },
  "480": { 15: 500_000, 24: 650_000, 30: 800_000, 60: 1_200_000 },
  "720": { 15: 900_000, 24: 1_100_000, 30: 1_400_000, 60: 2_200_000 },
  "1080": { 15: 1_600_000, 24: 2_000_000, 30: 2_500_000, 60: 3_500_000 },
};

export const cameraBitrate = (options: CameraOptions): number =>
  CAMERA_BITRATE[options.resolution][options.frameRate];

export function normalizeCameraOptions(value: unknown): CameraOptions {
  const raw = (value ?? {}) as Partial<CameraOptions>;
  return {
    resolution: CAMERA_RESOLUTIONS.includes(raw.resolution as CameraResolution)
      ? (raw.resolution as CameraResolution)
      : DEFAULT_CAMERA_OPTIONS.resolution,
    frameRate: FRAME_RATES.includes(raw.frameRate as FrameRate)
      ? (raw.frameRate as FrameRate)
      : DEFAULT_CAMERA_OPTIONS.frameRate,
  };
}

// --- tela --------------------------------------------------------------------

export type ScreenResolution = "720" | "1080" | "source";

/**
 * O que está na tela decide o que sacrificar quando a banda aperta. Jogo e vídeo
 * preferem perder resolução a engasgar; texto e código preferem o contrário.
 * `auto` deixa o codec decidir pelo conteúdo que está chegando.
 */
export type ScreenContent = "auto" | "game" | "text";

export const SCREEN_CONTENTS: readonly ScreenContent[] = ["auto", "game", "text"] as const;

export interface ScreenShareOptions {
  resolution: ScreenResolution;
  frameRate: FrameRate;
  /** Levar o som do sistema junto com a imagem. */
  systemAudio: boolean;
  content: ScreenContent;
}

export const SCREEN_RESOLUTIONS: readonly ScreenResolution[] = ["720", "1080", "source"] as const;

export const DEFAULT_SCREEN_OPTIONS: ScreenShareOptions = {
  resolution: "1080",
  frameRate: 30,
  systemAudio: true,
  content: "auto",
};

const SCREEN_CONTENT_HINT: Record<ScreenContent, string> = {
  auto: "",
  game: "motion",
  text: "detail",
};

/** Jogo tem que continuar fluindo; texto tem que continuar legível. */
export const screenDegradation = (content: ScreenContent): RTCDegradationPreference =>
  content === "game" ? "maintain-framerate" : "maintain-resolution";

/** `source` não limita: entrega o tamanho nativo da tela. */
const SCREEN_HEIGHT: Record<ScreenResolution, number | null> = { "720": 720, "1080": 1080, source: null };

function screenConstraints(options: ScreenShareOptions): MediaTrackConstraints {
  const video: MediaTrackConstraints = {
    frameRate: { ideal: options.frameRate, max: options.frameRate },
  };
  const height = SCREEN_HEIGHT[options.resolution];
  if (height) {
    const width = Math.round((height * 16) / 9);
    // `max` além de `ideal`: só o `max` faz o navegador reduzir uma tela 1440p.
    video.width = { ideal: width, max: width };
    video.height = { ideal: height, max: height };
  }
  return video;
}

/**
 * Teto de envio pro SFU, que repassa a mesma camada pra todos: sobe uma vez, não
 * uma vez por pessoa. O painel mostra o número antes de começar.
 */
const SCREEN_BITRATE: Record<ScreenResolution, Record<FrameRate, number>> = {
  "720": { 15: 1_200_000, 24: 1_600_000, 30: 2_000_000, 60: 3_000_000 },
  "1080": { 15: 2_200_000, 24: 2_800_000, 30: 3_500_000, 60: 5_000_000 },
  source: { 15: 3_000_000, 24: 3_800_000, 30: 4_500_000, 60: 6_500_000 },
};

export const screenBitrate = (options: ScreenShareOptions): number =>
  SCREEN_BITRATE[options.resolution][options.frameRate];

export function normalizeScreenOptions(value: unknown): ScreenShareOptions {
  const raw = (value ?? {}) as Partial<ScreenShareOptions>;
  return {
    resolution: SCREEN_RESOLUTIONS.includes(raw.resolution as ScreenResolution)
      ? (raw.resolution as ScreenResolution)
      : DEFAULT_SCREEN_OPTIONS.resolution,
    frameRate: FRAME_RATES.includes(raw.frameRate as FrameRate)
      ? (raw.frameRate as FrameRate)
      : DEFAULT_SCREEN_OPTIONS.frameRate,
    systemAudio:
      typeof raw.systemAudio === "boolean" ? raw.systemAudio : DEFAULT_SCREEN_OPTIONS.systemAudio,
    content: SCREEN_CONTENTS.includes(raw.content as ScreenContent)
      ? (raw.content as ScreenContent)
      : DEFAULT_SCREEN_OPTIONS.content,
  };
}

// --- erros e suporte ---------------------------------------------------------

const CLAIM_MESSAGE: Record<ClaimFailure, string> = {
  gone: "Essa janela não está mais aberta. Clique em Atualizar e escolha outra.",
  denied: "O app não autorizou a captura desta página.",
  invalid: "Escolha uma tela ou janela antes de compartilhar.",
  failed: "Não foi possível preparar a captura da tela. Tente novamente.",
  unavailable: "Este modo de captura só existe no app para Windows.",
};

/** Captura de tela que não vale mostrar como erro genérico de dispositivo. */
export class ScreenCaptureError extends Error {
  constructor(
    readonly reason: ClaimFailure,
    message: string,
  ) {
    super(message);
    this.name = "ScreenCaptureError";
  }
}

/** Cancelar o diálogo de captura ou de permissão: intenção, não falha. */
export const userCancelled = (error: unknown): boolean =>
  error instanceof Error &&
  error.name !== "ScreenCaptureError" &&
  /NotAllowed|Abort/.test(error.name);

export function describeCameraError(error: unknown): string {
  switch (errorName(error)) {
    case "NotAllowedError":
    case "SecurityError":
      return "Permissão negada. Clique no ícone de câmera na barra de endereço e permita o acesso.";
    case "NotFoundError":
    case "OverconstrainedError":
      return "Nenhuma câmera encontrada. Verifique se ela está conectada.";
    case "NotReadableError":
      return "A câmera está em uso por outro programa. Feche o que estiver usando a câmera e tente de novo.";
    case "AbortError":
      return "O navegador interrompeu o acesso à câmera. Tente novamente.";
    default:
      return fallbackMessage(error, "Falha ao abrir a câmera.");
  }
}

export function describeMicrophoneError(error: unknown): string {
  switch (errorName(error)) {
    case "NotAllowedError":
    case "SecurityError":
      return "Permissão negada. Clique no ícone de microfone na barra de endereço e permita o acesso.";
    case "NotFoundError":
    case "OverconstrainedError":
      return "Nenhum microfone encontrado. Verifique se ele está conectado.";
    case "NotReadableError":
      return "O microfone está em uso por outro programa. Feche o que estiver usando o microfone e tente de novo.";
    case "AbortError":
      return "O navegador interrompeu o acesso ao microfone. Tente novamente.";
    default:
      return fallbackMessage(error, "Falha ao abrir o microfone.");
  }
}

/**
 * Captura de tela não disputa dispositivo com ninguém, então `NotReadableError`
 * aqui não significa "outro programa está usando", significa que o sistema não
 * entregou os quadros. Dizer a frase de dispositivo ocupado manda a pessoa fechar
 * programas que não têm nada a ver com o problema.
 */
export function describeScreenShareError(error: unknown): string {
  if (error instanceof ScreenCaptureError) return error.message;
  switch (errorName(error)) {
    case "NotAllowedError":
    case "SecurityError":
      return "Permissão de captura de tela negada.";
    case "NotFoundError":
      return "A tela ou janela escolhida não está mais disponível. Escolha outra e tente de novo.";
    case "OverconstrainedError":
      return "A resolução escolhida não é possível nessa tela. Tente 720p.";
    case "NotReadableError":
    case "AbortError":
      return "Não foi possível iniciar a captura da tela. Tente compartilhar de novo, ou escolha uma janela específica em vez da tela inteira.";
    default:
      return fallbackMessage(error, "Não foi possível iniciar a captura da tela.");
  }
}

const errorName = (error: unknown): string => (error instanceof Error ? error.name : "");

const fallbackMessage = (error: unknown, fallback: string): string =>
  error instanceof Error && error.message ? error.message : fallback;

/** `getUserMedia` só existe em contexto seguro: HTTPS ou localhost. */
export function mediaSupported(): boolean {
  return Boolean(navigator.mediaDevices?.getUserMedia);
}

export function screenShareSupported(): boolean {
  return Boolean(navigator.mediaDevices?.getDisplayMedia);
}

export interface ScreenCapture {
  video: MediaStreamTrack;
  audio: MediaStreamTrack | null;
  /** A imagem veio, o som do sistema não. A transmissão segue; a interface avisa. */
  systemAudioFailed: boolean;
}

export class MediaManager {
  #mic: MediaStream | null = null;
  #chain: MicChain | null = null;
  #camera: MediaStream | null = null;
  #screen: MediaStream | null = null;
  #micSettings: AudioSettings = DEFAULT_AUDIO_SETTINGS;
  #cameraOptions: CameraOptions = DEFAULT_CAMERA_OPTIONS;

  /** O que a call envia: a saída do filtro quando ele existe, senão o dispositivo. */
  get micTrack(): MediaStreamTrack | null {
    return this.#chain?.track ?? this.#mic?.getAudioTracks()[0] ?? null;
  }

  get micStream(): MediaStream | null {
    return this.#chain?.stream ?? this.#mic;
  }

  get cameraTrack(): MediaStreamTrack | null {
    return this.#camera?.getVideoTracks()[0] ?? null;
  }

  get screenTrack(): MediaStreamTrack | null {
    return this.#screen?.getVideoTracks()[0] ?? null;
  }

  /** `srcObject` recebe stream, não trilha, e criar um novo a cada render pisca. */
  get cameraStream(): MediaStream | null {
    return this.#camera;
  }

  get screenStream(): MediaStream | null {
    return this.#screen;
  }

  get screenAudioTrack(): MediaStreamTrack | null {
    return this.#screen?.getAudioTracks()[0] ?? null;
  }

  /** Mutar é `enabled = false`, não fechar: religar fica instantâneo. */
  async openMic(settings: AudioSettings): Promise<MediaStreamTrack> {
    const unchanged =
      this.#mic?.getAudioTracks()[0]?.readyState === "live" &&
      JSON.stringify(settings) === JSON.stringify(this.#micSettings);
    if (unchanged) return this.micTrack!;

    const ours = settings.denoise === "draco" && (await loadDenoise());
    const audio: MediaTrackConstraints = {
      echoCancellation: settings.echoCancellation,
      // As duas supressões juntas soam metálicas: a nossa entra no lugar da dele.
      noiseSuppression: !ours && settings.denoise !== "off",
      autoGainControl: settings.autoGainControl,
      channelCount: { ideal: 1 },
    };
    if (settings.micDeviceId) audio.deviceId = { exact: settings.micDeviceId };

    const stream = await this.#getUserMedia({ audio, video: false }, () => delete audio.deviceId);

    this.#closeChain();
    this.#stop(this.#mic);
    this.#mic = stream;
    this.#micSettings = settings;
    if (ours) this.#chain = new MicChain(stream, settings.denoiseStrength);

    const track = this.micTrack!;
    // Voz: o codec pode sacrificar música pra manter a fala inteligível.
    track.contentHint = "speech";
    return track;
  }

  /** Força da supressão muda na hora; reabrir o microfone cortaria a fala. */
  tuneDenoise(strength: DenoiseStrength): boolean {
    if (!this.#chain) return false;
    this.#chain.tune(strength);
    this.#micSettings = { ...this.#micSettings, denoiseStrength: strength };
    return true;
  }

  /** Está com a nossa supressão no ar agora. */
  get denoising(): boolean {
    return this.#chain !== null;
  }


  async openCamera(
    deviceId: string | null,
    options: CameraOptions = DEFAULT_CAMERA_OPTIONS,
    facing: CameraFacing | null = null,
  ): Promise<MediaStreamTrack> {
    const height = CAMERA_HEIGHT[options.resolution];
    const video: MediaTrackConstraints = {
      width: { ideal: Math.round((height * 16) / 9) },
      height: { ideal: height },
      frameRate: { ideal: options.frameRate, max: options.frameRate },
    };
    // `deviceId` exato vence `facingMode`, então os dois nunca vão juntos.
    if (deviceId) video.deviceId = { exact: deviceId };
    else if (facing) video.facingMode = { ideal: facing };

    const stream = await this.#getUserMedia({ video, audio: false }, () => {
      delete video.deviceId;
      if (facing) video.facingMode = { ideal: facing };
    });

    this.#stop(this.#camera);
    this.#camera = stream;
    this.#cameraOptions = options;
    const track = stream.getVideoTracks()[0];
    // Rosto em movimento: o codec prioriza fluidez sobre nitidez.
    track.contentHint = "motion";
    return track;
  }

  get cameraOptions(): CameraOptions {
    return this.#cameraOptions;
  }

  /** Lente em uso agora. Só celular preenche isso; webcam de PC devolve `null`. */
  get cameraFacing(): CameraFacing | null {
    const facing = this.cameraTrack?.getSettings().facingMode;
    return facing === "user" || facing === "environment" ? facing : null;
  }

  /** Dispositivo que o navegador realmente abriu. Vazio quando ele não conta qual. */
  get cameraDeviceId(): string | null {
    return this.cameraTrack?.getSettings().deviceId || null;
  }

  /**
   * `sourceId` só chega no app de desktop, onde a janela foi escolhida numa
   * miniatura. No navegador quem pergunta é o próprio navegador, e nenhuma
   * página pode substituir aquele diálogo.
   *
   * A tela é o essencial e o som do sistema é o extra: se o loopback falhar, a
   * transmissão começa muda em vez de não começar. `systemAudioFailed` volta
   * verdadeiro nesse caso, pro aviso discreto na interface.
   */
  async openScreen(
    options: ScreenShareOptions = DEFAULT_SCREEN_OPTIONS,
    sourceId: string | null = null,
  ): Promise<ScreenCapture> {
    const wantsAudio = options.systemAudio;
    const kind = sourceId?.startsWith("window:") ? "window" : sourceId ? "screen" : "browser";
    const fail = (stage: CaptureFailure["stage"], error: unknown) => {
      reportCaptureFailure({
        stage,
        name: error instanceof Error ? error.name : typeof error,
        message: error instanceof Error ? error.message : String(error),
        sourceId: sourceId ?? "",
        sourceKind: kind,
        systemAudio: wantsAudio,
      });
    };

    if (sourceId && isDesktopApp()) {
      const claim = await claimDesktopSource(sourceId, wantsAudio);
      if (!claim.ok) {
        const error = new ScreenCaptureError(claim.reason, CLAIM_MESSAGE[claim.reason]);
        fail("claim", error);
        throw error;
      }
    }

    const video = screenConstraints(options);
    let stream: MediaStream;
    let systemAudioFailed = false;

    try {
      stream = await navigator.mediaDevices.getDisplayMedia({ video, audio: wantsAudio });
    } catch (error) {
      if (!wantsAudio || userCancelled(error)) {
        fail("getDisplayMedia", error);
        throw error;
      }
      // Loopback indisponível derruba o pedido inteiro, mesmo com a tela pronta
      // pra capturar. Segunda tentativa sem áudio: perder o som do jogo é
      // aceitável, perder a transmissão não.
      fail("systemAudio", error);
      if (sourceId && isDesktopApp()) {
        const claim = await claimDesktopSource(sourceId, false);
        if (!claim.ok) {
          const gone = new ScreenCaptureError(claim.reason, CLAIM_MESSAGE[claim.reason]);
          fail("claim", gone);
          throw gone;
        }
      }
      try {
        stream = await navigator.mediaDevices.getDisplayMedia({ video, audio: false });
      } catch (retryError) {
        fail("getDisplayMedia", retryError);
        throw retryError;
      }
      systemAudioFailed = true;
    }

    this.#stop(this.#screen);
    this.#screen = stream;

    const track = stream.getVideoTracks()[0];
    track.contentHint = SCREEN_CONTENT_HINT[options.content];

    const audio = stream.getAudioTracks()[0] ?? null;
    // Som de jogo e de vídeo não é fala: sem isso o codec corta os graves.
    if (audio) audio.contentHint = "music";
    // Pedimos áudio, a captura veio, e ainda assim não há trilha de som: no
    // Windows isso é o loopback silenciosamente indisponível.
    if (wantsAudio && !audio) systemAudioFailed = true;

    return { video: track, audio, systemAudioFailed };
  }

  /**
   * Troca resolução e taxa de quadros na trilha que já está no ar. Recapturar
   * faria o navegador perguntar de novo qual tela mostrar e a imagem sumiria do
   * outro lado por um instante; `applyConstraints` não.
   */
  async applyScreenOptions(options: ScreenShareOptions): Promise<void> {
    const track = this.screenTrack;
    if (!track) return;
    track.contentHint = SCREEN_CONTENT_HINT[options.content];
    await track.applyConstraints(screenConstraints(options));
  }

  /** Mesma ideia da tela: a câmera muda de tamanho sem piscar. */
  async applyCameraOptions(options: CameraOptions): Promise<void> {
    const track = this.cameraTrack;
    if (!track) return;
    const height = CAMERA_HEIGHT[options.resolution];
    await track.applyConstraints({
      width: { ideal: Math.round((height * 16) / 9) },
      height: { ideal: height },
      frameRate: { ideal: options.frameRate, max: options.frameRate },
    });
    this.#cameraOptions = options;
  }

  closeMic(): void {
    this.#closeChain();
    this.#stop(this.#mic);
    this.#mic = null;
  }

  closeCamera(): void {
    this.#stop(this.#camera);
    this.#camera = null;
  }

  closeScreen(): void {
    this.#stop(this.#screen);
    this.#screen = null;
  }

  closeAll(): void {
    this.closeMic();
    this.closeCamera();
    this.closeScreen();
  }

  /** Rótulo de dispositivo vem vazio antes da primeira permissão concedida. */
  async listDevices(): Promise<DeviceList> {
    if (!navigator.mediaDevices?.enumerateDevices) return { mics: [], cameras: [], speakers: [] };
    const devices = await navigator.mediaDevices.enumerateDevices();
    return {
      mics: devices.filter((d) => d.kind === "audioinput"),
      cameras: devices.filter((d) => d.kind === "videoinput"),
      speakers: devices.filter((d) => d.kind === "audiooutput"),
    };
  }

  /**
   * Um dispositivo escolhido antes pode ter sido desconectado. `relax` solta a
   * restrição de `deviceId` pra cair no padrão do sistema em vez de deixar a
   * pessoa sem áudio nenhum.
   */
  async #getUserMedia(constraints: MediaStreamConstraints, relax: () => void): Promise<MediaStream> {
    try {
      return await navigator.mediaDevices.getUserMedia(constraints);
    } catch (error) {
      if (error instanceof Error && /NotFound|Overconstrained/.test(error.name)) {
        relax();
        return navigator.mediaDevices.getUserMedia(constraints);
      }
      throw error;
    }
  }

  #closeChain(): void {
    this.#chain?.close();
    this.#chain = null;
  }

  #stop(stream: MediaStream | null): void {
    stream?.getTracks().forEach((track) => track.stop());
  }
}
