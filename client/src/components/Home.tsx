import { useMemo, useState, type CSSProperties, type FormEvent } from "react";
import { BrandMark, SpeakerIcon } from "@/components/Icons";
import { useStore } from "@/state/store";
import type { PresenceMode, SocialPerson } from "@/types";

type FriendsTab = "online" | "all" | "pending" | "blocked" | "add";

const PRESENCE_LABEL: Record<string, string> = {
  online: "Disponível", away: "Ausente", dnd: "Não perturbar",
  invisible: "Invisível", offline: "Offline",
};

function FriendRow({ person, kind }: {
  person: SocialPerson;
  kind: "friend" | "incoming" | "outgoing" | "blocked";
}) {
  const members = useStore((state) => state.members);
  const openDirect = useStore((state) => state.openDirect);
  const change = useStore((state) => state.changeFriendship);
  const [busy, setBusy] = useState(false);
  const member = members[person.id];
  const presence = member?.presence ?? "offline";
  const status = member?.customStatus ?? person.customStatus;

  async function act(action: "accept" | "reject" | "cancel" | "remove" | "block" | "unblock") {
    setBusy(true);
    await change(action, person.id);
    setBusy(false);
  }

  return (
    <div className="friend-row">
      <span className="friend-avatar" style={{ background: person.color }} data-presence={presence}>
        {person.displayName.slice(0, 2).toUpperCase()}
      </span>
      <span className="friend-copy">
        <strong>{person.displayName}</strong>
        <small>@{person.username} · {status || PRESENCE_LABEL[presence]}</small>
      </span>
      <span className="friend-actions">
        {kind === "friend" && <button type="button" onClick={() => void openDirect(person.id)}>Mensagem</button>}
        {kind === "friend" && <button type="button" onClick={() => void act("remove")} disabled={busy}>Remover</button>}
        {kind === "friend" && <button type="button" onClick={() => void act("block")} disabled={busy}>Bloquear</button>}
        {kind === "incoming" && <button type="button" className="primary" onClick={() => void act("accept")} disabled={busy}>Aceitar</button>}
        {kind === "incoming" && <button type="button" onClick={() => void act("reject")} disabled={busy}>Recusar</button>}
        {kind === "outgoing" && <button type="button" onClick={() => void act("cancel")} disabled={busy}>Cancelar</button>}
        {kind === "blocked" && <button type="button" onClick={() => void act("unblock")} disabled={busy}>Desbloquear</button>}
      </span>
    </div>
  );
}

export function Home() {
  const guilds = useStore((state) => state.guilds);
  const channels = useStore((state) => state.channels);
  const roster = useStore((state) => state.roster);
  const members = useStore((state) => state.members);
  const relationships = useStore((state) => state.relationships);
  const selfId = useStore((state) => state.selfId);
  const requestFriend = useStore((state) => state.requestFriend);
  const updatePresence = useStore((state) => state.updatePresence);
  const selectGuild = useStore((state) => state.selectGuild);
  const selectChannel = useStore((state) => state.selectChannel);
  const [tab, setTab] = useState<FriendsTab>("online");
  const [username, setUsername] = useState("");
  const [feedback, setFeedback] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  const self = selfId ? members[selfId] : null;

  const calls = useMemo(() => guilds.flatMap((guild) => {
    const guildMembers = new Set((roster[guild.id] ?? []).map((entry) => entry.id));
    return channels
      .filter((channel) => channel.guildId === guild.id && channel.type === "voice")
      .map((channel) => ({ guild, channel, people: Object.values(members).filter((member) =>
        member.voiceChannelId === channel.id && (guildMembers.has(member.id) || member.guestGuildId === guild.id)), }))
      .filter((call) => call.people.length > 0);
  }), [channels, guilds, members, roster]);

  const onlineFriends = relationships.friends.filter((person) => {
    const presence = members[person.id]?.presence;
    return presence && presence !== "offline";
  });

  async function add(event: FormEvent) {
    event.preventDefault();
    const error = await requestFriend(username);
    setFeedback(error ?? "Solicitação enviada.");
    if (!error) setUsername("");
  }

  async function presence(mode: PresenceMode) {
    const error = await updatePresence(mode, status || self?.customStatus || null);
    if (error) setFeedback(error);
  }

  const tabs: Array<[FriendsTab, string]> = [
    ["online", "Online"], ["all", "Todos"], ["pending", "Pendentes"],
    ["blocked", "Bloqueados"], ["add", "Adicionar amigo"],
  ];

  return (
    <section className="home-view">
      <header className="content-header home-header">
        <BrandMark size={25} /><h1>Amigos</h1>
        <nav className="friends-tabs" aria-label="Amigos">
          {tabs.map(([item, label]) => (
            <button key={item} type="button" data-active={tab === item} onClick={() => setTab(item)}>
              {label}{item === "pending" && relationships.incomingRequests.length > 0 && <b>{relationships.incomingRequests.length}</b>}
            </button>
          ))}
        </nav>
      </header>

      <div className="home-scroll">
        <div className="home-layout friends-layout">
          <main className="home-main friends-main">
            {tab === "add" ? (
              <section className="friends-add">
                <h2>Adicionar amigo</h2>
                <p>Digite o nome de usuário exato. A outra pessoa decide quando aceitar.</p>
                <form onSubmit={add}>
                  <input value={username} onChange={(event) => setUsername(event.target.value)} maxLength={32} placeholder="nome_de_usuario" autoComplete="off" />
                  <button type="submit" disabled={!username.trim()}>Enviar solicitação</button>
                </form>
                {feedback && <p className="friends-feedback" role="status">{feedback}</p>}
              </section>
            ) : (
              <section className="friends-list" aria-live="polite">
                <div className="home-section-title"><h2>{tab === "online" ? "Online" : tab === "all" ? "Todos os amigos" : tab === "pending" ? "Solicitações" : "Bloqueados"}</h2></div>
                {tab === "online" && onlineFriends.map((person) => <FriendRow key={person.id} person={person} kind="friend" />)}
                {tab === "all" && relationships.friends.map((person) => <FriendRow key={person.id} person={person} kind="friend" />)}
                {tab === "pending" && relationships.incomingRequests.map((person) => <FriendRow key={`in-${person.id}`} person={person} kind="incoming" />)}
                {tab === "pending" && relationships.outgoingRequests.map((person) => <FriendRow key={`out-${person.id}`} person={person} kind="outgoing" />)}
                {tab === "blocked" && relationships.blocked.map((person) => <FriendRow key={person.id} person={person} kind="blocked" />)}
                {((tab === "online" && onlineFriends.length === 0) || (tab === "all" && relationships.friends.length === 0) ||
                  (tab === "pending" && relationships.incomingRequests.length + relationships.outgoingRequests.length === 0) ||
                  (tab === "blocked" && relationships.blocked.length === 0)) && <p className="friends-empty">Nada por aqui agora.</p>}
              </section>
            )}
          </main>

          <aside className="home-activity" aria-label="Atividade agora">
            <div className="home-section-title"><h2>Atividade agora</h2><span>{calls.length}</span></div>
            {calls.map(({ guild, channel, people }) => (
              <button key={channel.id} type="button" className="home-call" onClick={() => { selectGuild(guild.id); selectChannel(channel.id); }}>
                <SpeakerIcon size={17} /><span><strong>{channel.name}</strong><small>{guild.name} · {people.map((person) => person.username).join(", ")}</small></span>
              </button>
            ))}
            {!calls.length && <p className="home-activity-empty">Seus amigos não estão em atividades visíveis agora.</p>}
            <div className="presence-editor">
              <label htmlFor="presence-mode">Sua presença</label>
              <select id="presence-mode" value={self?.presence === "offline" ? "invisible" : self?.presence ?? "online"} onChange={(event) => void presence(event.target.value as PresenceMode)}>
                <option value="online">Disponível</option><option value="away">Ausente</option><option value="dnd">Não perturbar</option><option value="invisible">Invisível</option>
              </select>
              <input value={status} onChange={(event) => setStatus(event.target.value)} onBlur={() => void presence((self?.presence === "offline" ? "invisible" : self?.presence ?? "online") as PresenceMode)} maxLength={128} placeholder={self?.customStatus || "Definir status"} />
            </div>
          </aside>
        </div>

        {guilds.length > 0 && <section className="home-section compact-guilds">
          <div className="home-section-title"><h2>Servidores</h2><span>{guilds.length}</span></div>
          <div className="home-guild-list">{guilds.map((guild) => <button key={guild.id} type="button" className="home-guild-card" style={{ "--guild-color": guild.color } as CSSProperties} onClick={() => selectGuild(guild.id)}><span className="home-guild-avatar">{guild.initials}</span><span className="home-guild-copy"><strong>{guild.name}</strong></span></button>)}</div>
        </section>}
      </div>
    </section>
  );
}
