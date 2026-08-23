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
} from "@/components/Icons";
import { screenShareSupported } from "@/rtc/MediaManager";
import { useStore } from "@/state/store";

/** A barra flutuante da call. Mesma ordem de botões do Discord. */
export function CallControls() {
  const muted = useStore((state) => state.muted);
  const deafened = useStore((state) => state.deafened);
  const camOn = useStore((state) => state.camOn);
  const screenOn = useStore((state) => state.screenOn);
  const toggleMute = useStore((state) => state.toggleMute);
  const toggleDeafen = useStore((state) => state.toggleDeafen);
  const toggleCamera = useStore((state) => state.toggleCamera);
  const toggleScreen = useStore((state) => state.toggleScreen);
  const leaveVoice = useStore((state) => state.leaveVoice);
  const openSettings = useStore((state) => state.openSettings);

  return (
    <div className="call-controls">
      <button
        type="button"
        className="call-button"
        data-on={camOn}
        onClick={() => void toggleCamera()}
        title={camOn ? "Desligar a câmera" : "Ligar a câmera"}
        aria-pressed={camOn}
      >
        {camOn ? <CameraIcon size={22} /> : <CameraOffIcon size={22} />}
      </button>

      <button
        type="button"
        className="call-button"
        data-on={screenOn}
        onClick={() => void toggleScreen()}
        disabled={!screenShareSupported()}
        title={
          screenShareSupported()
            ? screenOn
              ? "Parar de compartilhar"
              : "Compartilhar a tela"
            : "Este navegador não permite compartilhar a tela"
        }
        aria-pressed={screenOn}
      >
        {screenOn ? <ScreenOffIcon size={22} /> : <ScreenIcon size={22} />}
      </button>

      <button
        type="button"
        className="call-button"
        data-off={muted}
        onClick={toggleMute}
        title={muted ? "Ativar microfone" : "Desativar microfone"}
        aria-pressed={muted}
      >
        {muted ? <MicOffIcon size={22} /> : <MicIcon size={22} />}
      </button>

      <button
        type="button"
        className="call-button"
        data-off={deafened}
        onClick={toggleDeafen}
        title={deafened ? "Voltar a ouvir" : "Ensurdecer"}
        aria-pressed={deafened}
      >
        {deafened ? <HeadphoneOffIcon size={22} /> : <HeadphoneIcon size={22} />}
      </button>

      <button type="button" className="call-button" onClick={openSettings} title="Configurações">
        <GearIcon size={22} />
      </button>

      <button
        type="button"
        className="call-button hangup"
        onClick={leaveVoice}
        title="Desconectar da call"
      >
        <HangUpIcon size={22} />
      </button>
    </div>
  );
}
