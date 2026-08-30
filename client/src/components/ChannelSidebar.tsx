import { useMemo, useState } from "react";
import { ChannelCreateModal } from "@/components/GuildAdmin";
import { BrandMark, CloseIcon, GearIcon, HashIcon, PlusIcon, SpeakerIcon, TrashIcon } from "@/components/Icons";
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
  const selfId = useStore((state) => state.selfId);
  const selectChannel = useStore((state) => state.selectChannel);
  const joinVoice = useStore((state) => state.joinVoice);
  const setSidebarOpen = useStore((state) => state.setSidebarOpen);
  const openAdmin = useStore((state) => state.openAdmin);
  const deleteChannel = useStore((state) => state.deleteChannel);
  const directThreads = useStore((state) => state.directThreads);
  const activeDirectId = useStore((state) => state.activeDirectId);
  const selectDirect = useStore((state) => state.selectDirect);
  const openDirect = useStore((state) => state.openDirect);
  const permissions = useStore((state) => state.permissions[activeGuildId] ?? []);
  const systemAdmin = useStore((state) => state.account?.isSystemAdmin === true);

  const [creating, setCreating] = useState(false);

  const guild = guilds.find((item) => item.id === activeGuildId);
  /**
   * Todo servidor tem dono, porque todo servidor nasce de alguém criando. Um que
   * ficou sem dono — o perfil dele deixou de existir — não é administrável por
   * ninguém, e os controles simplesmente não aparecem.
   */
  const managed = Boolean(guild && (systemAdmin || permissions.some((permission) => ["manage_channels", "create_invites", "ban_members", "manage_roles"].includes(permission))));
  const owner = Boolean(guild && (systemAdmin || permissions.includes("manage_channels") || guild.ownerId === selfId));

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

  if (!activeGuildId) {
    return (
      <aside className="sidebar">
        <header className="sidebar-header">
          <strong>Mensagens privadas</strong>
          <button type="button" className="sidebar-close" onClick={() => setSidebarOpen(false)} title="Fechar"><CloseIcon size={18} /></button>
        </header>
        <div className="channel-scroll direct-list">
          <button
            type="button"
            className="channel direct-channel"
            data-active={!activeDirectId}
            onClick={() => {
              useStore.setState({ activeDirectId: "", activeChannelId: "" });
              setSidebarOpen(false);
            }}
          >
            <BrandMark size={22} /><span className="channel-name">Início</span>
          </button>
          <button type="button" className="channel add-channel" onClick={() => selfId && void openDirect(selfId)}>
            <PlusIcon size={16} /><span className="channel-name">Mensagem para mim</span>
          </button>
          {directThreads.map((thread) => (
            <button key={thread.id} type="button" className="channel direct-channel" data-active={thread.id === activeDirectId} onClick={() => void selectDirect(thread.id)}>
              <span className="direct-avatar" style={{ background: thread.peer.color }}>{thread.peer.username.slice(0, 2).toUpperCase()}</span>
              <span className="channel-name">{thread.peer.username}</span>
            </button>
          ))}
          {directThreads.length === 0 && <p className="members-empty">Clique em alguém da lista de membros para conversar.</p>}
        </div>
        <UserPanel />
      </aside>
    );
  }

  return (
    <aside className="sidebar">
      <header className="sidebar-header">
        <strong>{guild?.name ?? "Servidor"}</strong>
        {managed && (
          <button
            type="button"
            className="sidebar-action"
            onClick={() => void openAdmin(activeGuildId)}
            title="Convites e membros"
          >
            <GearIcon size={16} />
          </button>
        )}
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
                <div key={channel.id} className="channel-slot">
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
                  {/* Aparece no hover da linha: um ícone de lixeira por canal,
                      sempre visível, transformaria a lista num campo minado. */}
                  {owner && (
                    <button
                      type="button"
                      className="channel-delete"
                      onClick={() => void deleteChannel(channel.id)}
                      title={`Apagar ${channel.name}`}
                    >
                      <TrashIcon size={14} />
                    </button>
                  )}
                  {voice && <VoiceChannelMembers channelId={channel.id} />}
                </div>
              );
            })}
          </section>
        ))}

        {owner && (
          <button type="button" className="channel add-channel" onClick={() => setCreating(true)}>
            <PlusIcon size={16} />
            <span className="channel-name">Criar canal</span>
          </button>
        )}
      </div>

      <VoiceStrip />
      <UserPanel />

      {creating && (
        <ChannelCreateModal guildId={activeGuildId} onClose={() => setCreating(false)} />
      )}
    </aside>
  );
}
