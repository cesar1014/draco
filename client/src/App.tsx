import { useEffect } from "react";
import { ChannelSidebar } from "@/components/ChannelSidebar";
import { ChatView } from "@/components/ChatView";
import { DirectMessages } from "@/components/DirectMessages";
import { GuildAdminModal } from "@/components/GuildAdmin";
import { GuildRail } from "@/components/GuildRail";
import { JoinScreen } from "@/components/JoinScreen";
import { MembersPanel } from "@/components/MembersPanel";
import { RemoteAudioSink } from "@/components/RemoteAudioSink";
import { ScreenShareModal } from "@/components/ScreenShareModal";
import { SettingsModal } from "@/components/SettingsModal";
import { VoiceStage } from "@/components/VoiceStage";
import { Welcome } from "@/components/Welcome";
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
  const membersOpen = useStore((state) => state.membersOpen);
  const setMembersOpen = useStore((state) => state.setMembersOpen);
  const admin = useStore((state) => state.admin);
  const joinByInvite = useStore((state) => state.joinByInvite);
  const liteMode = useStore((state) => state.settings.liteMode);
  const camOn = useStore((state) => state.camOn);
  const screenOn = useStore((state) => state.screenOn);
  const mediaError = useStore((state) => state.mediaError);
  const dismissMediaError = useStore((state) => state.dismissMediaError);
  const notice = useStore((state) => state.notice);
  const dismissNotice = useStore((state) => state.dismissNotice);
  const channels = useStore((state) => state.channels);
  const activeChannelId = useStore((state) => state.activeChannelId);
  const guilds = useStore((state) => state.guilds);
  const activeDirectId = useStore((state) => state.activeDirectId);
  const activeGuildId = useStore((state) => state.activeGuildId);
  const account = useStore((state) => state.account);

  /** O aviso é informativo: sai sozinho em vez de exigir um clique. */
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(dismissNotice, 8000);
    return () => clearTimeout(timer);
  }, [notice, dismissNotice]);

  /**
   * Qualquer gesto na página destranca o áudio. O navegador nasce com o
   * `AudioContext` suspenso, e o sintoma clássico disso é entrar na call e não
   * ouvir ninguém, então vale ficar escutando o primeiro clique de todos.
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
   * Link de convite: `?convite=CODIGO`. Vale uma vez, depois de a pessoa entrar —
   * antes disso não há identidade pra associar ao servidor. O parâmetro sai da
   * barra de endereço em seguida, senão um F5 tentaria aceitar de novo e gastaria
   * um uso do convite.
   */
  useEffect(() => {
    if (status !== "ready" || account?.guest) return;
    const code = new URLSearchParams(window.location.search).get("convite");
    if (!code) return;

    window.history.replaceState(null, "", window.location.pathname);
    void joinByInvite(code).then((error) => {
      if (error) useStore.setState({ mediaError: error });
    });
  }, [status, joinByInvite, account?.guest]);

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
  /**
   * Quem entra pela primeira vez não é membro de nada: o app não tem servidor de
   * demonstração. A casca de colunas não teria canal, membro nem conversa pra
   * desenhar, então ela dá lugar à tela que explica os dois caminhos. Os avisos e
   * as janelas continuam montados: o convite recusado é relatado por ali.
   */
  const empty = guilds.length === 0;

  return (
    <div
      className="app"
      data-sidebar={sidebarOpen ? "open" : "closed"}
      data-members={membersOpen ? "open" : "closed"}
      data-empty={empty}
    >
      {reconnecting && <div className="banner">Conexão perdida. Reconectando…</div>}

      {empty ? (
        <Welcome />
      ) : (
        <>
          <GuildRail />
          <ChannelSidebar />
          {/* Um véu para as duas gavetas do celular: fecha a que estiver aberta. */}
          <button
            type="button"
            className="scrim"
            aria-label="Fechar menu"
            onClick={() => {
              setSidebarOpen(false);
              setMembersOpen(false);
            }}
          />

          <main className="content">
            {activeDirectId ? (
              <DirectMessages threadId={activeDirectId} />
            ) : channel?.type === "voice" ? (
              <VoiceStage channelId={channel.id} />
            ) : channel ? (
              <ChatView channelId={channel.id} />
            ) : (
              <div className="content-empty">Escolha um canal à esquerda.</div>
            )}
          </main>

          {activeGuildId && <MembersPanel />}
        </>
      )}

      {/* Fora da área de conteúdo: o som não pode depender do que está na tela. */}
      <RemoteAudioSink />

      {settingsOpen && <SettingsModal />}
      {screenPickerOpen && <ScreenShareModal />}
      {admin && <GuildAdminModal />}

      {mediaError && (
        <div className="toast" role="alert">
          <p>{mediaError}</p>
          <button type="button" onClick={dismissMediaError}>
            Entendi
          </button>
        </div>
      )}

      {notice && !mediaError && (
        <div className="toast notice" role="status">
          <p>{notice}</p>
          <button type="button" onClick={dismissNotice}>
            Ok
          </button>
        </div>
      )}
    </div>
  );
}
