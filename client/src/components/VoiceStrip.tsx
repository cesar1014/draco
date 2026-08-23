import { HangUpIcon, ScreenIcon, ScreenOffIcon } from "@/components/Icons";
import { screenShareSupported } from "@/rtc/MediaManager";
import { useStore } from "@/state/store";

/**
 * A tarja de voz acima do painel do usuário. Existe pelo mesmo motivo que no
 * Discord: dentro de uma call é comum ir ler outro canal, e sem isso não haveria
 * como saber que ainda se está conectado — nem como sair sem voltar pro canal.
 */
export function VoiceStrip() {
  const voiceChannelId = useStore((state) => state.voiceChannelId);
  const channels = useStore((state) => state.channels);
  const guilds = useStore((state) => state.guilds);
  const peerStates = useStore((state) => state.peerStates);
  const screenOn = useStore((state) => state.screenOn);
  const activeChannelId = useStore((state) => state.activeChannelId);
  const selectChannel = useStore((state) => state.selectChannel);
  const toggleScreen = useStore((state) => state.toggleScreen);
  const leaveVoice = useStore((state) => state.leaveVoice);

  if (!voiceChannelId) return null;

  const channel = channels.find((item) => item.id === voiceChannelId);
  const guild = guilds.find((item) => item.id === channel?.guildId);

  // Uma conexão ruim entre muitas boas já é motivo de aviso: em malha, o par com
  // problema é exatamente a pessoa que sumiu do áudio.
  const trouble = Object.values(peerStates).some(
    (state) => state === "connecting" || state === "disconnected" || state === "failed",
  );

  return (
    <div className="voice-strip">
      <button
        type="button"
        className="voice-strip-info"
        onClick={() => selectChannel(voiceChannelId)}
        disabled={activeChannelId === voiceChannelId}
        title="Ver a call"
      >
        <span className="voice-strip-status" data-trouble={trouble}>
          {trouble ? "Conexão instável" : "Voz conectada"}
        </span>
        <span className="voice-strip-channel">
          {channel?.name ?? "Canal"} / {guild?.name ?? "Servidor"}
        </span>
      </button>

      <div className="voice-strip-actions">
        <button
          type="button"
          className="panel-button"
          data-on={screenOn}
          onClick={() => void toggleScreen()}
          disabled={!screenShareSupported()}
          title={screenOn ? "Parar de compartilhar a tela" : "Compartilhar a tela"}
        >
          {screenOn ? <ScreenOffIcon /> : <ScreenIcon />}
        </button>
        <button
          type="button"
          className="panel-button danger"
          onClick={leaveVoice}
          title="Desconectar da call"
        >
          <HangUpIcon />
        </button>
      </div>
    </div>
  );
}
