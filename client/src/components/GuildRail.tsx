import type { CSSProperties } from "react";
import { BrandMark } from "@/components/Icons";
import { useStore } from "@/state/store";

export function GuildRail() {
  const guilds = useStore((state) => state.guilds);
  const activeGuildId = useStore((state) => state.activeGuildId);
  const selectGuild = useStore((state) => state.selectGuild);

  return (
    <nav className="guild-rail" aria-label="Servidores">
      <span className="guild home" title="Draco">
        <BrandMark size={34} />
      </span>

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
    </nav>
  );
}
