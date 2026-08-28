import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { HashIcon, MenuIcon, SendIcon } from "@/components/Icons";
import { MessageGroup, groupMessages } from "@/components/MessageGroup";
import { useStore } from "@/state/store";

/** Distância do fim em que ainda se considera que a pessoa está acompanhando. */
const PINNED_SLACK_PX = 80;

/** Teto de altura do campo de escrita, o mesmo do CSS. */
const COMPOSER_MAX_PX = 200;

/** Distância do topo que já dispara a busca da conversa anterior. */
const HISTORY_TRIGGER_PX = 400;

export function ChatView({ channelId }: { channelId: string }) {
  const channels = useStore((state) => state.channels);
  const messages = useStore((state) => state.messages[channelId]);
  const hasOlder = useStore((state) => state.history[channelId] === true);
  const loadingHistory = useStore((state) => state.loadingHistory === channelId);
  const memberCount = useStore((state) => Object.keys(state.members).length);
  const sendChat = useStore((state) => state.sendChat);
  const loadOlderMessages = useStore((state) => state.loadOlderMessages);
  const setSidebarOpen = useStore((state) => state.setSidebarOpen);

  const [draft, setDraft] = useState("");
  const scroller = useRef<HTMLDivElement>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  /** Quem subiu pra ler algo antigo não deve ser arrastado pra baixo. */
  const pinned = useRef(true);
  /**
   * Altura do conteúdo antes de a página anterior entrar. Inserir mensagem acima
   * empurra o resto pra baixo, e sem corrigir a rolagem pela diferença o texto que
   * a pessoa estava lendo salta da tela.
   */
  const anchorHeight = useRef<number | null>(null);

  const channel = channels.find((item) => item.id === channelId);
  const groups = useMemo(() => groupMessages(messages ?? []), [messages]);

  const requestOlder = () => {
    const element = scroller.current;
    if (!element || !hasOlder || loadingHistory) return;
    if (element.scrollTop > HISTORY_TRIGGER_PX) return;
    anchorHeight.current = element.scrollHeight;
    void loadOlderMessages(channelId);
  };

  useEffect(() => {
    const element = scroller.current;
    if (!element) return;

    const growth = anchorHeight.current;
    if (growth !== null) {
      anchorHeight.current = null;
      element.scrollTop += element.scrollHeight - growth;
      return;
    }
    if (pinned.current) element.scrollTop = element.scrollHeight;
  }, [messages]);

  useEffect(() => {
    pinned.current = true;
    anchorHeight.current = null;
    const element = scroller.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [channelId]);

  useEffect(() => {
    const element = composer.current;
    if (!element) return;
    // Zerar antes de medir: `scrollHeight` nunca diminui sozinho.
    element.style.height = "auto";
    element.style.height = `${Math.min(element.scrollHeight, COMPOSER_MAX_PX)}px`;
  }, [draft]);

  // Conversa curta não gera rolagem, e sem rolagem o gatilho do topo nunca chega.
  useEffect(requestOlder, [channelId, hasOlder, messages]);

  function trackScroll() {
    const element = scroller.current;
    if (!element) return;
    pinned.current =
      element.scrollHeight - element.scrollTop - element.clientHeight < PINNED_SLACK_PX;
    requestOlder();
  }

  function submit() {
    if (!draft.trim()) return;
    sendChat(draft);
    setDraft("");
    pinned.current = true;
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== "Enter" || event.shiftKey) return;
    event.preventDefault();
    submit();
  }

  return (
    <div className="chat">
      <header className="content-header">
        <button
          type="button"
          className="header-menu"
          onClick={() => setSidebarOpen(true)}
          title="Canais"
        >
          <MenuIcon size={20} />
        </button>
        <HashIcon size={22} />
        <h1>{channel?.name ?? "canal"}</h1>
        <span className="content-header-meta">
          {memberCount} {memberCount === 1 ? "pessoa online" : "pessoas online"}
        </span>
      </header>

      <div className="messages" ref={scroller} onScroll={trackScroll}>
        {hasOlder ? (
          <p className="messages-older" aria-live="polite">
            {loadingHistory ? "Carregando conversa anterior…" : "Role para cima para ver o histórico"}
          </p>
        ) : (
          <div className="messages-intro">
            <div className="messages-intro-icon">
              <HashIcon size={40} />
            </div>
            <h2>Bem-vindo a #{channel?.name ?? "canal"}</h2>
            <p>Este é o começo do canal.</p>
          </div>
        )}

        {groups.map((group) => (
          <MessageGroup key={group.key} group={group} />
        ))}
      </div>

      <div className="composer">
        <textarea
          ref={composer}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder={`Conversar em #${channel?.name ?? "canal"}`}
          rows={1}
          maxLength={2000}
        />
        <button
          type="button"
          className="composer-send"
          onClick={submit}
          disabled={!draft.trim()}
          title="Enviar"
        >
          <SendIcon size={18} />
        </button>
      </div>
    </div>
  );
}
