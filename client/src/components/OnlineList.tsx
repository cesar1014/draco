import { useMemo } from "react";
import { Avatar } from "@/components/Avatar";
import { SpeakerIcon } from "@/components/Icons";
import { useStore } from "@/state/store";

/** Todo mundo conectado ao servidor, na call ou só no chat. */
export function OnlineList() {
  const members = useStore((state) => state.members);
  const channels = useStore((state) => state.channels);
  const selfId = useStore((state) => state.selfId);

  const online = useMemo(
    () => Object.values(members).sort((a, b) => a.username.localeCompare(b.username, "pt-BR")),
    [members],
  );

  if (online.length === 0) return null;

  return (
    <section className="online">
      <p className="category">Online — {online.length}</p>
      <ul className="online-list">
        {online.map((member) => {
          const room = channels.find((channel) => channel.id === member.voiceChannelId);
          return (
            <li key={member.id} className="online-row">
              <Avatar member={member} size={22} />
              <span className="online-name" data-self={member.id === selfId}>
                {member.username}
              </span>
              {room && (
                <em className="online-where" title={`Na call em ${room.name}`}>
                  <SpeakerIcon size={11} />
                  {room.name}
                </em>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
