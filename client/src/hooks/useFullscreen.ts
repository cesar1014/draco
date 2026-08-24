import { useCallback, useEffect, useState } from "react";

/** Prefixo da WebKit: no Safari o método padrão simplesmente não existe. */
interface WebkitElement extends HTMLElement {
  webkitRequestFullscreen?: () => Promise<void> | void;
}
interface WebkitDocument extends Document {
  webkitFullscreenElement?: Element | null;
  webkitExitFullscreen?: () => Promise<void> | void;
}

/**
 * Tela inteira do monitor para um elemento.
 *
 * O estado vem do evento e não do clique: dá pra sair com ESC ou pelo botão do
 * navegador, e aí um booleano nosso ficaria mentindo.
 */
export function useFullscreen(node: HTMLElement | null) {
  const [active, setActive] = useState(false);

  useEffect(() => {
    const doc = document as WebkitDocument;
    const sync = () => {
      const current = document.fullscreenElement ?? doc.webkitFullscreenElement ?? null;
      setActive(Boolean(node) && current === node);
    };
    sync();
    document.addEventListener("fullscreenchange", sync);
    document.addEventListener("webkitfullscreenchange", sync);
    return () => {
      document.removeEventListener("fullscreenchange", sync);
      document.removeEventListener("webkitfullscreenchange", sync);
    };
  }, [node]);

  const toggle = useCallback(() => {
    if (!node) return;
    const doc = document as WebkitDocument;
    const current = document.fullscreenElement ?? doc.webkitFullscreenElement ?? null;
    if (current === node) {
      void (document.exitFullscreen?.() ?? doc.webkitExitFullscreen?.());
      return;
    }
    const target = node as WebkitElement;
    // O navegador recusa se o gesto não veio de um clique; nada a fazer aí.
    void Promise.resolve(target.requestFullscreen?.() ?? target.webkitRequestFullscreen?.()).catch(
      () => {},
    );
  }, [node]);

  return { active, toggle, supported: typeof document !== "undefined" };
}
