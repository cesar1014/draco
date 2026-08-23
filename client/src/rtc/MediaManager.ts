/**
 * Todo acesso a microfone, câmera e tela passa por aqui. Concentrar num lugar
 * resolve dois problemas chatos: trilha que fica ligada depois de desligada
 * (a luz da webcam acesa sem motivo) e troca de dispositivo no meio da call.
 */

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

/**
 * Traduz o erro do navegador pra algo que a pessoa possa resolver. É o ponto
 * onde a maioria das calls falha na primeira tentativa, então vale ser claro.
 */
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
      return "O dispositivo está em uso por outro programa. Feche o Zoom, Teams ou o Discord de verdade e tente de novo.";
    case "AbortError":
      return "O navegador interrompeu o acesso ao dispositivo. Tente novamente.";
    default:
      return error instanceof Error && error.message ? error.message : "Falha ao acessar o dispositivo.";
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

  /**
   * Os streams inteiros, pro `<video>` da própria pessoa. `srcObject` recebe
   * stream, não trilha, e clonar um novo `MediaStream` a cada render faria a
   * prévia piscar — então o stream original é o que se entrega.
   */
  get cameraStream(): MediaStream | null {
    return this.#camera;
  }

  get screenStream(): MediaStream | null {
    return this.#screen;
  }

  get screenAudioTrack(): MediaStreamTrack | null {
    return this.#screen?.getAudioTracks()[0] ?? null;
  }

  /**
   * Abre o microfone. A trilha fica viva o tempo todo da call: mutar é
   * `enabled = false`, não fechar o microfone — assim religar é instantâneo e a
   * conexão não precisa renegociar.
   */
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

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio, video: false });
    } catch (error) {
      // Dispositivo escolhido antes pode ter sido desconectado. Em vez de
      // deixar a pessoa sem áudio, cai no microfone padrão do sistema.
      if (settings.micDeviceId && error instanceof Error && /NotFound|Overconstrained/.test(error.name)) {
        delete audio.deviceId;
        stream = await navigator.mediaDevices.getUserMedia({ audio, video: false });
      } else {
        throw error;
      }
    }

    this.#stop(this.#mic);
    this.#mic = stream;
    this.#micSettings = settings;
    return stream.getAudioTracks()[0];
  }

  async openCamera(deviceId: string | null): Promise<MediaStreamTrack> {
    const video: MediaTrackConstraints = {
      width: { ideal: 1280 },
      height: { ideal: 720 },
      frameRate: { ideal: 30 },
    };
    if (deviceId) video.deviceId = { exact: deviceId };

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video, audio: false });
    } catch (error) {
      if (deviceId && error instanceof Error && /NotFound|Overconstrained/.test(error.name)) {
        delete video.deviceId;
        stream = await navigator.mediaDevices.getUserMedia({ video, audio: false });
      } else {
        throw error;
      }
    }

    this.#stop(this.#camera);
    this.#camera = stream;
    const track = stream.getVideoTracks()[0];
    // Diz ao codec que é rosto se movendo: ele prioriza fluidez sobre nitidez.
    track.contentHint = "motion";
    return track;
  }

  /**
   * Abre o compartilhamento de tela. O áudio vem junto quando o navegador
   * permite (Chrome captura som de aba e do sistema; Firefox não manda nada) —
   * por isso o retorno trata áudio como opcional.
   */
  async openScreen(): Promise<{ video: MediaStreamTrack; audio: MediaStreamTrack | null }> {
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: 30, max: 60 } },
      audio: true,
    });

    this.#stop(this.#screen);
    this.#screen = stream;
    const video = stream.getVideoTracks()[0];
    // Tela é texto e linha fina: aqui nitidez importa mais que fluidez.
    video.contentHint = "detail";
    return { video, audio: stream.getAudioTracks()[0] ?? null };
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

  /**
   * Rótulo de dispositivo só aparece depois de uma permissão concedida — antes
   * disso o navegador devolve string vazia por privacidade. Quem chama deve
   * tratar o nome vazio, e não presumir que a lista já é legível.
   */
  async listDevices(): Promise<DeviceList> {
    if (!navigator.mediaDevices?.enumerateDevices) return { mics: [], cameras: [], speakers: [] };
    const devices = await navigator.mediaDevices.enumerateDevices();
    return {
      mics: devices.filter((d) => d.kind === "audioinput"),
      cameras: devices.filter((d) => d.kind === "videoinput"),
      speakers: devices.filter((d) => d.kind === "audiooutput"),
    };
  }

  #stop(stream: MediaStream | null): void {
    stream?.getTracks().forEach((track) => track.stop());
  }
}
