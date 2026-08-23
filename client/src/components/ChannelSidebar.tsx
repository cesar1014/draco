import { useMemo } from "react";
import { HashIcon, SpeakerIcon } from "@/components/Icons";
import { VoiceChannelMembers } from "@/components/VoiceChannelMembers";
import { VoiceStrip } from "@/components/VoiceStrip";
import { UserPanel } from "@/components/UserPanel";
import { useStore } from "@/state/store";
import type { Channel } from "@/types";

/**
 * Lista de canais do servidor ativo, agrupada por categoria na ordem em que o
 * servidor manda — a ordem é a definição, então nada é reordenado aqui.
 */
export function ChannelSidebar() {
  const guilds = useStore((state) => state.guilds);
  const channels = useStore((state) => state.channels);
  const activeGuildId = useStore((state) => state.activeGuildId);
  const activeChannelId = useStore((state) => state.activeChannelId);
  const voiceChannelId = useStore((state) => state.voiceChannelId);
  const selectChannel = useStore((state) => state.selectChannel);
  const joinVoice = useStore((state) => state.joinVoice);

  const guild = guilds.find((item) => item.id === activeGuildId);

  const categories = useMemo(() => {
    const map = new Map<string, Channel[]>();
    for (const channel of channels) {
      if (channel.guildId !== activeGuildId) continue;
      const list = map.get(channel.category) ?? [];
      list.push(channel);
      map.set(channel.category, list);
    }
    return [...map];
  }, [channels, activeGuildId]);

  function activate(channel: Channel) {
    // Clicar num canal de voz onde já se está não reentra: reentrar refaria
    // todas as conexões e cortaria o áudio de todo mundo por um instante.
    if (channel.type === "text" || channel.id === voiceChannelId) {
      selectChannel(channel.id);
      return;
    }
    void joinVoice(channel.id);
  }

  return (
    <div className="sidebar">
      <header className="sidebar-header">
        <span>{guild?.name ?? "Servidor"}</span>
      </header>

      <div className="channel-scroll">
        {categories.map(([category, list]) => (
          <section key={category} className="category">
            <h2>{category}</h2>
            {list.map((channel) => {
              const active = channel.id === activeChannelId;
              const connected = channel.id === voiceChannelId;
              return (
                <div key={channel.id}>
                  <button
                    type="button"
                    className="channel"
                    data-active={active}
                    data-connected={connected}
                    onClick={() => activate(channel)}
                  >
                    {channel.type === "text" ? <HashIcon size={20} /> : <SpeakerIcon size={20} />}
                    <span className="channel-name">{channel.name}</span>
                  </button>
                  {channel.type === "voice" && <VoiceChannelMembers channelId={channel.id} />}
                </div>
              );
            })}
          </section>
        ))}
      </div>

      <VoiceStrip />
      <UserPanel />
    </div>
  );
}
