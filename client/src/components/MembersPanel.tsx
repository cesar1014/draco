import { useMemo } from "react";
import { Avatar } from "@/components/Avatar";
import { CloseIcon, SpeakerIcon } from "@/components/Icons";
import { useStore } from "@/state/store";
import type { Member, RosterEntry } from "@/types";

/**
 * Quem está no servidor, separado entre online e offline.
 *
 * Fica à direita e fechado por padrão. A lista de pessoas é a informação que se
 * consulta de vez em quando ("quem está aí?"), não a que se lê o tempo todo, e
 * antes ela dividia a barra da esquerda com os canais — que são navegação, usada
 * a cada minuto. Trocar de lado devolveu a coluna inteira aos canais.
 *
 * No celular é uma gaveta: a largura não dá pra três colunas, e o mesmo botão do
 * topo abre e fecha.
 */
export function MembersPanel() {
  const members = useStore((state) => state.members);
  const roster = useStore((state) => state.roster);
  const channels = useStore((state) => state.channels);
  const activeGuildId = useStore((state) => state.activeGuildId);
  const selfId = useStore((state) => state.selfId);
  const setMembersOpen = useStore((state) => state.setMembersOpen);

  /**
   * Online sai da presença; offline é o elenco do banco menos quem está online.
   * A ordem do online é a de chegada, que é estável de um jeito que a alfabética
   * não é: a identidade sobrevive à reconexão, então a lista não se reorganiza
   * embaixo do cursor de quem estava clicando quando o Wi-Fi de um terceiro caiu.
   */
  const { online, offline } = useMemo(() => {
    const present = Object.values(members).sort(
      (a, b) => a.since - b.since || a.username.localeCompare(b.username, "pt-BR"),
    );
    const connected = new Set(present.map((member) => member.id));
    const away = (roster[activeGuildId] ?? [])
      .filter((entry) => !connected.has(entry.id))
      .sort((a, b) => a.username.localeCompare(b.username, "pt-BR"));
    return { online: present, offline: away };
  }, [members, roster, activeGuildId]);

  return (
    <aside className="members" aria-label="Membros">
      <header className="members-header">
        <strong>Membros</strong>
        <button
          type="button"
          className="members-close"
          onClick={() => setMembersOpen(false)}
          title="Fechar"
        >
          <CloseIcon size={18} />
        </button>
      </header>

      <div className="members-scroll">
        {online.length > 0 && (
          <section>
            <p className="category">Online — {online.length}</p>
            <ul className="members-list">
              {online.map((member) => (
                <OnlineRow
                  key={member.id}
                  member={member}
                  self={member.id === selfId}
                  room={channels.find((channel) => channel.id === member.voiceChannelId)?.name}
                />
              ))}
            </ul>
          </section>
        )}

        {offline.length > 0 && (
          <section>
            <p className="category">Offline — {offline.length}</p>
            <ul className="members-list">
              {offline.map((entry) => (
                <OfflineRow key={entry.id} entry={entry} />
              ))}
            </ul>
          </section>
        )}

        {online.length === 0 && offline.length === 0 && (
          <p className="members-empty">Ninguém por aqui ainda.</p>
        )}
      </div>
    </aside>
  );
}

function OnlineRow({ member, self, room }: { member: Member; self: boolean; room?: string }) {
  return (
    <li className="member-row">
      <Avatar member={member} size={26} />
      <span className="member-name" data-self={self}>
        {member.username}
      </span>
      {room && (
        <em className="member-where" title={`Na call em ${room}`}>
          <SpeakerIcon size={11} />
          {room}
        </em>
      )}
    </li>
  );
}

/** Quem pertence ao servidor mas não está conectado. */
function OfflineRow({ entry }: { entry: RosterEntry }) {
  return (
    <li className="member-row" data-offline="true">
      <Avatar member={{ ...entry, speaking: false }} size={26} />
      <span className="member-name">{entry.username}</span>
    </li>
  );
}
