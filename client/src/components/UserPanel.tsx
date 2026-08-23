import { Avatar } from "@/components/Avatar";
import { GearIcon, HeadphoneIcon, HeadphoneOffIcon, MicIcon, MicOffIcon } from "@/components/Icons";
import { useStore } from "@/state/store";

/**
 * O painel de baixo à esquerda. Os dois botões daqui funcionam mesmo fora da
 * call: a intenção de mudo é guardada e aplicada na hora em que se entra, que é
 * como o Discord se comporta — quem entra mudo espera continuar mudo.
 */
export function UserPanel() {
  const member = useStore((state) => (state.selfId ? state.members[state.selfId] : null));
  const muted = useStore((state) => state.muted);
  const deafened = useStore((state) => state.deafened);
  const toggleMute = useStore((state) => state.toggleMute);
  const toggleDeafen = useStore((state) => state.toggleDeafen);
  const openSettings = useStore((state) => state.openSettings);

  if (!member) return null;

  return (
    <div className="user-panel">
      <div className="user-identity">
        <Avatar member={member} size={32} ring />
        <div className="user-text">
          <strong>{member.username}</strong>
          <span>{deafened ? "Ensurdecido" : muted ? "Sem microfone" : "Disponível"}</span>
        </div>
      </div>

      <div className="user-actions">
        <button
          type="button"
          className="panel-button"
          data-off={muted}
          onClick={toggleMute}
          title={muted ? "Ativar microfone" : "Desativar microfone"}
          aria-pressed={muted}
        >
          {muted ? <MicOffIcon /> : <MicIcon />}
        </button>
        <button
          type="button"
          className="panel-button"
          data-off={deafened}
          onClick={toggleDeafen}
          title={deafened ? "Voltar a ouvir" : "Ensurdecer"}
          aria-pressed={deafened}
        >
          {deafened ? <HeadphoneOffIcon /> : <HeadphoneIcon />}
        </button>
        <button
          type="button"
          className="panel-button"
          onClick={openSettings}
          title="Configurações de voz e vídeo"
        >
          <GearIcon />
        </button>
      </div>
    </div>
  );
}
