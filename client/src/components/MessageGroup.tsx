import { Avatar } from "@/components/Avatar";
import type { Message } from "@/types";

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

export function MessageGroup({ group }: { group: MessageGroupData }) {
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
        {group.messages.map((message) => (
          <p key={message.id} className="message-line" title={formatStamp(message.at)}>
            {message.content}
          </p>
        ))}
      </div>
    </div>
  );
}
