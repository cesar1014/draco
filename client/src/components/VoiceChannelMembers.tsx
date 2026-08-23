import { useMemo } from "react";
import { Avatar } from "@/components/Avatar";
import { CameraIcon, HeadphoneOffIcon, MicOffIcon, ScreenIcon } from "@/components/Icons";
import { membersInVoice, useStore } from "@/state/store";

/**
 * Quem está dentro de um canal de voz, aninhado sob ele na lista de canais.
 *
 * Os ícones de mudo e de ensurdecido vêm do estado que o servidor repassa, não
 * de inspeção da mídia recebida: é o que faz o ícone aparecer no mesmo instante
 * do clique da outra pessoa, e é o que permite mostrar isso pra quem está lendo
 * o chat e nem entrou na call.
 */
export function VoiceChannelMembers({ channelId }: { channelId: string }) {
  const members = useStore((state) => state.members);
  const selfId = useStore((state) => state.selfId);

  // `membersInVoice` cria um array novo a cada chamada; fora do selector, senão
  // o zustand veria uma referência nova em cada notificação e nunca pararia.
  const present = useMemo(() => membersInVoice(members, channelId), [members, channelId]);
  if (present.length === 0) return null;

  return (
    <ul className="voice-members">
      {present.map((member) => (
        <li key={member.id} className="voice-member">
          <Avatar member={member} size={24} ring />
          <span className="voice-member-name" data-self={member.id === selfId}>
            {member.username}
          </span>
          <span className="voice-member-icons">
            {member.screenOn && (
              <span title="Compartilhando a tela">
                <ScreenIcon size={15} />
              </span>
            )}
            {member.camOn && (
              <span title="Câmera ligada">
                <CameraIcon size={15} />
              </span>
            )}
            {member.deafened ? (
              <span title="Ensurdecido" className="danger">
                <HeadphoneOffIcon size={15} />
              </span>
            ) : (
              member.muted && (
                <span title="Sem microfone" className="danger">
                  <MicOffIcon size={15} />
                </span>
              )
            )}
          </span>
        </li>
      ))}
    </ul>
  );
}
