import { DiscordIcon } from "@/components/Icons";
import { useStore } from "@/state/store";

/**
 * A coluna de servidores. Aqui os "servidores" são fixos e vêm do
 * `server/state.js` — não há criação de servidor neste clone —, então o papel
 * dela é dar a estrutura visual e trocar a lista de canais ao lado.
 */
export function GuildRail() {
  const guilds = useStore((state) => state.guilds);
  const activeGuildId = useStore((state) => state.activeGuildId);
  const selectGuild = useStore((state) => state.selectGuild);

  return (
    <nav className="guild-rail" aria-label="Servidores">
      <button type="button" className="guild home" title="Início" aria-label="Início">
        <DiscordIcon size={28} />
      </button>

      <div className="guild-divider" />

      {guilds.map((guild) => {
        const active = guild.id === activeGuildId;
        return (
          <div key={guild.id} className="guild-slot">
            <span className="guild-pill" data-active={active} />
            <button
              type="button"
              className="guild"
              data-active={active}
              style={active ? { background: guild.color } : undefined}
              onClick={() => selectGuild(guild.id)}
              title={guild.name}
              aria-label={guild.name}
              aria-current={active}
            >
              {guild.initials}
            </button>
          </div>
        );
      })}
    </nav>
  );
}
