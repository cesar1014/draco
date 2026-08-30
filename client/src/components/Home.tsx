import type { CSSProperties } from "react";
import { BrandMark, HashIcon } from "@/components/Icons";
import { useStore } from "@/state/store";

/**
 * Ponto de chegada da logo. Presença continua isolada por servidor: cada cartão
 * conta somente pessoas que pertencem àquele servidor, nunca uma lista global.
 */
export function Home() {
  const guilds = useStore((state) => state.guilds);
  const roster = useStore((state) => state.roster);
  const members = useStore((state) => state.members);
  const directThreads = useStore((state) => state.directThreads);
  const selectGuild = useStore((state) => state.selectGuild);
  const selectDirect = useStore((state) => state.selectDirect);

  return (
    <section className="home-view">
      <header className="content-header home-header">
        <BrandMark size={27} />
        <h1>Início</h1>
      </header>

      <div className="home-scroll">
        <div className="home-hero">
          <BrandMark size={54} />
          <div>
            <h2>Bem-vindo ao Draco</h2>
            <p>Entre em um servidor ou continue uma conversa recente.</p>
          </div>
        </div>

        <section className="home-section" aria-labelledby="home-guilds">
          <div className="home-section-title">
            <h2 id="home-guilds">Seus servidores</h2>
            <span>{guilds.length}</span>
          </div>
          <div className="home-guild-grid">
            {guilds.map((guild) => {
              const guildIds = new Set((roster[guild.id] ?? []).map((entry) => entry.id));
              const online = Object.values(members).filter(
                (member) => guildIds.has(member.id) || (member.guest && member.guestGuildId === guild.id),
              ).length;
              return (
                <button
                  key={guild.id}
                  type="button"
                  className="home-guild-card"
                  style={{ "--guild-color": guild.color } as CSSProperties}
                  onClick={() => selectGuild(guild.id)}
                >
                  <span className="home-guild-avatar">{guild.initials}</span>
                  <span className="home-guild-copy">
                    <strong>{guild.name}</strong>
                    <small>{online} {online === 1 ? "pessoa online" : "pessoas online"} neste servidor</small>
                  </span>
                  <span className="home-card-arrow" aria-hidden="true">›</span>
                </button>
              );
            })}
          </div>
        </section>

        <section className="home-section" aria-labelledby="home-directs">
          <div className="home-section-title">
            <h2 id="home-directs">Conversas recentes</h2>
            <span>{directThreads.length}</span>
          </div>
          {directThreads.length > 0 ? (
            <div className="home-direct-list">
              {directThreads.slice(0, 8).map((thread) => (
                <button
                  key={thread.id}
                  type="button"
                  className="home-direct-card"
                  onClick={() => void selectDirect(thread.id)}
                >
                  <span className="direct-avatar" style={{ background: thread.peer.color }}>
                    {thread.peer.username.slice(0, 2).toUpperCase()}
                  </span>
                  <span className="home-guild-copy">
                    <strong>{thread.peer.username}</strong>
                    <small>{thread.lastContent ?? "Abra para conversar"}</small>
                  </span>
                </button>
              ))}
            </div>
          ) : (
            <div className="home-empty-card">
              <HashIcon size={28} />
              <p>Abra um servidor e clique em uma pessoa para iniciar uma conversa.</p>
            </div>
          )}
        </section>
      </div>
    </section>
  );
}
