import { useMemo } from "react";
import { CallControls } from "@/components/CallControls";
import { SpeakerIcon } from "@/components/Icons";
import { VideoTile, type TileData } from "@/components/VideoTile";
import { media, membersInVoice, useStore, type PeerMedia } from "@/state/store";
import type { Member } from "@/types";

/**
 * A área grande da call: uma grade de tiles e a barra de controles.
 *
 * Quem decide se um tile de vídeo existe é o estado que veio pelo socket
 * (`camOn`, `screenOn`), não a presença da trilha. A diferença aparece no meio
 * segundo entre o clique da outra pessoa e a mídia chegar: com o socket, o tile
 * já aparece escrito "Conectando…"; esperando a mídia, a tela ficaria parada sem
 * explicar nada.
 */
function buildTiles(
  present: Member[],
  remote: Record<string, PeerMedia>,
  selfId: string | null,
  camOn: boolean,
  screenOn: boolean,
): TileData[] {
  const tiles: TileData[] = [];

  for (const member of present) {
    const self = member.id === selfId;
    const peer = remote[member.id];
    // A própria pessoa não passa pelo socket pra saber de si: os flags locais
    // valem na hora, sem esperar o servidor ecoar de volta.
    const camera = self ? camOn : member.camOn;
    const screen = self ? screenOn : member.screenOn;

    const videos: Array<Pick<TileData, "slot" | "stream" | "connecting">> = [];
    if (screen) {
      videos.push({
        slot: "screen",
        stream: self ? media.screenStream : (peer?.streams.screen ?? null),
        connecting: !self && !peer?.live.screen,
      });
    }
    if (camera) {
      videos.push({
        slot: "camera",
        stream: self ? media.cameraStream : (peer?.streams.camera ?? null),
        connecting: !self && !peer?.live.camera,
      });
    }

    if (videos.length === 0) {
      tiles.push({ key: `${member.id}:avatar`, member, slot: null, stream: null, self, connecting: false });
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
  const focusedTile = useStore((state) => state.focusedTile);
  const setFocusedTile = useStore((state) => state.setFocusedTile);
  const joinVoice = useStore((state) => state.joinVoice);

  const joined = voiceChannelId === channelId;
  const channel = channels.find((item) => item.id === channelId);

  const present = useMemo(() => membersInVoice(members, channelId), [members, channelId]);
  const tiles = useMemo(
    () => buildTiles(present, remote, selfId, camOn, screenOn),
    [present, remote, selfId, camOn, screenOn],
  );

  const focused = tiles.find((tile) => tile.key === focusedTile) ?? null;
  const visible = focused ? [focused] : tiles;

  return (
    <div className="stage">
      <header className="content-header">
        <SpeakerIcon size={24} />
        <h1>{channel?.name ?? "canal de voz"}</h1>
        <span className="content-header-meta">
          {present.length === 0
            ? "ninguém na call"
            : `${present.length} ${present.length === 1 ? "pessoa" : "pessoas"}`}
        </span>
      </header>

      {joined ? (
        <>
          <div className="stage-grid" data-count={visible.length} data-focused={Boolean(focused)}>
            {visible.map((tile) => (
              <VideoTile
                key={tile.key}
                tile={tile}
                focused={focused?.key === tile.key}
                onToggleFocus={() => setFocusedTile(focusedTile === tile.key ? null : tile.key)}
              />
            ))}
          </div>

          {present.length === 1 && (
            <p className="stage-hint">
              Você está sozinho aqui. Mande o link para alguém entrar no mesmo canal.
            </p>
          )}

          <CallControls />
        </>
      ) : (
        <div className="stage-join">
          <SpeakerIcon size={56} />
          <h2>{channel?.name ?? "Canal de voz"}</h2>
          <p>
            {present.length === 0
              ? "Ninguém está aqui ainda."
              : `${present.map((member) => member.username).join(", ")} ${present.length === 1 ? "está" : "estão"} na call.`}
          </p>
          <button type="button" className="stage-join-button" onClick={() => void joinVoice(channelId)}>
            Entrar na chamada
          </button>
        </div>
      )}
    </div>
  );
}
