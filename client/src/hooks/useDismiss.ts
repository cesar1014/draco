import { useEffect, type RefObject } from "react";

/** Fecha um popover ao clicar fora dele ou apertar Escape. */
export function useDismiss(ref: RefObject<HTMLElement | null>, onClose: () => void): void {
  useEffect(() => {
    const onPointer = (event: PointerEvent) => {
      const element = ref.current;
      if (element && !element.contains(event.target as Node)) onClose();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    // Captura: o clique que abriu outro popover não deve reabrir este.
    window.addEventListener("pointerdown", onPointer, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onPointer, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [ref, onClose]);
}
