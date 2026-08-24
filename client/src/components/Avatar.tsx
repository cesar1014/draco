import type { CSSProperties } from "react";

/** Duas letras: primeira de cada palavra, ou as duas primeiras de um nome só. */
export function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

interface AvatarMember {
  username: string;
  color: string;
  speaking: boolean;
}

export function Avatar({ member, size = 32 }: { member: AvatarMember; size?: number }) {
  const style = {
    "--avatar-size": `${size}px`,
    "--avatar-color": member.color,
    fontSize: `${Math.max(11, Math.round(size * 0.38))}px`,
  } as CSSProperties;

  return (
    <span className="avatar" data-speaking={member.speaking} style={style}>
      <span className="avatar-face">{initialsOf(member.username)}</span>
    </span>
  );
}
