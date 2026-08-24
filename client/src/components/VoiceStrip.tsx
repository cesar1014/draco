import { HangUpIcon, SignalIcon } from "@/components/Icons";
import { useStore } from "@/state/store";

const STATE_LABEL: Partial<Record<RTCPeerConnectionState, string>> = {
  new: "Preparando…",
  connecting: "Conectando…",
  disconnected: "Instável",
  failed: "Falhou",
};

/** Faixa que aparece na barra lateral enquanto a call está de pé. */
export function VoiceStrip() {
  const channels = useStore((state) => state.channels);
  const voiceChannelId = useStore((state) => state.voiceChannelId);
  const peerStates = useStore((state) => state.peerStates);
  const stats = useStore((state) => state.stats);
  const leaveVoice = useStore((state) => state.leaveVoice);

  if (!voiceChannelId) return null;

  const channel = channels.find((item) => item.id === voiceChannelId);
  const states = Object.values(peerStates);
  const trouble = states.find((state) => state !== "connected" && state !== "closed");
  const samples = Object.values(stats);
  const worstRtt = samples.reduce((worst, sample) => Math.max(worst, sample.rtt ?? 0), 0);

  return (
    <div className="voice-strip">
      <div className="voice-strip-info">
        <span className="voice-strip-status" data-trouble={Boolean(trouble)}>
          <SignalIcon size={14} />
          {trouble ? (STATE_LABEL[trouble] ?? "Reconectando…") : worstRtt ? `${worstRtt} ms` : "Conectado"}
        </span>
        <span className="voice-strip-channel">{channel?.name ?? "canal de voz"}</span>
      </div>

      <div className="voice-strip-actions">
        <button type="button" className="panel-button danger" onClick={leaveVoice} title="Sair da chamada">
          <HangUpIcon size={18} />
        </button>
      </div>
    </div>
  );
}
