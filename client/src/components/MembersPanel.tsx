import { useMemo } from "react";
import { Avatar } from "@/components/Avatar";
import { CameraIcon, CloseIcon, HeadphoneOffIcon, MicOffIcon, ScreenIcon, SpeakerIcon } from "@/components/Icons";
import { useStore } from "@/state/store";
import type { Member, Role, RosterEntry } from "@/types";

const NO_ROLES: Role[] = [];
const NO_MEMBER_ROLES: Record<string, string[]> = {};

export function MembersPanel() {
  const members = useStore((state) => state.members);
  const roster = useStore((state) => state.roster);
  const channels = useStore((state) => state.channels);
  const activeGuildId = useStore((state) => state.activeGuildId);
  const roles = useStore((state) => state.roles[activeGuildId] ?? NO_ROLES);
  const assignments = useStore((state) => state.memberRoles[activeGuildId] ?? NO_MEMBER_ROLES);
  const selfId = useStore((state) => state.selfId);
  const setMembersOpen = useStore((state) => state.setMembersOpen);
  const account = useStore((state) => state.account);
  const openDirect = useStore((state) => state.openDirect);

  const { groups, offline } = useMemo(() => {
    const rosterIds = new Set((roster[activeGuildId] ?? []).map((entry) => entry.id));
    const present = Object.values(members)
      .filter((member) => rosterIds.has(member.id) || (member.guest && member.guestGuildId === activeGuildId))
      .sort((a, b) => a.since - b.since || a.username.localeCompare(b.username, "pt-BR"));
    const connected = new Set(present.map((member) => member.id));
    const away = (roster[activeGuildId] ?? [])
      .filter((entry) => !connected.has(entry.id))
      .sort((a, b) => a.username.localeCompare(b.username, "pt-BR"));

    const orderedRoles = [...roles].sort((left, right) => right.position - left.position);
    const defaultRole = orderedRoles.find((role) => role.isDefault);
    const guestRole: Role = {
      id: "guests",
      guildId: activeGuildId,
      name: "Visitantes",
      color: null,
      permissions: [],
      isDefault: false,
      position: -1,
    };
    const roleFor = (member: Member) => {
      if (member.guest) return guestRole;
      const ids = assignments[member.id] ?? [];
      return orderedRoles.find((role) => !role.isDefault && ids.includes(role.id)) ?? defaultRole;
    };
    const grouped = new Map<string, { role: Role | null; people: Member[] }>();
    for (const member of present) {
      const role = roleFor(member) ?? null;
      const key = role?.id ?? "members";
      const group = grouped.get(key) ?? { role, people: [] };
      group.people.push(member);
      grouped.set(key, group);
    }
    return {
      groups: [...grouped.values()].sort((left, right) =>
        (right.role?.position ?? -2) - (left.role?.position ?? -2)),
      offline: away,
    };
  }, [members, roster, roles, assignments, activeGuildId]);

  const startDirect = (userId: string) => {
    if (!account?.guest) void openDirect(userId);
  };

  return (
    <aside className="members" aria-label="Membros deste servidor">
      <header className="members-header">
        <strong>Membros</strong>
        <button type="button" className="members-close" onClick={() => setMembersOpen(false)} title="Fechar">
          <CloseIcon size={18} />
        </button>
      </header>

      <div className="members-scroll">
        {groups.map(({ role, people }) => (
          <section key={role?.id ?? "members"}>
            <p className="category member-role-heading" style={{ color: role?.color ?? undefined }}>
              {role?.isDefault ? "Online" : role?.name ?? "Online"} — {people.length}
            </p>
            <ul className="members-list">
              {people.map((member) => (
                <OnlineRow
                  key={member.id}
                  member={member}
                  self={member.id === selfId}
                  room={channels.find((channel) => channel.id === member.voiceChannelId)?.name}
                  onDirect={member.guest ? undefined : () => startDirect(member.id)}
                />
              ))}
            </ul>
          </section>
        ))}

        {offline.length > 0 && (
          <section>
            <p className="category">Offline — {offline.length}</p>
            <ul className="members-list">
              {offline.map((entry) => (
                <OfflineRow key={entry.id} entry={entry} onDirect={() => startDirect(entry.id)} />
              ))}
            </ul>
          </section>
        )}

        {groups.length === 0 && offline.length === 0 && <p className="members-empty">Ninguém por aqui ainda.</p>}
      </div>
    </aside>
  );
}

function OnlineRow({ member, self, room, onDirect }: { member: Member; self: boolean; room?: string; onDirect?: () => void }) {
  return (
    <li className="member-row" title={onDirect ? "Abrir mensagem privada" : undefined}>
      <button type="button" className="member-row-button" disabled={!onDirect} onClick={onDirect}>
        <Avatar member={member} size={28} />
        <span className="member-copy">
          <span className="member-name" data-self={self}>{member.username}{member.guest ? " · visitante" : ""}</span>
          {room && <em className="member-where"><SpeakerIcon size={11} />{room}</em>}
        </span>
        <span className="member-state-icons" aria-label="Estado na chamada">
          {member.muted && <MicOffIcon size={12} />}
          {member.deafened && <HeadphoneOffIcon size={12} />}
          {member.camOn && <CameraIcon size={12} />}
          {member.screenOn && <ScreenIcon size={12} />}
        </span>
      </button>
    </li>
  );
}

function OfflineRow({ entry, onDirect }: { entry: RosterEntry; onDirect: () => void }) {
  return (
    <li className="member-row" data-offline="true">
      <button type="button" className="member-row-button" onClick={onDirect} title="Abrir mensagem privada">
        <Avatar member={{ ...entry, speaking: false }} size={28} />
        <span className="member-name">{entry.username}</span>
      </button>
    </li>
  );
}
