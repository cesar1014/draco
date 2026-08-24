import { Avatar } from "@/components/Avatar";
import {
  GearIcon,
  HeadphoneIcon,
  HeadphoneOffIcon,
  MicIcon,
  MicOffIcon,
} from "@/components/Icons";
import { useStore } from "@/state/store";

/** Rodapé da barra lateral: quem você é e os botões de microfone e ouvido. */
export function UserPanel() {
  const selfId = useStore((state) => state.selfId);
  const members = useStore((state) => state.members);
  const muted = useStore((state) => state.muted);
  const deafened = useStore((state) => state.deafened);
  const voiceChannelId = useStore((state) => state.voiceChannelId);
  const toggleMute = useStore((state) => state.toggleMute);
  const toggleDeafen = useStore((state) => state.toggleDeafen);
  const openSettings = useStore((state) => state.openSettings);

  const self = selfId ? members[selfId] : null;
  if (!self) return null;

  return (
    <div className="user-panel">
      <div className="user-identity">
        <Avatar member={self} size={34} />
        <div className="user-text">
          <strong>{self.username}</strong>
          <span>{voiceChannelId ? "em chamada" : "disponível"}</span>
        </div>
      </div>

      <div className="user-actions">
        <button
          type="button"
          className="panel-button"
          data-off={muted}
          onClick={toggleMute}
          title="Microfone (Ctrl+Shift+M)"
        >
          {muted ? <MicOffIcon size={18} /> : <MicIcon size={18} />}
        </button>
        <button
          type="button"
          className="panel-button"
          data-off={deafened}
          onClick={toggleDeafen}
          title="Ouvido (Ctrl+Shift+D)"
        >
          {deafened ? <HeadphoneOffIcon size={18} /> : <HeadphoneIcon size={18} />}
        </button>
        <button type="button" className="panel-button" onClick={openSettings} title="Configurações">
          <GearIcon size={18} />
        </button>
      </div>
    </div>
  );
}
