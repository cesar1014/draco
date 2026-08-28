import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

/**
 * Cartão ancorado num elemento, montado no `body`.
 *
 * Dentro da lista de canais ele ficava enterrado: a linha de cada pessoa tem
 * animação de entrada, e animação de transform cria contexto de empilhamento, e
 * `z-index` nenhum escapa dali. A rolagem da lista ainda o cortava por cima.
 * Fora da árvore, com posição fixa, ele passa por cima de tudo.
 */
export function Popover({
  anchor,
  width = 236,
  children,
}: {
  anchor: HTMLElement | null;
  width?: number;
  children: ReactNode;
}) {
  const card = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState<{ top: number; left: number; width: number } | null>(null);

  useLayoutEffect(() => {
    if (!anchor) return;

    const place = () => {
      const rect = anchor.getBoundingClientRect();
      const height = card.current?.offsetHeight ?? 0;
      const margin = 8;
      const size = Math.min(width, window.innerWidth - margin * 2);
      const left = Math.max(margin, Math.min(rect.left, window.innerWidth - size - margin));
      // Não cabe embaixo: abre pra cima, como qualquer menu perto da borda.
      const below = rect.bottom + 6;
      const top =
        height && below + height > window.innerHeight - margin
          ? Math.max(margin, rect.top - height - 6)
          : below;
      setBox({ top, left, width: size });
    };

    place();
    window.addEventListener("resize", place);
    // Captura: a lista de canais rola dentro dela mesma e `scroll` não borbulha.
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [anchor, width]);

  if (!anchor) return null;

  return createPortal(
    <div
      className="popover"
      ref={card}
      style={{
        top: box?.top ?? 0,
        left: box?.left ?? 0,
        width: box?.width ?? width,
        visibility: box ? "visible" : "hidden",
      }}
    >
      {children}
    </div>,
    document.body,
  );
}
