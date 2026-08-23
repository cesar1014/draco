import { useEffect } from "react";
import { ChannelSidebar } from "@/components/ChannelSidebar";
import { ChatView } from "@/components/ChatView";
import { GuildRail } from "@/components/GuildRail";
import { JoinScreen } from "@/components/JoinScreen";
import { RemoteAudioSink } from "@/components/RemoteAudioSink";
import { SettingsModal } from "@/components/SettingsModal";
import { VoiceStage } from "@/components/VoiceStage";
import { resumeAudio } from "@/rtc/SpeakingDetector";
import { useStore } from "@/state/store";

export function App() {
  const status = useStore((state) => state.status);
  const reconnecting = useStore((state) => state.reconnecting);
  const settingsOpen = useStore((state) => state.settingsOpen);
  const mediaError = useStore((state) => state.mediaError);
  const dismissMediaError = useStore((state) => state.dismissMediaError);
  const channels = useStore((state) => state.channels);
  const activeChannelId = useStore((state) => state.activeChannelId);

  /**
   * Qualquer gesto na página destranca o áudio. O navegador nasce com o
   * `AudioContext` suspenso, e o sintoma clássico disso é entrar na call e não
   * ouvir ninguém — então vale ficar escutando o primeiro clique de todos.
   */
  useEffect(() => {
    const unlock = () => resumeAudio();
    window.addEventListener("pointerdown", unlock);
    window.addEventListener("keydown", unlock);
    return () => {
      window.removeEventListener("pointerdown", unlock);
      window.removeEventListener("keydown", unlock);
    };
  }, []);

  if (status !== "ready") return <JoinScreen />;

  const channel = channels.find((item) => item.id === activeChannelId);

  return (
    <div className="app">
      {reconnecting && <div className="banner">Conexão perdida. Reconectando…</div>}

      <GuildRail />
      <ChannelSidebar />

      <main className="content">
        {channel?.type === "voice" ? (
          <VoiceStage channelId={channel.id} />
        ) : channel ? (
          <ChatView channelId={channel.id} />
        ) : (
          <div className="content-empty">Escolha um canal à esquerda.</div>
        )}
      </main>

      {/* Fora da área de conteúdo: o som não pode depender do que está na tela. */}
      <RemoteAudioSink />

      {settingsOpen && <SettingsModal />}

      {mediaError && (
        <div className="toast" role="alert">
          <p>{mediaError}</p>
          <button type="button" onClick={dismissMediaError}>
            Entendi
          </button>
        </div>
      )}
    </div>
  );
}
