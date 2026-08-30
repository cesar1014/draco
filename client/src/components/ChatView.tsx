import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { HashIcon, MenuIcon, SendIcon } from "@/components/Icons";
import { MembersToggle } from "@/components/MembersToggle";
import { MessageGroup, groupMessages } from "@/components/MessageGroup";
import { useStore } from "@/state/store";
import { ATTACHMENT_ACCEPT, uploadAttachments, validateAttachments } from "@/attachments";

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
  const sendChat = useStore((state) => state.sendChat);
  const loadOlderMessages = useStore((state) => state.loadOlderMessages);
  const setSidebarOpen = useStore((state) => state.setSidebarOpen);
  const guest = useStore((state) => state.account?.guest === true);
  const replyingTo = useStore((state) => state.replyingTo);
  const setReplyingTo = useStore((state) => state.setReplyingTo);
  const lastReadSequence = useStore((state) => state.unread[`channel:${channelId}`]?.lastReadSequence ?? 0);

  const [draft, setDraft] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [uploadStatus, setUploadStatus] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
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
  const firstUnreadGroup = useMemo(() => groups.findIndex((group) =>
    group.messages.some((message) => message.sequence > lastReadSequence)), [groups, lastReadSequence]);

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

  async function submit() {
    if (sending || (!draft.trim() && files.length === 0)) return;
    setSending(true);
    setUploadStatus(null);
    const content = draft.trim() || (files.length === 1 ? `Anexo: ${files[0].name}` : `${files.length} anexos`);
    const message = await sendChat(content);
    if (!message) {
      setUploadStatus("Não foi possível enviar a mensagem.");
      setSending(false);
      return;
    }
    setDraft("");
    pinned.current = true;
    const selected = files;
    setFiles([]);
    if (fileInput.current) fileInput.current.value = "";
    try {
      if (selected.length) await uploadAttachments("channel", message, selected, (done, total) => setUploadStatus(`Enviando anexos: ${done}/${total}`));
      setUploadStatus(null);
    } catch (error) {
      setUploadStatus(error instanceof Error ? error.message : "Não foi possível enviar os anexos.");
    } finally {
      setSending(false);
    }
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== "Enter" || event.shiftKey) return;
    event.preventDefault();
    void submit();
  }

  function chooseFiles(next: File[]) {
    const error = validateAttachments(next);
    setUploadStatus(error);
    if (!error) setFiles(next);
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
        <MembersToggle />
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

        {groups.map((group, index) => {
          return <div key={group.key}>{index === firstUnreadGroup && lastReadSequence > 0 && <div className="new-messages-line"><span>Novas mensagens</span></div>}<MessageGroup group={group} /></div>;
        })}
      </div>

      <div className="composer" data-readonly={guest}>
        {replyingTo && <div className="composer-reply"><span>Respondendo a <strong>@{replyingTo.username}</strong></span><button type="button" onClick={() => setReplyingTo(null)}>×</button></div>}
        {files.length > 0 && <div className="composer-files">{files.map((file) => <span key={`${file.name}:${file.size}`}>{file.name}</span>)}</div>}
        {uploadStatus && <p className="composer-status" role="status">{uploadStatus}</p>}
        <label className="composer-attach" title="Adicionar imagens ou PDF" aria-label="Adicionar anexos">
          <span aria-hidden="true">＋</span>
          <input ref={fileInput} type="file" accept={ATTACHMENT_ACCEPT} multiple disabled={guest || sending} onChange={(event) => chooseFiles(Array.from(event.target.files ?? []))} />
        </label>
        <textarea
          ref={composer}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder={guest ? "Visitantes podem ler, mas não enviar mensagens" : `Conversar em #${channel?.name ?? "canal"}`}
          disabled={guest || sending}
          rows={1}
          maxLength={2000}
        />
        <button
          type="button"
          className="composer-send"
          onClick={() => void submit()}
          disabled={guest || sending || (!draft.trim() && files.length === 0)}
          title="Enviar"
        >
          <SendIcon size={18} />
        </button>
      </div>
    </div>
  );
}
