import {
  CameraIcon,
  CameraOffIcon,
  GearIcon,
  HangUpIcon,
  HeadphoneIcon,
  HeadphoneOffIcon,
  MicIcon,
  MicOffIcon,
  ScreenIcon,
  ScreenOffIcon,
  SlidersIcon,
} from "@/components/Icons";
import { screenShareSupported } from "@/rtc/MediaManager";
import { useStore } from "@/state/store";

export function CallControls() {
  const muted = useStore((state) => state.muted);
  const deafened = useStore((state) => state.deafened);
  const camOn = useStore((state) => state.camOn);
  const screenOn = useStore((state) => state.screenOn);
  const talking = useStore((state) => state.talking);
  const pushToTalk = useStore((state) => state.settings.pushToTalk);
  const pushToTalkKey = useStore((state) => state.settings.pushToTalkKey);
  const toggleMute = useStore((state) => state.toggleMute);
  const toggleDeafen = useStore((state) => state.toggleDeafen);
  const toggleCamera = useStore((state) => state.toggleCamera);
  const toggleScreen = useStore((state) => state.toggleScreen);
  const openScreenPicker = useStore((state) => state.openScreenPicker);
  const leaveVoice = useStore((state) => state.leaveVoice);
  const openSettings = useStore((state) => state.openSettings);

  const canShare = screenShareSupported();

  return (
    <div className="call-controls">
      <button
        type="button"
        className="call-button"
        data-on={camOn}
        onClick={() => void toggleCamera()}
        title="Câmera (Ctrl+Shift+V)"
      >
        {camOn ? <CameraIcon /> : <CameraOffIcon />}
      </button>

      <button
        type="button"
        className="call-button"
        data-on={screenOn}
        onClick={() => void toggleScreen()}
        title={canShare ? "Compartilhar a tela (Ctrl+Shift+S)" : "Compartilhar tela só pelo computador"}
      >
        {screenOn ? <ScreenIcon /> : <ScreenOffIcon />}
      </button>

      {screenOn && (
        <button
          type="button"
          className="call-button quality"
          onClick={openScreenPicker}
          title="Qualidade do vídeo que está sendo transmitido"
        >
          <SlidersIcon />
        </button>
      )}

      <button
        type="button"
        className="call-button"
        data-off={muted}
        data-talking={pushToTalk && talking}
        onClick={toggleMute}
        title="Microfone (Ctrl+Shift+M)"
      >
        {muted ? <MicOffIcon /> : <MicIcon />}
      </button>

      <button
        type="button"
        className="call-button"
        data-off={deafened}
        onClick={toggleDeafen}
        title="Ouvido (Ctrl+Shift+D)"
      >
        {deafened ? <HeadphoneOffIcon /> : <HeadphoneIcon />}
      </button>

      <button type="button" className="call-button" onClick={openSettings} title="Configurações">
        <GearIcon />
      </button>

      <button type="button" className="call-button hangup" onClick={leaveVoice} title="Sair da chamada">
        <HangUpIcon />
      </button>

      {pushToTalk && (
        <span className="ptt-badge" data-on={talking}>
          {talking ? "no ar" : `segure ${keyLabel(pushToTalkKey)}`}
        </span>
      )}
    </div>
  );
}

/** `KeyboardEvent.code` não serve de rótulo: "Space" e "KeyF" não se leem bem. */
export function keyLabel(code: string): string {
  if (code === "Space") return "Espaço";
  if (code.startsWith("Key")) return code.slice(3);
  if (code.startsWith("Digit")) return code.slice(5);
  if (code.startsWith("Numpad")) return `Num ${code.slice(6)}`;
  return code.replace("Control", "Ctrl ").replace("Left", " esq.").replace("Right", " dir.");
}
