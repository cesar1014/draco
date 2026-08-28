import { useEffect, useRef, useState } from "react";
import { CameraIcon, CameraOffIcon, MicIcon, MicOffIcon, SpeakerIcon } from "@/components/Icons";
import { useStreamRef } from "@/hooks/useStreamRef";
import { SpeakingDetector, resumeAudio } from "@/rtc/SpeakingDetector";
import { describeCameraError, describeMicrophoneError } from "@/rtc/MediaManager";
import { playCue } from "@/rtc/sounds";
import { useStore } from "@/state/store";

/** Rótulo de dispositivo vem vazio até a primeira permissão; daí o reserva. */
const deviceLabel = (device: MediaDeviceInfo, index: number, fallback: string): string =>
  device.label || `${fallback} ${index + 1}`;

/**
 * Tela antes de entrar na call: escolher microfone, câmera e saída, ver a própria
 * imagem e conferir que o microfone capta.
 *
 * Os dispositivos já podiam ser trocados nas configurações, mas só **depois** de
 * entrar — o que significa descobrir que o microfone errado estava selecionado
 * quando alguém já disse "não te ouço". Aqui a conferência vem antes.
 *
 * A prévia abre os dispositivos por conta própria e os fecha ao sair desta tela.
 * Não passa pelo `MediaManager`: ele é o que a call usa, e deixar a prévia mexer
 * nele faria uma câmera de teste continuar ligada dentro da call de quem entrou
 * com a câmera desligada.
 */
export function PreCall({ channelId }: { channelId: string }) {
  const channels = useStore((state) => state.channels);
  const members = useStore((state) => state.members);
  const settings = useStore((state) => state.settings);
  const devices = useStore((state) => state.devices);
  const ice = useStore((state) => state.ice);
  const applySettings = useStore((state) => state.applySettings);
  const refreshDevices = useStore((state) => state.refreshDevices);
  const joinVoice = useStore((state) => state.joinVoice);

  const [micStream, setMicStream] = useState<MediaStream | null>(null);
  const [cameraStream, setCameraStream] = useState<MediaStream | null>(null);
  const [cameraOn, setCameraOn] = useState(false);
  const [level, setLevel] = useState(0);
  const [micError, setMicError] = useState<string | null>(null);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [joining, setJoining] = useState(false);

  const detector = useRef<SpeakingDetector | null>(null);
  const video = useStreamRef<HTMLVideoElement>(cameraStream);

  const channel = channels.find((item) => item.id === channelId);
  const present = Object.values(members).filter((member) => member.voiceChannelId === channelId);

  /**
   * Microfone da prévia. Sem o processamento do Draco de propósito: o que se quer
   * conferir aqui é se o dispositivo capta, e o filtro espectral atenuaria
   * justamente o sinal fraco que a pessoa está tentando ver na barra.
   */
  useEffect(() => {
    let cancelled = false;
    let stream: MediaStream | null = null;

    void (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: settings.micDeviceId ? { deviceId: { exact: settings.micDeviceId } } : true,
        });
        if (cancelled) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        resumeAudio();
        setMicStream(stream);
        setMicError(null);
        detector.current = new SpeakingDetector(stream, () => {});
      } catch (error) {
        if (!cancelled) setMicError(describeMicrophoneError(error));
      }
    })();

    return () => {
      cancelled = true;
      detector.current?.stop();
      detector.current = null;
      stream?.getTracks().forEach((track) => track.stop());
      setMicStream(null);
    };
  }, [settings.micDeviceId]);

  /** A câmera só abre se a pessoa pedir: ninguém quer a luz acendendo sozinha. */
  useEffect(() => {
    if (!cameraOn) {
      setCameraStream(null);
      return;
    }

    let cancelled = false;
    let stream: MediaStream | null = null;

    void (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: settings.cameraDeviceId
            ? { deviceId: { exact: settings.cameraDeviceId } }
            : { facingMode: { ideal: settings.cameraFacing } },
        });
        if (cancelled) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        setCameraStream(stream);
        setCameraError(null);
        // Os rótulos das câmeras só existem depois da permissão concedida.
        void refreshDevices();
      } catch (error) {
        if (cancelled) return;
        setCameraError(describeCameraError(error));
        setCameraOn(false);
      }
    })();

    return () => {
      cancelled = true;
      stream?.getTracks().forEach((track) => track.stop());
      setCameraStream(null);
    };
  }, [cameraOn, settings.cameraDeviceId, settings.cameraFacing, refreshDevices]);

  useEffect(() => {
    const timer = setInterval(() => setLevel(detector.current?.level ?? 0), 80);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    void refreshDevices();
  }, [refreshDevices]);

  // Fone plugado agora é justamente quando se olha esta tela.
  useEffect(() => {
    const onChange = () => void refreshDevices();
    navigator.mediaDevices?.addEventListener("devicechange", onChange);
    return () => navigator.mediaDevices?.removeEventListener("devicechange", onChange);
  }, [refreshDevices]);

  /**
   * Entra na call já com a câmera do jeito que a prévia mostrava. A prévia é
   * fechada pelos efeitos ao desmontar, e a call reabre pelo `MediaManager` — a
   * alternativa seria transferir a trilha, e um dispositivo aberto duas vezes no
   * Windows costuma devolver `NotReadableError` justamente no meio disso.
   */
  async function enter() {
    if (joining) return;
    setJoining(true);
    const wantsCamera = cameraOn;
    await joinVoice(channelId);
    if (wantsCamera && useStore.getState().voiceChannelId === channelId) {
      await useStore.getState().toggleCamera();
    }
    setJoining(false);
  }

  const quality = !ice
    ? null
    : ice.hasTurn
      ? { label: "Conexão pronta", tone: "ok" as const }
      : { label: "Sem TURN: pode falhar em rede restrita", tone: "warn" as const };

  return (
    <div className="precall">
      <div className="precall-preview">
        {cameraStream ? (
          <video
            ref={video}
            className="precall-video"
            data-mirror={settings.mirrorSelf}
            autoPlay
            muted
            playsInline
          />
        ) : (
          <div className="precall-placeholder">
            <CameraOffIcon size={34} />
            <p>{cameraError ?? "Câmera desligada"}</p>
          </div>
        )}

        <div className="precall-preview-actions">
          <button
            type="button"
            className="precall-toggle"
            data-on={cameraOn}
            onClick={() => setCameraOn(!cameraOn)}
            title={cameraOn ? "Desligar a câmera" : "Ligar a câmera"}
          >
            {cameraOn ? <CameraIcon size={18} /> : <CameraOffIcon size={18} />}
            <span>{cameraOn ? "Câmera ligada" : "Câmera desligada"}</span>
          </button>
        </div>
      </div>

      <div className="precall-form">
        <header className="precall-head">
          <h2>{channel?.name ?? "Canal de voz"}</h2>
          <p>
            {present.length === 0
              ? "Ninguém está aqui ainda."
              : `${present.map((member) => member.username).join(", ")} ${present.length === 1 ? "está" : "estão"} na call.`}
          </p>
        </header>

        <label className="field">
          <span>Microfone</span>
          <select
            value={settings.micDeviceId ?? ""}
            onChange={(event) => void applySettings({ micDeviceId: event.target.value || null })}
          >
            <option value="">Padrão do sistema</option>
            {devices.mics.map((device, index) => (
              <option key={device.deviceId} value={device.deviceId}>
                {deviceLabel(device, index, "Microfone")}
              </option>
            ))}
          </select>
        </label>

        <div className="field">
          <span>Nível do microfone</span>
          <div className="meter" role="meter" aria-valuenow={Math.round(level * 100)}>
            <div className="meter-fill" style={{ width: `${Math.round(level * 100)}%` }} />
          </div>
          <p className="hint">
            {micError ?? (micStream ? "Fale: a barra acompanha o que os outros vão receber." : "Abrindo o microfone…")}
          </p>
        </div>

        <label className="field">
          <span>Câmera</span>
          <select
            value={settings.cameraDeviceId ?? ""}
            onChange={(event) => void applySettings({ cameraDeviceId: event.target.value || null })}
          >
            <option value="">Padrão do sistema</option>
            {devices.cameras.map((device, index) => (
              <option key={device.deviceId} value={device.deviceId}>
                {deviceLabel(device, index, "Câmera")}
              </option>
            ))}
          </select>
        </label>

        <label className="field">
          <span>Saída de som</span>
          <select
            value={settings.outputDeviceId ?? ""}
            onChange={(event) => void applySettings({ outputDeviceId: event.target.value || null })}
          >
            <option value="">Padrão do sistema</option>
            {devices.speakers.map((device, index) => (
              <option key={device.deviceId} value={device.deviceId}>
                {deviceLabel(device, index, "Saída")}
              </option>
            ))}
          </select>
          <button type="button" className="link-button" onClick={() => playCue("join")}>
            Tocar um som de teste
          </button>
        </label>

        {quality && (
          <p className={quality.tone === "ok" ? "status-ok" : "status-warn"}>
            <SpeakerIcon size={12} /> {quality.label}
          </p>
        )}

        <button
          type="button"
          className="precall-join"
          disabled={joining}
          onClick={() => void enter()}
        >
          {joining ? "Entrando…" : "Entrar na chamada"}
        </button>

        <p className="hint">
          {settings.pushToTalk
            ? "Push-to-talk ligado: você fala enquanto segura a tecla escolhida."
            : "Você entra com o microfone aberto. Dá para mutar assim que entrar."}
        </p>
        <p className="hint precall-mic-state">
          {settings.denoise === "off" ? <MicOffIcon size={12} /> : <MicIcon size={12} />}
          {settings.denoise === "draco"
            ? "Redução de ruído do Draco ativa."
            : settings.denoise === "browser"
              ? "Redução de ruído do navegador ativa."
              : "Sem redução de ruído."}
        </p>
      </div>
    </div>
  );
}
