import { useEffect, useMemo } from "react";
import { CallControls } from "@/components/CallControls";
import { GridIcon, MenuIcon, ScreenIcon, SpeakerIcon } from "@/components/Icons";
import { MembersToggle } from "@/components/MembersToggle";
import { PreCall } from "@/components/PreCall";
import { TileThumb, VideoTile, type TileData } from "@/components/VideoTile";
import { media, membersInVoice, useStore, type PeerMedia } from "@/state/store";
import type { Member } from "@/types";

/**
 * Quem decide se um tile de vídeo existe é o estado que veio pelo socket
 * (`camOn`, `screenOn`), não a presença da trilha: no meio segundo entre o clique
 * da outra pessoa e a mídia chegar, o tile já aparece escrito "Conectando…".
 */
function buildTiles(
  present: Member[],
  remote: Record<string, PeerMedia>,
  selfId: string | null,
  camOn: boolean,
  screenOn: boolean,
  mediaRecovery: "idle" | "reconnecting" | "failed",
): TileData[] {
  const tiles: TileData[] = [];

  for (const member of present) {
    const self = member.id === selfId;
    const peer = remote[member.id];
    // Os flags locais valem na hora, sem esperar o servidor ecoar de volta.
    const camera = self ? camOn : member.camOn;
    const screen = self ? screenOn : member.screenOn;

    const videos: Array<Pick<TileData, "slot" | "stream" | "connecting" | "mediaState">> = [];
    if (screen) {
      videos.push({
        slot: "screen",
        stream: self ? media.screenStream : (peer?.streams.screen ?? null),
        connecting: !self && !peer?.live.screen,
        mediaState: self || peer?.live.screen ? "connected" : mediaRecovery === "idle" ? "connecting" : mediaRecovery,
      });
    }
    if (camera) {
      videos.push({
        slot: "camera",
        stream: self ? media.cameraStream : (peer?.streams.camera ?? null),
        connecting: !self && !peer?.live.camera,
        mediaState: self || peer?.live.camera ? "connected" : mediaRecovery === "idle" ? "connecting" : mediaRecovery,
      });
    }

    if (videos.length === 0) {
      tiles.push({ key: `${member.id}:avatar`, member, slot: null, stream: null, self, connecting: false, mediaState: "connected" });
      continue;
    }
    for (const video of videos) {
      tiles.push({ key: `${member.id}:${video.slot}`, member, self, ...video });
    }
  }

  // Tela compartilhada primeiro: é o que as pessoas estão olhando.
  return tiles.sort((a, b) => Number(b.slot === "screen") - Number(a.slot === "screen"));
}

export function VoiceStage({ channelId }: { channelId: string }) {
  const channels = useStore((state) => state.channels);
  const members = useStore((state) => state.members);
  const selfId = useStore((state) => state.selfId);
  const remote = useStore((state) => state.remote);
  const voiceChannelId = useStore((state) => state.voiceChannelId);
  const camOn = useStore((state) => state.camOn);
  const screenOn = useStore((state) => state.screenOn);
  const mediaRecovery = useStore((state) => state.mediaRecovery);
  const focusedTiles = useStore((state) => state.focusedTiles);
  const toggleFocus = useStore((state) => state.toggleFocus);
  const clearFocus = useStore((state) => state.clearFocus);
  const pruneTiles = useStore((state) => state.pruneTiles);
  const watch = useStore((state) => state.watch);
  const setSidebarOpen = useStore((state) => state.setSidebarOpen);

  const joined = voiceChannelId === channelId;
  const channel = channels.find((item) => item.id === channelId);

  const present = useMemo(() => membersInVoice(members, channelId), [members, channelId]);
  const tiles = useMemo(
    () => buildTiles(present, remote, selfId, camOn, screenOn, mediaRecovery),
    [present, remote, selfId, camOn, screenOn, mediaRecovery],
  );

  // Quem saiu não pode continuar fixado nem "sendo visto".
  useEffect(() => {
    pruneTiles(tiles.map((tile) => tile.key));
  }, [tiles, pruneTiles]);

  const pinned = focusedTiles
    .map((key) => tiles.find((tile) => tile.key === key))
    .filter((tile): tile is TileData => Boolean(tile));

  const rest = pinned.length ? tiles.filter((tile) => !focusedTiles.includes(tile.key)) : [];
  const main = pinned.length ? pinned : tiles;
  const screens = tiles.filter((tile) => tile.slot === "screen");

  return (
    <div className="stage" data-mode={pinned.length ? "focus" : "grid"}>
      <header className="content-header">
        <button type="button" className="header-menu" onClick={() => setSidebarOpen(true)} title="Canais">
          <MenuIcon size={20} />
        </button>
        <SpeakerIcon size={22} />
        <h1>{channel?.name ?? "canal de voz"}</h1>

        {joined && tiles.length > 1 && (
          <div className="stage-modes">
            {screens.length > 0 && (
              <button
                type="button"
                className="stage-mode"
                onClick={() => {
                  // Abre e fixa as telas de uma vez: é o arranjo que as pessoas
                  // montam na mão toda vez que alguém começa a apresentar.
                  const keys = screens.slice(0, 2).map((tile) => tile.key);
                  for (const key of keys) watch(key, true);
                  clearFocus();
                  for (const key of keys) toggleFocus(key);
                }}
                title="Destacar as telas compartilhadas"
              >
                <ScreenIcon size={16} />
                <span>{screens.length > 1 ? "Telas" : "Tela"}</span>
              </button>
            )}
            <button
              type="button"
              className="stage-mode"
              data-on={pinned.length === 0}
              onClick={clearFocus}
              title="Todo mundo do mesmo tamanho"
            >
              <GridIcon size={16} />
              <span>Grade</span>
            </button>
          </div>
        )}

        <MembersToggle />
      </header>

      {joined ? (
        <>
          <div className="stage-body">
            <div className="stage-grid" data-count={main.length} data-focused={pinned.length > 0}>
              {main.map((tile) => (
                <VideoTile
                  key={tile.key}
                  tile={tile}
                  focused={focusedTiles.includes(tile.key)}
                  onToggleFocus={() => toggleFocus(tile.key)}
                />
              ))}
            </div>

            {/* Fita de quem ficou de fora do destaque: clicar troca o foco. */}
            {rest.length > 0 && (
              <div className="stage-strip">
                {rest.map((tile) => (
                  <TileThumb
                    key={tile.key}
                    tile={tile}
                    speaking={tile.member.speaking && tile.slot !== "screen"}
                    onClick={() => toggleFocus(tile.key)}
                  />
                ))}
              </div>
            )}
          </div>

          {present.length === 1 && (
            <p className="stage-hint">
              Você está sozinho aqui. Mande o link para alguém entrar no mesmo canal.
            </p>
          )}

          <CallControls />
        </>
      ) : (
        <PreCall channelId={channelId} />
      )}
    </div>
  );
}
