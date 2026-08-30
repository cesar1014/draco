import { useRef, useState, type CSSProperties } from "react";
import { AddGuildButton } from "@/components/GuildAdmin";
import { BrandMark } from "@/components/Icons";
import { Popover } from "@/components/Popover";
import { useDismiss } from "@/hooks/useDismiss";
import { useStore } from "@/state/store";

export function GuildRail() {
  const guilds = useStore((state) => state.guilds);
  const activeGuildId = useStore((state) => state.activeGuildId);
  const selectGuild = useStore((state) => state.selectGuild);
  const permissions = useStore((state) => state.permissions);
  const account = useStore((state) => state.account);
  const selfId = useStore((state) => state.selfId);
  const openAdmin = useStore((state) => state.openAdmin);
  const leaveGuild = useStore((state) => state.leaveGuild);
  const channels = useStore((state) => state.channels);
  const unread = useStore((state) => state.unread);
  const pending = useStore((state) => state.relationships.incomingRequests.length);
  const [context, setContext] = useState<{ anchor: HTMLElement; guildId: string } | null>(null);
  const menu = useRef<HTMLDivElement>(null);
  useDismiss(menu, () => setContext(null));

  const contextGuild = guilds.find((guild) => guild.id === context?.guildId);
  const contextPermissions = context ? permissions[context.guildId] ?? [] : [];
  const canManage = account?.isSystemAdmin || contextPermissions.some((permission) =>
    ["manage_channels", "create_invites", "ban_members", "manage_roles"].includes(permission));
  const canLeave = Boolean(contextGuild && contextGuild.ownerId !== selfId && !account?.isSystemAdmin);

  return (
    <nav className="guild-rail" aria-label="Servidores">
      <button
        type="button"
        className="guild home"
        data-active={!activeGuildId}
        title="Início"
        onClick={() => useStore.setState({ activeGuildId: "", activeChannelId: "", activeDirectId: "" })}
      >
        <BrandMark size={34} />
        {pending > 0 && <span className="guild-unread-badge">{pending}</span>}
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
            onContextMenu={(event) => {
              event.preventDefault();
              setContext({ anchor: event.currentTarget, guildId: guild.id });
            }}
            title={guild.name}
          >
            {guild.initials}
          </button>
          {channels.some((channel) => channel.guildId === guild.id && unread[`channel:${channel.id}`]?.unread) && <span className="guild-unread-dot" />}
        </span>
      ))}

      <AddGuildButton />

      <Popover anchor={context?.anchor ?? null} width={210}>
        <div ref={menu} className="person-menu navigation-menu" role="menu">
          <strong>{contextGuild?.name}</strong>
          <button type="button" role="menuitem" onClick={() => { if (context) void openAdmin(context.guildId); setContext(null); }}>
            {canManage ? "Configurações do servidor" : "Detalhes do servidor"}
          </button>
          {canLeave && <button type="button" role="menuitem" className="danger" onClick={() => {
            if (!context) return;
            void leaveGuild(context.guildId).then((error) => { if (error) useStore.setState({ mediaError: error }); });
            setContext(null);
          }}>Sair do servidor</button>}
        </div>
      </Popover>
    </nav>
  );
}
