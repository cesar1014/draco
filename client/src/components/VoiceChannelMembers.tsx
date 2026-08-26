import { useMemo, useState } from "react";
import { Avatar } from "@/components/Avatar";
import { CameraIcon, MicOffIcon, ScreenIcon, SpeakerOffIcon } from "@/components/Icons";
import { PersonMenu } from "@/components/PersonMenu";
import { Popover } from "@/components/Popover";
import { membersInVoice, prefsFor, useStore } from "@/state/store";

/** Quem está num canal de voz, com o menu de volume por pessoa. */
export function VoiceChannelMembers({ channelId }: { channelId: string }) {
  const members = useStore((state) => state.members);
  const selfId = useStore((state) => state.selfId);
  const people = useStore((state) => state.people);
  const [openFor, setOpenFor] = useState<string | null>(null);
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);

  const present = useMemo(() => membersInVoice(members, channelId), [members, channelId]);
  if (present.length === 0) return null;

  return (
    <ul className="voice-members">
      {present.map((member) => {
        const self = member.id === selfId;
        const prefs = prefsFor(people, member.username);
        const open = openFor === member.id;

        return (
          <li key={member.id} className="voice-member" data-speaking={member.speaking}>
            <button
              type="button"
              className="voice-member-row"
              disabled={self}
              aria-expanded={open}
              onClick={(event) => {
                setAnchor(event.currentTarget);
                setOpenFor(open ? null : member.id);
              }}
              title={self ? "Você" : `Ajustar o áudio de ${member.username}`}
            >
              <Avatar member={member} size={24} />
              <span className="voice-member-name" data-self={self} data-quiet={prefs.muted}>
                {member.username}
              </span>
              <span className="voice-member-icons">
                {prefs.muted && !self && <SpeakerOffIcon size={14} />}
                {member.screenOn && <ScreenIcon size={14} />}
                {member.camOn && <CameraIcon size={14} />}
                {member.muted && <MicOffIcon size={14} />}
              </span>
            </button>

            {open && (
              <Popover anchor={anchor}>
                <PersonMenu member={member} onClose={() => setOpenFor(null)} />
              </Popover>
            )}
          </li>
        );
      })}
    </ul>
  );
}
