import { useEffect, useRef } from "react";

/**
 * Liga um `MediaStream` a um `<video>` ou `<audio>`.
 *
 * `srcObject` não é atributo HTML — não existe em JSX —, então essa ponte
 * imperativa é obrigatória. O `if` antes de atribuir também não é zelo à toa:
 * reatribuir o mesmo stream reinicia o decodificador e a imagem pisca.
 */
export function useStreamRef<T extends HTMLMediaElement>(stream: MediaStream | null | undefined) {
  const ref = useRef<T | null>(null);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const next = stream ?? null;
    if (element.srcObject !== next) element.srcObject = next;
    if (next) {
      void element.play().catch(() => {
        // O navegador pode recusar o autoplay antes do primeiro gesto. O stream
        // fica ligado no elemento e ele volta a tocar no clique seguinte.
      });
    }
  }, [stream]);

  return ref;
}
