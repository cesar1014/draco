import { useEffect, useRef } from "react";

/**
 * Nuvem de partículas que se junta formando a logo e explode quando a pessoa
 * entra. Vive só na tela de entrada: ao logar, a `JoinScreen` sai da árvore e o
 * canvas some junto — nenhum quadro é desenhado durante a call.
 *
 * O canvas é uma superfície só, então são centenas de triângulos por quadro em
 * vez de centenas de nós no DOM. O `rAF` para sozinho quando a animação acaba.
 */

interface Particle {
  hx: number; // casa: onde o triângulo descansa, formando a logo
  hy: number;
  x: number;
  y: number;
  sx: number; // de onde veio, espalhado para fora da tela
  sy: number;
  vx: number;
  vy: number;
  size: number;
  color: string;
  delay: number;
  wobble: number;
  alpha: number;
}

const MAX_PARTICLES = 720;
const FORM_MS = 1100;
const EXPLODE_MS = 650;

const easeOut = (t: number) => 1 - Math.pow(1 - t, 3);
/** Os tons escuros da logo desapareceriam no fundo; isso dá um piso de brilho. */
const lift = (v: number) => Math.min(255, Math.round(80 + v * 0.78));

export function Constellation({ exploding }: { exploding: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  // `exploding` muda de fora; num ref o loop lê o valor novo sem reiniciar.
  const explodingRef = useRef(exploding);
  explodingRef.current = exploding;

  useEffect(() => {
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const canvas = canvasRef.current;
    if (!canvas || reduced || document.documentElement.dataset.lite === "on") return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // Teto de DPR: telas densas não precisam de 3× o preenchimento num fundo.
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);

    let shape: Array<{ x: number; y: number; color: string }> = [];
    let particles: Particle[] = [];
    let width = 0;
    let height = 0;
    let raf = 0;
    // -1 e não 0: um `if (!start)` trataria o instante zero como "ainda não
    // começou" e reancoraria o tempo a cada quadro.
    let start = -1;
    let exploded = false;
    let explodeStart = 0;
    let stopped = false;
    let running = false;

    /** Amostra os pixels opacos da logo uma vez; a escala vem depois. */
    const readLogo = (img: HTMLImageElement) => {
      const target = 128;
      const sample = document.createElement("canvas");
      sample.width = target;
      sample.height = target;
      const sctx = sample.getContext("2d", { willReadFrequently: true });
      if (!sctx) return;
      sctx.drawImage(img, 0, 0, target, target);
      const data = sctx.getImageData(0, 0, target, target).data;

      const points: Array<{ x: number; y: number; color: string }> = [];
      for (let y = 0; y < target; y += 2) {
        for (let x = 0; x < target; x += 2) {
          const i = (y * target + x) * 4;
          if (data[i + 3] < 130) continue;
          // Coordenada normalizada (0..1): serve pra qualquer tamanho de tela.
          points.push({
            x: x / target,
            y: y / target,
            color: `rgb(${lift(data[i])},${lift(data[i + 1])},${lift(data[i + 2])})`,
          });
        }
      }
      if (points.length <= MAX_PARTICLES) {
        shape = points;
        return;
      }
      // Rala por índice em vez de `stride` inteiro: um passo de 2 jogaria metade
      // dos triângulos fora mesmo faltando pouco pra caber no teto.
      shape = Array.from(
        { length: MAX_PARTICLES },
        (_, i) => points[Math.floor((i * points.length) / MAX_PARTICLES)],
      );
    };

    /**
     * Reposiciona as partículas para o tamanho atual do canvas. Em dev o CSS
     * entra depois do primeiro quadro, então isso roda de novo via
     * `ResizeObserver` em vez de confiar numa única medição.
     */
    const layout = () => {
      const rect = canvas.getBoundingClientRect();
      if (rect.width < 80 || rect.height < 80 || !shape.length) return false;

      width = rect.width;
      height = rect.height;
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      const box = Math.min(width, height) * 0.52;
      const left = (width - box) / 2;
      const top = (height - box) / 2;

      const previous = particles;
      particles = shape.map((point, index) => {
        const kept = previous[index];
        const hx = left + point.x * box;
        const hy = top + point.y * box;
        if (kept) {
          // Já estava no ar: só muda a casa, sem reiniciar a formação.
          kept.hx = hx;
          kept.hy = hy;
          return kept;
        }
        const angle = Math.random() * Math.PI * 2;
        const radius = Math.max(width, height) * (0.55 + Math.random() * 0.6);
        const sx = width / 2 + Math.cos(angle) * radius;
        const sy = height / 2 + Math.sin(angle) * radius;
        return {
          hx,
          hy,
          x: sx,
          y: sy,
          sx,
          sy,
          vx: 0,
          vy: 0,
          size: 1.3 + Math.random() * 1.5,
          color: point.color,
          delay: Math.random() * 340,
          wobble: Math.random() * Math.PI * 2,
          alpha: 1,
        };
      });
      return true;
    };

    const draw = (time: number) => {
      if (stopped) {
        running = false;
        return;
      }
      raf = requestAnimationFrame(draw);

      if (start < 0) start = time;
      const elapsed = time - start;

      ctx.clearRect(0, 0, width, height);
      const cx = width / 2;
      const cy = height / 2;

      if (explodingRef.current && !exploded) {
        exploded = true;
        explodeStart = time;
        for (const p of particles) {
          const dx = p.x - cx;
          const dy = p.y - cy;
          const dist = Math.hypot(dx, dy) || 1;
          const power = 9 + Math.random() * 12;
          p.vx = (dx / dist) * power + (Math.random() - 0.5) * 3;
          p.vy = (dy / dist) * power + (Math.random() - 0.5) * 3;
        }
      }

      let alive = false;
      for (const p of particles) {
        if (exploded) {
          p.x += p.vx;
          p.y += p.vy;
          p.vx *= 0.96;
          p.vy *= 0.96;
          p.alpha = Math.max(0, 1 - (time - explodeStart) / EXPLODE_MS);
        } else {
          const t = Math.min(1, Math.max(0, (elapsed - p.delay) / FORM_MS));
          const e = easeOut(t);
          p.x = p.sx + (p.hx - p.sx) * e;
          p.y = p.sy + (p.hy - p.sy) * e + (t >= 1 ? Math.sin(time / 900 + p.wobble) * 1.6 : 0);
          p.alpha = 0.2 + e * 0.8;
        }
        if (p.alpha <= 0.01) continue;
        alive = true;

        const s = p.size;
        ctx.globalAlpha = p.alpha;
        ctx.fillStyle = p.color;
        ctx.beginPath();
        ctx.moveTo(p.x, p.y - s);
        ctx.lineTo(p.x - s * 0.87, p.y + s * 0.5);
        ctx.lineTo(p.x + s * 0.87, p.y + s * 0.5);
        ctx.closePath();
        ctx.fill();
      }
      ctx.globalAlpha = 1;

      if (exploded && !alive) {
        stopped = true;
        running = false;
        cancelAnimationFrame(raf);
      }
    };

    /**
     * Só liga o loop quando existe caixa medida. A aba pode estar oculta ou o
     * painel fechado na primeira passada: aí não há layout nenhum, e ficar
     * remedindo por quadro seria um reflow forçado de graça.
     */
    const kick = () => {
      if (running || stopped || !particles.length) return;
      running = true;
      raf = requestAnimationFrame(draw);
    };

    const observer = new ResizeObserver(() => {
      if (!exploded && layout()) kick();
    });

    const img = new Image();
    img.onload = () => {
      readLogo(img);
      observer.observe(canvas);
      if (layout()) kick();
    };
    img.src = "/brand/logo-256.png";

    return () => {
      stopped = true;
      running = false;
      cancelAnimationFrame(raf);
      observer.disconnect();
    };
  }, []);

  return <canvas ref={canvasRef} className="constellation" aria-hidden="true" />;
}
