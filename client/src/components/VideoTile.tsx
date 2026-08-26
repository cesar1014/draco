import { useCallback, useState } from "react";
import { Avatar } from "@/components/Avatar";
import {
  ExitFullscreenIcon,
  ExpandIcon,
  FlipIcon,
  FullscreenIcon,
  MicOffIcon,
  PinIcon,
  PlayIcon,
  ScreenIcon,
  SignalIcon,
  SpeakerIcon,
  SpeakerOffIcon,
  StopIcon,
  SwitchCameraIcon,
  ZoomInIcon,
  ZoomOutIcon,
} from "@/components/Icons";
import { PersonMenu } from "@/components/PersonMenu";
import { useFullscreen } from "@/hooks/useFullscreen";
import { useStreamRef } from "@/hooks/useStreamRef";
import { useZoomPan } from "@/hooks/useZoomPan";
import { statsGrade } from "@/rtc/stats";
import { prefsFor, useStore } from "@/state/store";
import type { MediaSlot, Member } from "@/types";

export interface TileData {
  key: string;
  member: Member;
  /** `null` é o tile de avatar: a pessoa está na call sem imagem. */
  slot: MediaSlot | null;
  stream: MediaStream | null;
  self: boolean;
  connecting: boolean;
}

interface Props {
  tile: TileData;
  focused: boolean;
  onToggleFocus: () => void;
}

export function VideoTile({ tile, focused, onToggleFocus }: Props) {
  const { key, member, slot, stream, self, connecting } = tile;

  const mirrorSelf = useStore((state) => state.settings.mirrorSelf);
  const showStats = useStore((state) => state.settings.showStats);
  const liveFacing = useStore((state) => state.liveFacing);
  const cameraCount = useStore((state) => state.devices.cameras.length);
  const switchCamera = useStore((state) => state.switchCamera);
  const flipped = useStore((state) => state.flipped[key]);
  const toggleFlip = useStore((state) => state.toggleFlip);
  const stats = useStore((state) => state.stats[member.id]);
  const people = useStore((state) => state.people);
  const watching = useStore((state) => state.watching[key]);
  const watch = useStore((state) => state.watch);
  const toggleScreenMuted = useStore((state) => state.toggleScreenMuted);
  const hasScreenAudio = useStore((state) => Boolean(state.remote[member.id]?.streams.screenAudio));
  const [menuOpen, setMenuOpen] = useState(false);
  const [shell, setShell] = useState<HTMLDivElement | null>(null);
  const full = useFullscreen(shell);

  /**
   * Tela alheia só toca quando a pessoa manda. A própria e as câmeras seguem
   * automáticas: ver a si mesmo não custa decodificação, e câmera é leve.
   */
  const gated = slot === "screen" && !self;
  const playing = !gated || Boolean(watching);
  const hasVideo = Boolean(slot && stream) && playing;

  const ref = useStreamRef<HTMLVideoElement>(hasVideo ? stream : null);
  const view = useZoomPan(hasVideo);

  const prefs = prefsFor(people, member.username);
  // No tile de tela o que vale é o mute da transmissão, não o da pessoa.
  const quiet = slot === "screen" ? prefs.screenMuted : prefs.muted;
  const selfCamera = self && slot === "camera";
  // Espelhar é coisa de câmera frontal: na traseira deixaria todo texto ao contrário.
  const mirror = (selfCamera && mirrorSelf && liveFacing !== "environment") !== Boolean(flipped);
  // No celular a lente vem na trilha; no PC vale a quantidade de webcams.
  const canSwitchCamera = selfCamera && (liveFacing !== null || cameraCount > 1);
  const kind = slot ?? "avatar";
  const zoomed = view.zoom > 1;
  // Tela compartilhada não "fala": marcar isso acendia a borda verde sem parar.
  const speaking = member.speaking && slot !== "screen";

  const openIt = useCallback(() => watch(key, true), [watch, key]);

  return (
    <div
      className="tile"
      ref={setShell}
      data-kind={kind}
      data-speaking={speaking}
      data-focused={focused}
      data-full={full.active}
    >
      {hasVideo ? (
        <div
          className="tile-frame"
          ref={view.ref}
          data-zoomed={zoomed}
          data-dragging={view.dragging}
          // Com zoom o dedo passeia na imagem; sem zoom ele ainda rola a grade.
          style={{ touchAction: zoomed ? "none" : "pan-y" }}
          onDoubleClick={onToggleFocus}
        >
          <video
            ref={ref}
            className="tile-video"
            muted
            autoPlay
            playsInline
            style={{
              transform: `translate3d(${view.x}px, ${view.y}px, 0) scale(${view.zoom})${mirror ? " scaleX(-1)" : ""}`,
            }}
          />
        </div>
      ) : gated && !playing ? (
        <button type="button" className="tile-gate" onClick={openIt}>
          <span className="tile-gate-icon">
            <PlayIcon size={26} />
          </span>
          <strong>Ver a tela de {member.username}</strong>
          <em>Só carrega quando você pedir</em>
        </button>
      ) : (
        <div className="tile-avatar" onDoubleClick={onToggleFocus}>
          <span className="tile-avatar-halo" />
          <Avatar member={member} size={96} />
        </div>
      )}

      {connecting && playing && (
        <div className="tile-connecting">
          <span className="tile-spinner" />
          Conectando…
        </div>
      )}

      {speaking && <span className="tile-pulse" aria-hidden="true" />}

      <div className="tile-actions">
        {hasVideo && (
          <>
            <button
              type="button"
              className="tile-action"
              onClick={() => view.zoomBy(1.4)}
              title="Aproximar (roda do mouse)"
            >
              <ZoomInIcon size={16} />
            </button>
            <button
              type="button"
              className="tile-action"
              onClick={() => view.zoomBy(1 / 1.4)}
              disabled={!zoomed}
              title="Afastar"
            >
              <ZoomOutIcon size={16} />
            </button>
          </>
        )}
        {/* `playing` e não `hasVideo`: se a tela travar em "Conectando…" ainda dá pra desistir. */}
        {gated && playing && (
          <button
            type="button"
            className="tile-action"
            onClick={() => watch(key, false)}
            title="Parar de ver esta tela"
          >
            <StopIcon size={16} />
          </button>
        )}
        {gated && playing && hasScreenAudio && (
          <button
            type="button"
            className="tile-action"
            data-on={prefs.screenMuted}
            onClick={() => toggleScreenMuted(member.username)}
            title={prefs.screenMuted ? "Ouvir o som da tela" : "Silenciar o som da tela"}
          >
            {prefs.screenMuted ? <SpeakerOffIcon size={16} /> : <SpeakerIcon size={16} />}
          </button>
        )}
        {canSwitchCamera && (
          <button
            type="button"
            className="tile-action"
            onClick={() => void switchCamera()}
            title={liveFacing === "environment" ? "Voltar pra câmera de selfie" : "Trocar de câmera"}
          >
            <SwitchCameraIcon size={16} />
          </button>
        )}
        {slot === "camera" && (
          <button
            type="button"
            className="tile-action"
            onClick={() => toggleFlip(key)}
            title="Espelhar a imagem"
          >
            <FlipIcon size={16} />
          </button>
        )}
        {!self && (
          <button
            type="button"
            className="tile-action"
            data-on={quiet}
            onClick={() => setMenuOpen(!menuOpen)}
            title={`Áudio de ${member.username}`}
          >
            <SignalIcon size={16} />
          </button>
        )}
        <button
          type="button"
          className="tile-action"
          data-pin={focused}
          onClick={onToggleFocus}
          title={focused ? "Tirar do destaque" : "Fixar em destaque (cabem 2)"}
        >
          {focused ? <PinIcon size={16} /> : <ExpandIcon size={16} />}
        </button>
        {hasVideo && (
          <button
            type="button"
            className="tile-action"
            onClick={full.toggle}
            title={full.active ? "Sair da tela cheia" : "Tela cheia do monitor"}
          >
            {full.active ? <ExitFullscreenIcon size={16} /> : <FullscreenIcon size={16} />}
          </button>
        )}
      </div>

      {zoomed && (
        <button
          type="button"
          className="tile-zoom"
          onClick={view.reset}
          title="Voltar ao tamanho normal · arraste para mover"
        >
          {view.zoom.toFixed(1).replace(".", ",")}×
        </button>
      )}

      {menuOpen && (
        <div className="tile-menu">
          <PersonMenu member={member} onClose={() => setMenuOpen(false)} />
        </div>
      )}

      <div className="tile-footer">
        <span className="tile-name">
          {member.muted && <MicOffIcon size={14} />}
          {quiet && !self && <SpeakerOffIcon size={14} />}
          {slot === "screen" && <ScreenIcon size={14} />}
          {speaking && !member.muted && (
            <span className="bars" aria-hidden="true">
              <i />
              <i />
              <i />
            </span>
          )}
          {self ? "Você" : member.username}
          {slot === "screen" && <em>tela</em>}
        </span>

        {showStats && !self && stats && (
          <span className="tile-stats" data-grade={statsGrade(stats)}>
            {stats.height ? `${stats.height}p · ` : ""}
            {stats.down} kb/s
            {stats.rtt != null ? ` · ${stats.rtt} ms` : ""}
          </span>
        )}
      </div>
    </div>
  );
}

/** Só o essencial: o que aparece na fita de miniaturas embaixo do palco. */
export function TileThumb({
  tile,
  speaking,
  onClick,
}: {
  tile: TileData;
  speaking: boolean;
  onClick: () => void;
}) {
  const { key, member, slot, stream, self } = tile;
  const watching = useStore((state) => state.watching[key]);
  const live = Boolean(stream) && (slot !== "screen" || self || watching);
  const ref = useStreamRef<HTMLVideoElement>(live ? stream : null);

  return (
    <button
      type="button"
      className="thumb"
      data-speaking={speaking}
      onClick={onClick}
      title="Colocar em destaque"
    >
      {live ? (
        <video ref={ref} className="thumb-video" muted autoPlay playsInline />
      ) : (
        <span className="thumb-avatar">
          <Avatar member={member} size={34} />
        </span>
      )}
      <span className="thumb-name">
        {slot === "screen" && <ScreenIcon size={11} />}
        {self ? "Você" : member.username}
      </span>
    </button>
  );
}
