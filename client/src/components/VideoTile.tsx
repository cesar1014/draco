import { Avatar } from "@/components/Avatar";
import { CameraIcon, ExpandIcon, MicOffIcon, ScreenIcon } from "@/components/Icons";
import { useStreamRef } from "@/hooks/useStreamRef";
import type { Member } from "@/types";

export interface TileData {
  /** `peerId:camera`, `peerId:screen` ou `peerId:avatar` — chave do destaque. */
  key: string;
  member: Member;
  slot: "camera" | "screen" | null;
  stream: MediaStream | null;
  self: boolean;
  /** Anunciado como ligado, mas a mídia ainda não chegou. */
  connecting: boolean;
}

interface VideoTileProps {
  tile: TileData;
  focused: boolean;
  onToggleFocus: () => void;
}

export function VideoTile({ tile, focused, onToggleFocus }: VideoTileProps) {
  const { member, slot, stream, self, connecting } = tile;
  const videoRef = useStreamRef<HTMLVideoElement>(stream);
  const hasVideo = Boolean(slot && stream);

  return (
    <div
      className="tile"
      data-kind={slot ?? "avatar"}
      data-speaking={member.speaking && !member.muted}
      data-focused={focused}
      onDoubleClick={onToggleFocus}
    >
      {hasVideo ? (
        <video
          ref={videoRef}
          className="tile-video"
          // Sempre mudo. O áudio dos outros toca nos elementos dedicados do
          // `RemoteAudioSink`; se saísse por aqui também, cada pessoa seria
          // ouvida duas vezes — e sumiria ao desligarem a câmera.
          muted
          autoPlay
          playsInline
          // A própria câmera é espelhada porque é assim que a pessoa se vê no
          // espelho; a tela compartilhada, jamais — texto invertido.
          data-mirror={self && slot === "camera"}
        />
      ) : (
        <div className="tile-avatar">
          <Avatar member={member} size={80} ring />
        </div>
      )}

      {connecting && <div className="tile-connecting">Conectando…</div>}

      <div className="tile-footer">
        {member.muted && (
          <span className="danger" title="Sem microfone">
            <MicOffIcon size={14} />
          </span>
        )}
        {slot === "screen" && <ScreenIcon size={14} />}
        {slot === "camera" && <CameraIcon size={14} />}
        <span className="tile-name">
          {member.username}
          {self && " (você)"}
          {slot === "screen" && " — tela"}
        </span>
      </div>

      <button
        type="button"
        className="tile-expand"
        onClick={onToggleFocus}
        title={focused ? "Sair do destaque" : "Destacar"}
      >
        <ExpandIcon size={16} />
      </button>
    </div>
  );
}
