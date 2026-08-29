import type { CSSProperties } from "react";
import { AddGuildButton } from "@/components/GuildAdmin";
import { BrandMark } from "@/components/Icons";
import { useStore } from "@/state/store";

export function GuildRail() {
  const guilds = useStore((state) => state.guilds);
  const activeGuildId = useStore((state) => state.activeGuildId);
  const selectGuild = useStore((state) => state.selectGuild);
  const directThreads = useStore((state) => state.directThreads);

  return (
    <nav className="guild-rail" aria-label="Servidores">
      <button
        type="button"
        className="guild home"
        data-active={!activeGuildId}
        title="Mensagens privadas"
        onClick={() => useStore.setState({ activeGuildId: "", activeChannelId: "", activeDirectId: directThreads[0]?.id ?? "" })}
      >
        <BrandMark size={34} />
      </button>

      <span className="guild-divider" />

      {guilds.map((guild) => (
        <span key={guild.id} className="guild-slot">
          <span className="guild-pill" data-active={guild.id === activeGuildId} />
          <button
            type="button"
            className="guild"
            data-active={guild.id === activeGuildId}
            style={{ "--guild-color": guild.color } as CSSProperties}
            onClick={() => selectGuild(guild.id)}
            title={guild.name}
          >
            {guild.initials}
          </button>
        </span>
      ))}

      <AddGuildButton />
    </nav>
  );
}
