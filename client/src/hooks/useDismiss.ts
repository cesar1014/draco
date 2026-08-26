import { useEffect, type RefObject } from "react";

/** Fecha um popover ao clicar fora dele ou apertar Escape. */
export function useDismiss(ref: RefObject<HTMLElement | null>, onClose: () => void): void {
  useEffect(() => {
    const onPointer = (event: MouseEvent) => {
      const element = ref.current;
      if (element && !element.contains(event.target as Node)) onClose();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    /**
     * `click` na captura, e não `pointerdown`: assim o fechamento e o clique que
     * alterna o menu caem no mesmo evento, os dois leem o estado de antes e
     * concordam em fechar. Com `pointerdown` o menu reabria no mesmo toque. De
     * quebra, arrastar a lista no celular não fecha nada, porque não vira clique.
     */
    window.addEventListener("click", onPointer, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("click", onPointer, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [ref, onClose]);
}
