import { useEffect } from "react";
import { useStreamRef } from "@/hooks/useStreamRef";
import { useStore } from "@/state/store";

/**
 * O som de todos os outros, em elementos `<audio>` dedicados e permanentes.
 *
 * Fica montado no topo da aplicação de propósito. Se o áudio saísse pelo
 * `<video>` de cada tile, ele morreria junto com o tile — ou seja, desligar a
 * câmera, destacar outra pessoa ou ir ler um canal de texto tiraria o som da
 * call. Aqui ele só depende da conexão continuar de pé.
 */
interface AudioOutProps {
  stream: MediaStream;
  volume: number;
  muted: boolean;
  sinkId: string | null;
}

function AudioOut({ stream, volume, muted, sinkId }: AudioOutProps) {
  const ref = useStreamRef<HTMLAudioElement>(stream);

  // `volume`, `muted` e `srcObject` são propriedades do elemento, não atributos:
  // nenhuma delas se escreve em JSX, então todas são aplicadas por aqui.
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    element.volume = Math.max(0, Math.min(1, volume));
    // Ensurdecer é silenciar a saída. A conexão continua recebendo, então voltar
    // a ouvir é imediato e ninguém precisa renegociar nada.
    element.muted = muted;
  }, [ref, volume, muted]);

  useEffect(() => {
    const element = ref.current;
    // `setSinkId` não existe no Firefox nem no Safari; sem ele o navegador toca
    // na saída padrão do sistema, que é um resultado aceitável.
    if (!element || !sinkId || typeof element.setSinkId !== "function") return;
    void element.setSinkId(sinkId).catch(() => {
      // Dispositivo recusado ou desconectado: seguir na saída atual é melhor que
      // ficar sem som.
    });
  }, [ref, sinkId]);

  return <audio ref={ref} autoPlay />;
}

export function RemoteAudioSink() {
  const remote = useStore((state) => state.remote);
  const peerVolumes = useStore((state) => state.peerVolumes);
  const deafened = useStore((state) => state.deafened);
  const outputDeviceId = useStore((state) => state.settings.outputDeviceId);

  return (
    <div className="audio-sink" aria-hidden="true">
      {Object.entries(remote).flatMap(([peerId, peer]) =>
        // Microfone e áudio da tela são trilhas separadas, mas o volume por
        // pessoa vale pra ambas — é uma pessoa só do ponto de vista de quem ouve.
        (["mic", "screenAudio"] as const).map((slot) => {
          const stream = peer.streams[slot];
          if (!stream) return null;
          return (
            <AudioOut
              key={`${peerId}:${slot}`}
              stream={stream}
              volume={peerVolumes[peerId] ?? 1}
              muted={deafened}
              sinkId={outputDeviceId}
            />
          );
        }),
      )}
    </div>
  );
}
