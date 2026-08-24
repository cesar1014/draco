import { selectDesktopSource, type DesktopSource } from "@/desktop";

/** Ponto único de acesso a microfone, câmera e tela. */

export interface AudioSettings {
  micDeviceId: string | null;
  echoCancellation: boolean;
  noiseSuppression: boolean;
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
  noiseSuppression: true,
  autoGainControl: true,
};

export type FrameRate = 15 | 24 | 30 | 60;

export const FRAME_RATES: readonly FrameRate[] = [15, 24, 30, 60] as const;

// --- câmera ------------------------------------------------------------------

export type CameraResolution = "360" | "480" | "720" | "1080";

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

export interface ScreenShareOptions {
  resolution: ScreenResolution;
  frameRate: FrameRate;
  /** Levar o som do sistema junto com a imagem. */
  systemAudio: boolean;
}

export const SCREEN_RESOLUTIONS: readonly ScreenResolution[] = ["720", "1080", "source"] as const;

export const DEFAULT_SCREEN_OPTIONS: ScreenShareOptions = {
  resolution: "1080",
  frameRate: 30,
  systemAudio: true,
};

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
 * Em malha P2P o mesmo vídeo sobe uma vez **por pessoa** na call, então os tetos
 * são baixos pro que a resolução sugere. O painel mostra a multiplicação antes
 * de começar.
 */
const SCREEN_BITRATE: Record<ScreenResolution, Record<FrameRate, number>> = {
  "720": { 15: 1_000_000, 24: 1_300_000, 30: 1_500_000, 60: 2_500_000 },
  "1080": { 15: 1_800_000, 24: 2_400_000, 30: 3_000_000, 60: 4_500_000 },
  source: { 15: 2_500_000, 24: 3_200_000, 30: 4_000_000, 60: 6_000_000 },
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
  };
}

// --- erros e suporte ---------------------------------------------------------

/** É aqui que a maioria das calls falha na primeira tentativa; vale ser claro. */
export function describeMediaError(error: unknown): string {
  const name = error instanceof Error ? error.name : "";
  switch (name) {
    case "NotAllowedError":
    case "SecurityError":
      return "Permissão negada. Clique no ícone de câmera/microfone na barra de endereço e permita o acesso.";
    case "NotFoundError":
    case "OverconstrainedError":
      return "Nenhum dispositivo encontrado. Verifique se o microfone ou a câmera estão conectados.";
    case "NotReadableError":
      return "O dispositivo está em uso por outro programa. Feche o que estiver usando a câmera e tente de novo.";
    case "AbortError":
      return "O navegador interrompeu o acesso ao dispositivo. Tente novamente.";
    default:
      return error instanceof Error && error.message
        ? error.message
        : "Falha ao acessar o dispositivo.";
  }
}

/** `getUserMedia` só existe em contexto seguro: HTTPS ou localhost. */
export function mediaSupported(): boolean {
  return Boolean(navigator.mediaDevices?.getUserMedia);
}

export function screenShareSupported(): boolean {
  return Boolean(navigator.mediaDevices?.getDisplayMedia);
}

export class MediaManager {
  #mic: MediaStream | null = null;
  #camera: MediaStream | null = null;
  #screen: MediaStream | null = null;
  #micSettings: AudioSettings = DEFAULT_AUDIO_SETTINGS;
  #cameraOptions: CameraOptions = DEFAULT_CAMERA_OPTIONS;

  get micTrack(): MediaStreamTrack | null {
    return this.#mic?.getAudioTracks()[0] ?? null;
  }

  get micStream(): MediaStream | null {
    return this.#mic;
  }

  get cameraTrack(): MediaStreamTrack | null {
    return this.#camera?.getVideoTracks()[0] ?? null;
  }

  get screenTrack(): MediaStreamTrack | null {
    return this.#screen?.getVideoTracks()[0] ?? null;
  }

  /** `srcObject` recebe stream, não trilha — e criar um novo a cada render pisca. */
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
      this.micTrack?.readyState === "live" &&
      JSON.stringify(settings) === JSON.stringify(this.#micSettings);
    if (unchanged) return this.micTrack!;

    const audio: MediaTrackConstraints = {
      echoCancellation: settings.echoCancellation,
      noiseSuppression: settings.noiseSuppression,
      autoGainControl: settings.autoGainControl,
    };
    if (settings.micDeviceId) audio.deviceId = { exact: settings.micDeviceId };

    const stream = await this.#getUserMedia({ audio, video: false }, () => delete audio.deviceId);

    this.#stop(this.#mic);
    this.#mic = stream;
    this.#micSettings = settings;
    return stream.getAudioTracks()[0];
  }

  async openCamera(
    deviceId: string | null,
    options: CameraOptions = DEFAULT_CAMERA_OPTIONS,
  ): Promise<MediaStreamTrack> {
    const height = CAMERA_HEIGHT[options.resolution];
    const video: MediaTrackConstraints = {
      width: { ideal: Math.round((height * 16) / 9) },
      height: { ideal: height },
      frameRate: { ideal: options.frameRate, max: options.frameRate },
    };
    if (deviceId) video.deviceId = { exact: deviceId };

    const stream = await this.#getUserMedia({ video, audio: false }, () => delete video.deviceId);

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

  /**
   * `source` só chega no app de desktop, onde a janela foi escolhida numa
   * miniatura. No navegador quem pergunta é o próprio navegador, e nenhuma
   * página pode substituir aquele diálogo.
   */
  async openScreen(
    options: ScreenShareOptions = DEFAULT_SCREEN_OPTIONS,
    source: DesktopSource | null = null,
  ): Promise<{ video: MediaStreamTrack; audio: MediaStreamTrack | null }> {
    if (source) await selectDesktopSource(source);

    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: screenConstraints(options),
      audio: options.systemAudio,
    });

    this.#stop(this.#screen);
    this.#screen = stream;
    const track = stream.getVideoTracks()[0];
    // Tela é texto e linha fina: nitidez importa mais que fluidez.
    track.contentHint = "detail";
    return { video: track, audio: stream.getAudioTracks()[0] ?? null };
  }

  /**
   * Troca resolução e taxa de quadros na trilha que já está no ar. Recapturar
   * faria o navegador perguntar de novo qual tela mostrar e a imagem sumiria do
   * outro lado por um instante; `applyConstraints` não.
   */
  async applyScreenOptions(options: ScreenShareOptions): Promise<void> {
    await this.screenTrack?.applyConstraints(screenConstraints(options));
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

  #stop(stream: MediaStream | null): void {
    stream?.getTracks().forEach((track) => track.stop());
  }
}
