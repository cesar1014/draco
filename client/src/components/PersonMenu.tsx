import { useRef } from "react";
import { Avatar } from "@/components/Avatar";
import { ScreenIcon, SpeakerIcon, SpeakerOffIcon } from "@/components/Icons";
import { useDismiss } from "@/hooks/useDismiss";
import { statsGrade } from "@/rtc/stats";
import { MAX_PERSON_VOLUME, prefsFor, useStore } from "@/state/store";
import type { GuildPermission, Member, Role } from "@/types";

const NO_ROLES: Role[] = [];
const NO_ROLE_IDS: string[] = [];
const NO_PERMISSIONS: GuildPermission[] = [];

/**
 * Volume e mute de uma pessoa só, pra quem está ouvindo. Nada disso viaja pela
 * rede: é o `<audio>` local que muda, então a outra pessoa não fica sabendo.
 * Microfone e transmissão de tela têm controles separados, porque o jogo alto de
 * alguém não é motivo pra deixar de ouvir a pessoa.
 */
export function PersonMenu({ member, onClose }: { member: Member; onClose: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  const people = useStore((state) => state.people);
  const stats = useStore((state) => state.stats[member.id]);
  const showStats = useStore((state) => state.settings.showStats);
  const watching = useStore((state) => state.watching[`${member.id}:screen`]);
  const setPersonVolume = useStore((state) => state.setPersonVolume);
  const togglePersonMuted = useStore((state) => state.togglePersonMuted);
  const setScreenVolume = useStore((state) => state.setScreenVolume);
  const toggleScreenMuted = useStore((state) => state.toggleScreenMuted);
  const resetPerson = useStore((state) => state.resetPerson);
  const selfId = useStore((state) => state.selfId);
  const activeGuildId = useStore((state) => state.activeGuildId);
  const guild = useStore((state) => state.guilds.find((item) => item.id === state.activeGuildId));
  const permissions = useStore((state) => state.permissions[state.activeGuildId] ?? NO_PERMISSIONS);
  const account = useStore((state) => state.account);
  const roles = useStore((state) => state.roles[activeGuildId] ?? NO_ROLES);
  const memberRoleIds = useStore((state) => state.memberRoles[activeGuildId]?.[member.id] ?? NO_ROLE_IDS);
  const relationships = useStore((state) => state.relationships);
  const openDirect = useStore((state) => state.openDirect);
  const requestFriend = useStore((state) => state.requestFriend);
  const changeFriendship = useStore((state) => state.changeFriendship);
  const kickMember = useStore((state) => state.kickMember);
  const banMember = useStore((state) => state.banMember);

  useDismiss(box, onClose);

  const prefs = prefsFor(people, member.username);
  const percent = Math.round(prefs.volume * 100);
  const screenPercent = Math.round(prefs.screenVolume * 100);
  const boosted = percent > 100;
  const untouched = !prefs.muted && !prefs.screenMuted && percent === 100 && screenPercent === 100;
  const mine = member.id === selfId;
  const friend = relationships.friends.some((person) => person.id === member.id);
  const incoming = relationships.incomingRequests.some((person) => person.id === member.id);
  const outgoing = relationships.outgoingRequests.some((person) => person.id === member.id);
  const blocked = relationships.blocked.some((person) => person.id === member.id);
  const visibleRoles = roles.filter((role) => memberRoleIds.includes(role.id) && !role.isDefault);
  const myRoleIds = useStore((state) => state.memberRoles[activeGuildId]?.[selfId ?? ""] ?? NO_ROLE_IDS);
  const highest = (ids: string[]) => Math.max(0, ...roles.filter((role) => ids.includes(role.id)).map((role) => role.position));
  const canAct = member.id !== guild?.ownerId && (
    account?.isSystemAdmin === true || selfId === guild?.ownerId || highest(myRoleIds) > highest(memberRoleIds)
  );
  const canKick = !mine && canAct && (permissions.includes("moderate_members") || selfId === guild?.ownerId || account?.isSystemAdmin === true);
  const canBan = !mine && canAct && (permissions.includes("ban_members") || selfId === guild?.ownerId || account?.isSystemAdmin === true);

  const moderate = async (action: "kick" | "ban") => {
    const label = action === "ban" ? "banir" : "expulsar";
    if (!window.confirm(`Deseja realmente ${label} ${member.username} deste servidor?`)) return;
    const reason = window.prompt("Motivo (opcional):");
    if (reason === null) return;
    const error = action === "ban"
      ? await banMember(member.id, reason.trim() || undefined)
      : await kickMember(member.id, reason.trim() || undefined);
    if (error) window.alert(error);
    else onClose();
  };

  return (
    <div className="person-menu" ref={box} role="dialog" aria-label={`Áudio de ${member.username}`}>
      <header>
        <Avatar member={member} size={36} />
        <div>
          <strong>{member.username}</strong>
          <em data-boost={boosted}>
            {prefs.muted ? "Silenciado para você" : `Volume ${percent}%`}
          </em>
        </div>
      </header>

      <div className="person-profile-meta">
        <span data-presence={member.presence}>{member.presence === "dnd" ? "Não perturbe" : member.presence === "away" ? "Ausente" : member.presence === "offline" ? "Offline" : "Online"}</span>
        {member.customStatus && <p>{member.customStatus}</p>}
        <small>No servidor desde {new Intl.DateTimeFormat("pt-BR").format(member.since)}</small>
        {visibleRoles.length > 0 && <div className="person-role-chips">{visibleRoles.map((role) => <span key={role.id} style={{ borderColor: role.color ?? undefined }}>{role.name}</span>)}</div>}
      </div>

      {!mine && <div className="person-social-actions">
        <button type="button" className="person-button" onClick={() => void openDirect(member.id).then(() => onClose())}>Mensagem</button>
        {!friend && !incoming && !outgoing && !blocked && <button type="button" className="person-button" onClick={() => void requestFriend(member.username)}>Adicionar amigo</button>}
        {incoming && <button type="button" className="person-button" onClick={() => void changeFriendship("accept", member.id)}>Aceitar amizade</button>}
        {outgoing && <button type="button" className="person-button" onClick={() => void changeFriendship("cancel", member.id)}>Cancelar pedido</button>}
        {friend && <button type="button" className="person-button" onClick={() => void changeFriendship("remove", member.id)}>Remover amigo</button>}
        <button type="button" className="person-button" data-on={blocked} onClick={() => void changeFriendship(blocked ? "unblock" : "block", member.id)}>{blocked ? "Desbloquear" : "Bloquear"}</button>
      </div>}

      <label className="person-volume" data-boost={boosted} data-muted={prefs.muted}>
        <span>
          Microfone
          <b>{prefs.muted ? "mudo" : `${percent}%`}</b>
        </span>
        <input
          type="range"
          className="range-boost"
          min={0}
          max={MAX_PERSON_VOLUME * 100}
          step={5}
          value={percent}
          disabled={prefs.muted}
          onChange={(event) => setPersonVolume(member.username, Number(event.target.value) / 100)}
        />
      </label>

      {member.screenOn && (
        <label
          className="person-volume"
          data-boost={screenPercent > 100}
          data-muted={prefs.screenMuted}
        >
          <span>
            <ScreenIcon size={12} /> Transmissão
            <b>{prefs.screenMuted ? "mudo" : `${screenPercent}%`}</b>
          </span>
          <input
            type="range"
            className="range-boost"
            min={0}
            max={MAX_PERSON_VOLUME * 100}
            step={5}
            value={screenPercent}
            disabled={prefs.screenMuted}
            onChange={(event) => setScreenVolume(member.username, Number(event.target.value) / 100)}
          />
          {!watching && <em className="person-note">O som começa quando você abre a tela.</em>}
        </label>
      )}

      <div className="person-actions">
        <button
          type="button"
          className="person-button"
          data-on={prefs.muted}
          onClick={() => togglePersonMuted(member.username)}
        >
          {prefs.muted ? <SpeakerOffIcon size={16} /> : <SpeakerIcon size={16} />}
          {prefs.muted ? "Ouvir de novo" : "Silenciar para mim"}
        </button>
        {member.screenOn && (
          <button
            type="button"
            className="person-button"
            data-on={prefs.screenMuted}
            onClick={() => toggleScreenMuted(member.username)}
          >
            <ScreenIcon size={16} />
            {prefs.screenMuted ? "Ouvir a transmissão" : "Silenciar a transmissão"}
          </button>
        )}
        <button
          type="button"
          className="person-button"
          onClick={() => resetPerson(member.username)}
          disabled={untouched}
        >
          Padrão
        </button>
      </div>

      {(canKick || canBan) && (
        <div className="person-moderation-actions">
          {canKick && <button type="button" className="person-button danger" onClick={() => void moderate("kick")}>Expulsar do servidor</button>}
          {canBan && <button type="button" className="person-button danger" onClick={() => void moderate("ban")}>Banir do servidor</button>}
        </div>
      )}

      {showStats && (
        <ul className="person-stats" data-grade={statsGrade(stats)}>
          <li>
            <span>Recebendo</span>
            <b>{stats ? `${stats.down} kb/s` : "—"}</b>
          </li>
          <li>
            <span>Latência</span>
            <b>{stats?.rtt != null ? `${stats.rtt} ms` : "—"}</b>
          </li>
          <li>
            <span>Perda</span>
            <b>{stats ? `${stats.loss}%` : "—"}</b>
          </li>
          {stats?.height ? (
            <li>
              <span>Vídeo</span>
              <b>
                {stats.width}×{stats.height} · {stats.fps} fps
              </b>
            </li>
          ) : null}
        </ul>
      )}
    </div>
  );
}
