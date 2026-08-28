import { useEffect, useRef, useState } from "react";
import { useStreamRef } from "@/hooks/useStreamRef";
import { audioContext, resumeAudio } from "@/rtc/SpeakingDetector";
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
  const source = useBoost(stream, volume);
  const boosted = source !== stream;
  const ref = useStreamRef<HTMLAudioElement>(source);
  // Safari só entrega áudio remoto pra Web Audio se o stream também estiver preso
  // num elemento. Este fica no mudo, quem toca é o de cima.
  const anchor = useStreamRef<HTMLAudioElement>(boosted ? stream : null);

  // `volume` e `muted` são propriedades do elemento, não atributos: nenhuma se
  // escreve em JSX. Com o ganho no caminho o elemento fica em 1, senão os dois
  // abaixariam o som duas vezes.
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    element.volume = boosted ? 1 : Math.max(0, Math.min(1, volume));
    element.muted = muted;
    if (anchor.current) anchor.current.muted = true;
  }, [ref, anchor, boosted, volume, muted]);

  useEffect(() => {
    const element = ref.current;
    // `setSinkId` não existe no Firefox nem no Safari; sem ele o navegador toca na
    // saída padrão do sistema.
    if (!element || !sinkId || typeof element.setSinkId !== "function") return;
    void element.setSinkId(sinkId).catch(() => {
      // Dispositivo recusado: seguir na saída atual é melhor que ficar sem som.
    });
  }, [ref, sinkId]);

  return (
    <>
      <audio ref={ref} autoPlay />
      {boosted && <audio ref={anchor} autoPlay muted />}
    </>
  );
}

/**
 * Acima de 100% o `<audio>` não ajuda: `volume` satura em 1. A saída então passa
 * a ser um desvio pela Web Audio: ganho, limitador e de volta pra um stream que
 * o mesmo elemento toca, de modo que escolher fone e silenciar continuam iguais.
 *
 * O desvio, uma vez ligado, fica: religá-lo a cada ajuste trocaria o `srcObject`
 * no meio da fala e o som falharia por um instante.
 */
function useBoost(stream: MediaStream, volume: number): MediaStream {
  const [boosting, setBoosting] = useState(false);
  const [out, setOut] = useState<MediaStream | null>(null);
  const gain = useRef<GainNode | null>(null);

  useEffect(() => {
    if (volume > 1) setBoosting(true);
  }, [volume]);

  useEffect(() => {
    if (!boosting) return;
    const ctx = audioContext();
    // Contexto suspenso não deixa nada passar, e aí o desvio devolveria silêncio.
    resumeAudio();

    const input = ctx.createMediaStreamSource(stream);
    const node = ctx.createGain();
    const limiter = ctx.createDynamicsCompressor();
    // Ganho puro estala quando a voz já era alta; o limitador segura só o pico.
    limiter.threshold.value = -3;
    limiter.knee.value = 0;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.003;
    limiter.release.value = 0.12;

    const destination = ctx.createMediaStreamDestination();
    input.connect(node).connect(limiter).connect(destination);
    gain.current = node;
    setOut(destination.stream);

    return () => {
      input.disconnect();
      node.disconnect();
      limiter.disconnect();
      gain.current = null;
      setOut(null);
    };
  }, [boosting, stream]);

  useEffect(() => {
    const node = gain.current;
    // Rampa curta em vez de salto: arrastar o controle sem estalo a cada pixel.
    node?.gain.setTargetAtTime(Math.max(0, volume), audioContext().currentTime, 0.02);
  }, [volume, out]);

  return out ?? stream;
}

export function RemoteAudioSink() {
  const remote = useStore((state) => state.remote);
  const members = useStore((state) => state.members);
  const people = useStore((state) => state.people);
  const deafened = useStore((state) => state.deafened);
  const watching = useStore((state) => state.watching);
  const outputDeviceId = useStore((state) => state.settings.outputDeviceId);

  return (
    <div className="audio-sink" aria-hidden="true">
      {Object.entries(remote).flatMap(([peerId, peer]) => {
        const username = members[peerId]?.username ?? "";
        const prefs = prefsFor(people, username);
        // Som da transmissão só existe pra quem abriu a tela. Ouvir o jogo de
        // alguém sem estar vendo a tela é o pior tipo de barulho: sem contexto.
        const open = Boolean(watching[`${peerId}:screen`]);

        return [
          peer.streams.mic && (
            <AudioOut
              key={`${peerId}:mic`}
              stream={peer.streams.mic}
              volume={prefs.volume}
              muted={deafened || prefs.muted}
              sinkId={outputDeviceId}
            />
          ),
          peer.streams.screenAudio && open && (
            <AudioOut
              key={`${peerId}:screenAudio`}
              stream={peer.streams.screenAudio}
              volume={prefs.screenVolume}
              muted={deafened || prefs.screenMuted}
              sinkId={outputDeviceId}
            />
          ),
        ];
      })}
    </div>
  );
}
