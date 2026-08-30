import { useState } from "react";
import { Avatar } from "@/components/Avatar";
import { useStore } from "@/state/store";
import type { Message } from "@/types";
import { isImageAttachment } from "@/attachments";

/** Mensagens seguidas da mesma pessoa dentro dessa janela viram um bloco só. */
const GROUP_WINDOW_MS = 5 * 60 * 1000;

export interface MessageGroupData {
  key: string;
  authorId: string;
  username: string;
  color: string;
  at: number;
  messages: Message[];
}

export function groupMessages(messages: Message[]): MessageGroupData[] {
  const groups: MessageGroupData[] = [];
  for (const message of messages) {
    const last = groups[groups.length - 1];
    // A janela conta a partir da *última* do bloco, senão uma conversa contínua se parte.
    const lastAt = last?.messages[last.messages.length - 1]?.at ?? 0;
    if (last && last.authorId === message.authorId && message.at - lastAt < GROUP_WINDOW_MS) {
      last.messages.push(message);
      continue;
    }
    groups.push({
      key: message.id,
      authorId: message.authorId,
      username: message.username,
      color: message.color,
      at: message.at,
      messages: [message],
    });
  }
  return groups;
}

const timeFormat = new Intl.DateTimeFormat("pt-BR", { hour: "2-digit", minute: "2-digit" });
const dateFormat = new Intl.DateTimeFormat("pt-BR", {
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
});

export function formatStamp(at: number): string {
  const when = new Date(at);
  const sameDay = when.toDateString() === new Date().toDateString();
  return sameDay
    ? `Hoje às ${timeFormat.format(when)}`
    : `${dateFormat.format(when)} ${timeFormat.format(when)}`;
}

function MessageLine({ message, scope }: { message: Message; scope: "chat" | "direct" }) {
  const selfId = useStore((state) => state.selfId);
  const activeGuildId = useStore((state) => state.activeGuildId);
  const canModerate = useStore((state) => state.permissions[activeGuildId]?.includes("manage_messages") === true || state.account?.isSystemAdmin === true);
  const setReplyingTo = useStore((state) => state.setReplyingTo);
  const editMessage = useStore((state) => state.editMessage);
  const deleteMessage = useStore((state) => state.deleteMessage);
  const reactMessage = useStore((state) => state.reactMessage);
  const [editing, setEditing] = useState(false);
  const [content, setContent] = useState(message.content);
  const [preview, setPreview] = useState<string | null>(null);
  const mine = message.authorId === selfId;

  async function save() {
    const error = await editMessage(scope, message.id, content);
    if (!error) setEditing(false);
  }

  if (message.deletedAt) {
    return <p id={`message-${message.id}`} className="message-line message-deleted">Mensagem apagada</p>;
  }

  return (
    <div id={`message-${message.id}`} className="message-line-wrap">
      {message.reply && <button type="button" className="message-reply-reference" onClick={() => document.getElementById(`message-${message.reply?.id}`)?.scrollIntoView({ behavior: "smooth", block: "center" })}>
        <strong>@{message.reply.username}</strong> {message.reply.deleted ? "Mensagem apagada" : message.reply.content}
      </button>}
      {editing ? <div className="message-editor"><textarea value={content} onChange={(event) => setContent(event.target.value)} maxLength={2000} autoFocus /><button type="button" onClick={() => void save()}>Salvar</button><button type="button" onClick={() => { setContent(message.content); setEditing(false); }}>Cancelar</button></div> :
        <p className="message-line" title={formatStamp(message.at)}>
          {message.content.split(/(@[\p{L}\p{N}_.-]+)/gu).map((part, index) => part.startsWith("@") ? <mark key={index} className="mention">{part}</mark> : part)}
          {message.editedAt && <small className="message-edited"> (editado)</small>}
        </p>}
      <div className="message-reactions">
        {message.reactions?.map((reaction) => <button key={reaction.emoji} type="button" data-mine={reaction.userIds.includes(selfId ?? "")} onClick={() => void reactMessage(scope, message.id, reaction.emoji)} title={reaction.userIds.join(", ")}>{reaction.emoji} <span>{reaction.count}</span></button>)}
      </div>
      {message.attachments && message.attachments.length > 0 && <div className="message-attachments">
        {message.attachments.map((attachment) => isImageAttachment(attachment) ? (
          <button key={attachment.id} type="button" className="message-image" onClick={() => setPreview(attachment.url)} title={`Ampliar ${attachment.filename}`}>
            <img src={attachment.url} alt={attachment.filename} loading="lazy" decoding="async" />
          </button>
        ) : (
          <a key={attachment.id} className="message-file" href={attachment.url} target="_blank" rel="noreferrer"><span aria-hidden="true">PDF</span><strong>{attachment.filename}</strong><small>{Math.ceil(attachment.size / 1024)} KB</small></a>
        ))}
      </div>}
      {preview && <div className="attachment-lightbox" role="dialog" aria-modal="true" aria-label="Imagem ampliada" onClick={() => setPreview(null)}>
        <button type="button" className="attachment-close" onClick={() => setPreview(null)} aria-label="Fechar">×</button>
        <img src={preview} alt="Anexo ampliado" onClick={(event) => event.stopPropagation()} />
      </div>}
      <div className="message-actions">
        <button type="button" onClick={() => setReplyingTo(message)} title="Responder">↩</button>
        <button type="button" onClick={() => void reactMessage(scope, message.id, "👍")} title="Reagir">☺</button>
        {mine && <button type="button" onClick={() => setEditing(true)} title="Editar">Editar</button>}
        {(mine || (scope === "chat" && canModerate)) && <button type="button" onClick={() => { if (window.confirm("Apagar esta mensagem?")) void deleteMessage(scope, message.id); }} title="Apagar">Apagar</button>}
      </div>
    </div>
  );
}

export function MessageGroup({ group, scope = "chat" }: { group: MessageGroupData; scope?: "chat" | "direct" }) {
  return (
    <div className="message-group">
      <Avatar
        member={{ username: group.username, color: group.color, speaking: false }}
        size={40}
      />
      <div className="message-body">
        <div className="message-head">
          <span className="message-author" style={{ color: group.color }}>
            {group.username}
          </span>
          <time className="message-stamp" dateTime={new Date(group.at).toISOString()}>
            {formatStamp(group.at)}
          </time>
        </div>
        {group.messages.map((message) => <MessageLine key={message.id} message={message} scope={scope} />)}
      </div>
    </div>
  );
}
