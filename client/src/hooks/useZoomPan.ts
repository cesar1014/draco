import { useCallback, useEffect, useState } from "react";

const MAX_ZOOM = 8;

export interface ZoomPan {
  ref: (node: HTMLDivElement | null) => void;
  zoom: number;
  x: number;
  y: number;
  dragging: boolean;
  zoomBy: (factor: number) => void;
  reset: () => void;
}

/**
 * Roda do mouse dá zoom, arrasto passeia pela imagem, dois dedos fazem pinça.
 *
 * O zoom acontece em volta do cursor: sem isso a parte que a pessoa está tentando
 * ler foge do quadro no primeiro clique da roda.
 */
export function useZoomPan(enabled: boolean): ZoomPan {
  const [node, setNode] = useState<HTMLDivElement | null>(null);
  const [view, setView] = useState({ zoom: 1, x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);

  const reset = useCallback(() => setView({ zoom: 1, x: 0, y: 0 }), []);

  /** A imagem nunca solta a borda do quadro: o passeio para onde ela acaba. */
  const clamp = useCallback(
    (zoom: number, x: number, y: number) => {
      const rect = node?.getBoundingClientRect();
      const maxX = ((rect?.width ?? 0) * (zoom - 1)) / 2;
      const maxY = ((rect?.height ?? 0) * (zoom - 1)) / 2;
      return { zoom, x: Math.min(maxX, Math.max(-maxX, x)), y: Math.min(maxY, Math.max(-maxY, y)) };
    },
    [node],
  );

  const zoomAt = useCallback(
    (factor: number, clientX: number, clientY: number) => {
      setView((current) => {
        const zoom = Math.min(MAX_ZOOM, Math.max(1, current.zoom * factor));
        if (zoom === current.zoom) return current;
        if (zoom === 1) return { zoom: 1, x: 0, y: 0 };

        const rect = node?.getBoundingClientRect();
        const cx = clientX - (rect?.left ?? 0) - (rect?.width ?? 0) / 2;
        const cy = clientY - (rect?.top ?? 0) - (rect?.height ?? 0) / 2;
        const ratio = zoom / current.zoom;
        return clamp(zoom, cx - (cx - current.x) * ratio, cy - (cy - current.y) * ratio);
      });
    },
    [node, clamp],
  );

  const zoomBy = useCallback(
    (factor: number) => {
      const rect = node?.getBoundingClientRect();
      zoomAt(factor, (rect?.left ?? 0) + (rect?.width ?? 0) / 2, (rect?.top ?? 0) + (rect?.height ?? 0) / 2);
    },
    [node, zoomAt],
  );

  useEffect(() => {
    if (!enabled) reset();
  }, [enabled, reset]);

  useEffect(() => {
    if (!node || !enabled) return;

    // `passive: false` na mão porque o React registra `onWheel` como passivo, e
    // ali o `preventDefault()` não segura o scroll da página.
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      zoomAt(Math.exp(-event.deltaY / 400), event.clientX, event.clientY);
    };

    const points = new Map<number, { x: number; y: number }>();
    let last = { cx: 0, cy: 0, spread: 0 };

    const measure = () => {
      const list = [...points.values()];
      if (list.length === 0) return { cx: 0, cy: 0, spread: 0 };
      return {
        cx: list.reduce((sum, point) => sum + point.x, 0) / list.length,
        cy: list.reduce((sum, point) => sum + point.y, 0) / list.length,
        spread: list.length < 2 ? 0 : Math.hypot(list[0].x - list[1].x, list[0].y - list[1].y),
      };
    };

    const onDown = (event: PointerEvent) => {
      if (event.pointerType === "mouse" && event.button !== 0) return;
      points.set(event.pointerId, { x: event.clientX, y: event.clientY });
      last = measure();
      node.setPointerCapture(event.pointerId);
      setDragging(true);
    };

    const onMove = (event: PointerEvent) => {
      if (!points.has(event.pointerId)) return;
      points.set(event.pointerId, { x: event.clientX, y: event.clientY });
      const now = measure();
      if (now.spread > 0 && last.spread > 0) zoomAt(now.spread / last.spread, now.cx, now.cy);
      const dx = now.cx - last.cx;
      const dy = now.cy - last.cy;
      last = now;
      if (dx || dy) {
        setView((current) =>
          current.zoom === 1 ? current : clamp(current.zoom, current.x + dx, current.y + dy),
        );
      }
    };

    const onUp = (event: PointerEvent) => {
      points.delete(event.pointerId);
      last = measure();
      if (points.size === 0) setDragging(false);
    };

    node.addEventListener("wheel", onWheel, { passive: false });
    node.addEventListener("pointerdown", onDown);
    node.addEventListener("pointermove", onMove);
    node.addEventListener("pointerup", onUp);
    node.addEventListener("pointercancel", onUp);
    return () => {
      node.removeEventListener("wheel", onWheel);
      node.removeEventListener("pointerdown", onDown);
      node.removeEventListener("pointermove", onMove);
      node.removeEventListener("pointerup", onUp);
      node.removeEventListener("pointercancel", onUp);
    };
  }, [node, enabled, zoomAt, clamp]);

  return { ref: setNode, zoom: view.zoom, x: view.x, y: view.y, dragging, zoomBy, reset };
}
