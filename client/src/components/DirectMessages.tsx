import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { MenuIcon, SendIcon } from "@/components/Icons";
import { MessageGroup, groupMessages } from "@/components/MessageGroup";
import { useStore } from "@/state/store";
import type { DirectMessage, Message } from "@/types";
import { ATTACHMENT_ACCEPT, uploadAttachments, validateAttachments } from "@/attachments";

/** Evita um snapshot novo do Zustand enquanto a conversa ainda está carregando. */
const NO_DIRECT_MESSAGES: DirectMessage[] = [];

export function DirectMessages({ threadId }: { threadId: string }) {
  const thread = useStore((state) => state.directThreads.find((item) => item.id === threadId));
  const direct = useStore((state) => state.directMessages[threadId] ?? NO_DIRECT_MESSAGES);
  const sendDirect = useStore((state) => state.sendDirect);
  const setSidebarOpen = useStore((state) => state.setSidebarOpen);
  const replyingTo = useStore((state) => state.replyingTo);
  const setReplyingTo = useStore((state) => state.setReplyingTo);
  const [draft, setDraft] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [uploadStatus, setUploadStatus] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const messages = useMemo(
    () => direct.map((message) => ({ ...message, channelId: message.threadId }) as Message),
    [direct],
  );
  const groups = useMemo(() => groupMessages(messages), [messages]);

  useEffect(() => {
    if (scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight;
  }, [messages]);

  async function submit() {
    if (sending || (!draft.trim() && files.length === 0)) return;
    setSending(true);
    setUploadStatus(null);
    const content = draft.trim() || (files.length === 1 ? `Anexo: ${files[0].name}` : `${files.length} anexos`);
    const message = await sendDirect(content);
    if (!message) {
      setUploadStatus("Não foi possível enviar a mensagem.");
      setSending(false);
      return;
    }
    setDraft("");
    const selected = files;
    setFiles([]);
    if (fileInput.current) fileInput.current.value = "";
    try {
      if (selected.length) await uploadAttachments("direct", message, selected, (done, total) => setUploadStatus(`Enviando anexos: ${done}/${total}`));
      setUploadStatus(null);
    } catch (error) {
      setUploadStatus(error instanceof Error ? error.message : "Não foi possível enviar os anexos.");
    } finally {
      setSending(false);
    }
  }

  function key(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== "Enter" || event.shiftKey) return;
    event.preventDefault();
    void submit();
  }

  return (
    <div className="chat">
      <header className="content-header">
        <button type="button" className="header-menu" onClick={() => setSidebarOpen(true)} title="Conversas"><MenuIcon size={20} /></button>
        <span className="direct-symbol">@</span>
        <h1>{thread?.peer.username ?? "Mensagem privada"}</h1>
      </header>
      <div className="messages" ref={scroller}>
        <div className="messages-intro">
          <div className="messages-intro-icon direct-symbol">@</div>
          <h2>Conversa com {thread?.peer.username ?? "esta pessoa"}</h2>
          <p>Mensagens privadas ficam ligadas à sua conta.</p>
        </div>
        {groups.map((group) => <MessageGroup key={group.key} group={group} scope="direct" />)}
      </div>
      <div className="composer">
        {replyingTo && <div className="composer-reply"><span>Respondendo a <strong>@{replyingTo.username}</strong></span><button type="button" onClick={() => setReplyingTo(null)}>×</button></div>}
        {files.length > 0 && <div className="composer-files">{files.map((file) => <span key={`${file.name}:${file.size}`}>{file.name}</span>)}</div>}
        {uploadStatus && <p className="composer-status" role="status">{uploadStatus}</p>}
        <label className="composer-attach" title="Adicionar imagens ou PDF" aria-label="Adicionar anexos"><span aria-hidden="true">＋</span><input ref={fileInput} type="file" accept={ATTACHMENT_ACCEPT} multiple disabled={sending} onChange={(event) => { const next = Array.from(event.target.files ?? []); const error = validateAttachments(next); setUploadStatus(error); if (!error) setFiles(next); }} /></label>
        <textarea value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={key} placeholder={`Mensagem para @${thread?.peer.username ?? "pessoa"}`} rows={1} maxLength={2000} disabled={sending} />
        <button type="button" className="composer-send" onClick={() => void submit()} disabled={sending || (!draft.trim() && files.length === 0)} title="Enviar"><SendIcon size={18} /></button>
      </div>
    </div>
  );
}
