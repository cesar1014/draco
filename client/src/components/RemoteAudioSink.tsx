import { useEffect } from "react";
import { useStreamRef } from "@/hooks/useStreamRef";
import { prefsFor, useStore } from "@/state/store";

/**
 * O som de todos os outros, em elementos `<audio>` permanentes montados no topo
 * da aplicação. Se o áudio saísse pelo `<video>` de cada tile, desligar a câmera
 * ou ir ler um canal de texto tiraria o som da call.
 */
interface AudioOutProps {
  stream: MediaStream;
  volume: number;
  muted: boolean;
  sinkId: string | null;
}

function AudioOut({ stream, volume, muted, sinkId }: AudioOutProps) {
  const ref = useStreamRef<HTMLAudioElement>(stream);

  // `volume` e `muted` são propriedades do elemento, não atributos: nenhuma se
  // escreve em JSX.
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    element.volume = Math.max(0, Math.min(1, volume));
    element.muted = muted;
  }, [ref, volume, muted]);

  useEffect(() => {
    const element = ref.current;
    // `setSinkId` não existe no Firefox nem no Safari; sem ele o navegador toca na
    // saída padrão do sistema.
    if (!element || !sinkId || typeof element.setSinkId !== "function") return;
    void element.setSinkId(sinkId).catch(() => {
      // Dispositivo recusado: seguir na saída atual é melhor que ficar sem som.
    });
  }, [ref, sinkId]);

  return <audio ref={ref} autoPlay />;
}

export function RemoteAudioSink() {
  const remote = useStore((state) => state.remote);
  const members = useStore((state) => state.members);
  const people = useStore((state) => state.people);
  const deafened = useStore((state) => state.deafened);
  const outputDeviceId = useStore((state) => state.settings.outputDeviceId);

  return (
    <div className="audio-sink" aria-hidden="true">
      {Object.entries(remote).flatMap(([peerId, peer]) => {
        const username = members[peerId]?.username ?? "";
        const prefs = prefsFor(people, username);

        // Microfone e áudio da tela são trilhas separadas, mas volume e mute por
        // pessoa valem pras duas: é uma pessoa só do ponto de vista de quem ouve.
        return (["mic", "screenAudio"] as const).map((slot) => {
          const stream = peer.streams[slot];
          if (!stream) return null;
          return (
            <AudioOut
              key={`${peerId}:${slot}`}
              stream={stream}
              volume={prefs.volume}
              muted={deafened || prefs.muted}
              sinkId={outputDeviceId}
            />
          );
        });
      })}
    </div>
  );
}
