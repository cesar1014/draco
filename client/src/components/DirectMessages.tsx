import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { MenuIcon, SendIcon } from "@/components/Icons";
import { MessageGroup, groupMessages } from "@/components/MessageGroup";
import { useStore } from "@/state/store";
import type { Message } from "@/types";

export function DirectMessages({ threadId }: { threadId: string }) {
  const thread = useStore((state) => state.directThreads.find((item) => item.id === threadId));
  const direct = useStore((state) => state.directMessages[threadId] ?? []);
  const sendDirect = useStore((state) => state.sendDirect);
  const setSidebarOpen = useStore((state) => state.setSidebarOpen);
  const [draft, setDraft] = useState("");
  const scroller = useRef<HTMLDivElement>(null);
  const messages = useMemo(
    () => direct.map((message) => ({ ...message, channelId: message.threadId }) as Message),
    [direct],
  );
  const groups = useMemo(() => groupMessages(messages), [messages]);

  useEffect(() => {
    if (scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight;
  }, [messages]);

  function submit() {
    if (!draft.trim()) return;
    sendDirect(draft);
    setDraft("");
  }

  function key(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== "Enter" || event.shiftKey) return;
    event.preventDefault();
    submit();
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
        {groups.map((group) => <MessageGroup key={group.key} group={group} />)}
      </div>
      <div className="composer">
        <textarea value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={key} placeholder={`Mensagem para @${thread?.peer.username ?? "pessoa"}`} rows={1} maxLength={2000} />
        <button type="button" className="composer-send" onClick={submit} disabled={!draft.trim()} title="Enviar"><SendIcon size={18} /></button>
      </div>
    </div>
  );
}
