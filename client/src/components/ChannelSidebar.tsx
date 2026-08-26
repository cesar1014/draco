import { useMemo } from "react";
import { CloseIcon, HashIcon, SpeakerIcon } from "@/components/Icons";
import { OnlineList } from "@/components/OnlineList";
import { UserPanel } from "@/components/UserPanel";
import { VoiceChannelMembers } from "@/components/VoiceChannelMembers";
import { VoiceStrip } from "@/components/VoiceStrip";
import { useStore } from "@/state/store";
import type { Channel } from "@/types";

export function ChannelSidebar() {
  const guilds = useStore((state) => state.guilds);
  const channels = useStore((state) => state.channels);
  const activeGuildId = useStore((state) => state.activeGuildId);
  const activeChannelId = useStore((state) => state.activeChannelId);
  const voiceChannelId = useStore((state) => state.voiceChannelId);
  const selectChannel = useStore((state) => state.selectChannel);
  const joinVoice = useStore((state) => state.joinVoice);
  const setSidebarOpen = useStore((state) => state.setSidebarOpen);

  const guild = guilds.find((item) => item.id === activeGuildId);

  /** Agrupa por categoria mantendo a ordem em que o servidor mandou. */
  const groups = useMemo(() => {
    const map = new Map<string, Channel[]>();
    for (const channel of channels) {
      if (channel.guildId !== activeGuildId) continue;
      const list = map.get(channel.category) ?? [];
      list.push(channel);
      map.set(channel.category, list);
    }
    return [...map];
  }, [channels, activeGuildId]);

  return (
    <aside className="sidebar">
      <header className="sidebar-header">
        <strong>{guild?.name ?? "Servidor"}</strong>
        <button
          type="button"
          className="sidebar-close"
          onClick={() => setSidebarOpen(false)}
          title="Fechar"
        >
          <CloseIcon size={18} />
        </button>
      </header>

      <div className="channel-scroll">
        {groups.map(([category, list]) => (
          <section key={category}>
            <p className="category">{category}</p>
            {list.map((channel) => {
              const voice = channel.type === "voice";
              return (
                <div key={channel.id}>
                  <button
                    type="button"
                    className="channel"
                    data-active={channel.id === activeChannelId}
                    data-connected={channel.id === voiceChannelId}
                    onClick={() =>
                      voice && channel.id !== voiceChannelId
                        ? void joinVoice(channel.id)
                        : selectChannel(channel.id)
                    }
                  >
                    {voice ? <SpeakerIcon size={18} /> : <HashIcon size={18} />}
                    <span className="channel-name">{channel.name}</span>
                  </button>
                  {voice && <VoiceChannelMembers channelId={channel.id} />}
                </div>
              );
            })}
          </section>
        ))}
        <OnlineList />
      </div>

      <VoiceStrip />
      <UserPanel />
    </aside>
  );
}
