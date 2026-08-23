import type { Member } from "@/types";

/**
 * Iniciais do apelido, como o avatar padrão do Discord. Duas palavras viram duas
 * letras; uma palavra vira as duas primeiras letras dela.
 */
export function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

interface AvatarProps {
  member: Pick<Member, "username" | "color" | "speaking">;
  size?: number;
  /**
   * Liga o anel verde de quem está falando. É uma opção, e não algo automático,
   * porque fora do canal de voz o `speaking` do membro não quer dizer nada pra
   * quem está olhando — o anel só faz sentido dentro da call.
   */
  ring?: boolean;
}

export function Avatar({ member, size = 32, ring = false }: AvatarProps) {
  return (
    <span
      className="avatar"
      data-speaking={ring && member.speaking}
      style={{
        width: size,
        height: size,
        background: member.color,
        fontSize: Math.round(size * 0.38),
      }}
      aria-hidden="true"
    >
      {initialsOf(member.username)}
    </span>
  );
}
