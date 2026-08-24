import { useEffect } from "react";
import { ChannelSidebar } from "@/components/ChannelSidebar";
import { ChatView } from "@/components/ChatView";
import { GuildRail } from "@/components/GuildRail";
import { JoinScreen } from "@/components/JoinScreen";
import { RemoteAudioSink } from "@/components/RemoteAudioSink";
import { ScreenShareModal } from "@/components/ScreenShareModal";
import { SettingsModal } from "@/components/SettingsModal";
import { VoiceStage } from "@/components/VoiceStage";
import { resumeAudio } from "@/rtc/SpeakingDetector";
import { useStore } from "@/state/store";

/** Tecla de push-to-talk não vale enquanto a pessoa está escrevendo. */
function typing(target: EventTarget | null): boolean {
  const node = target as HTMLElement | null;
  if (!node) return false;
  const tag = node.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || node.isContentEditable;
}

export function App() {
  const status = useStore((state) => state.status);
  const reconnecting = useStore((state) => state.reconnecting);
  const settingsOpen = useStore((state) => state.settingsOpen);
  const screenPickerOpen = useStore((state) => state.screenPickerOpen);
  const sidebarOpen = useStore((state) => state.sidebarOpen);
  const setSidebarOpen = useStore((state) => state.setSidebarOpen);
  const liteMode = useStore((state) => state.settings.liteMode);
  const camOn = useStore((state) => state.camOn);
  const screenOn = useStore((state) => state.screenOn);
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

  useEffect(() => {
    document.documentElement.dataset.lite = liteMode ? "on" : "off";
  }, [liteMode]);

  /**
   * Encodar câmera ou tela é o que mais custa CPU numa call. Enquanto isso está
   * no ar, o enfeite que anima sem parar sai do caminho: o ganho é real porque
   * cada gradiente grande que respira é uma repintura por quadro.
   */
  useEffect(() => {
    document.documentElement.dataset.busy = camOn || screenOn ? "on" : "off";
  }, [camOn, screenOn]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const state = useStore.getState();
      const { pushToTalk, pushToTalkKey } = state.settings;

      if (pushToTalk && event.code === pushToTalkKey && !typing(event.target)) {
        event.preventDefault();
        if (!event.repeat) state.setTalking(true);
        return;
      }

      if (!event.ctrlKey || !event.shiftKey || event.altKey) return;
      const key = event.key.toLowerCase();
      if (key === "m") state.toggleMute();
      else if (key === "d") state.toggleDeafen();
      else if (key === "v") void state.toggleCamera();
      else if (key === "s") void state.toggleScreen();
      else return;
      event.preventDefault();
    };

    const onKeyUp = (event: KeyboardEvent) => {
      const state = useStore.getState();
      if (state.settings.pushToTalk && event.code === state.settings.pushToTalkKey) {
        state.setTalking(false);
      }
    };

    // Alt+Tab com a tecla apertada não gera `keyup`: sem isso o microfone
    // ficaria aberto até a pessoa voltar e soltar a tecla de novo.
    const onBlur = () => useStore.getState().setTalking(false);

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
    };
  }, []);

  if (status !== "ready") return <JoinScreen />;

  const channel = channels.find((item) => item.id === activeChannelId);

  return (
    <div className="app" data-sidebar={sidebarOpen ? "open" : "closed"}>
      {reconnecting && <div className="banner">Conexão perdida. Reconectando…</div>}

      <GuildRail />
      <ChannelSidebar />
      <button
        type="button"
        className="scrim"
        aria-label="Fechar menu"
        onClick={() => setSidebarOpen(false)}
      />

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
      {screenPickerOpen && <ScreenShareModal />}

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
