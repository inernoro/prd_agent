import { useEffect, useMemo, useRef } from 'react';
import { cn } from '@/lib/cn';
import { usePrefersReducedMotion } from '@/hooks/usePrefersReducedMotion';
import { useVisibility } from '@/hooks/useVisibility';

function clamp(v: number, min: number, max: number) {
  return Math.max(min, Math.min(max, v));
}

function smoothstep(edge0: number, edge1: number, x: number) {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

function easeInOutCubic(t: number) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

export default function ConvergingBeamsBackdrop({
  className,
  durationMs = 6800,
  stopAt = 0.5,
}: {
  className?: string;
  durationMs?: number;
  /** 0..1, stop animation at this progress (e.g. 0.5 means stop halfway) */
  stopAt?: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const prefersReducedMotion = usePrefersReducedMotion();
  const visible = useVisibility();

  const dpr = useMemo(() => clamp(window.devicePixelRatio || 1, 1, 1.5), []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    let raf = 0;
    let mounted = true;
    let startAt = 0;

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      const w = Math.max(1, Math.floor(rect.width * dpr));
      const h = Math.max(1, Math.floor(rect.height * dpr));
      if (canvas.width !== w) canvas.width = w;
      if (canvas.height !== h) canvas.height = h;
    };

    const draw = (progress01: number) => {
      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      const w = canvas.width;
      const h = canvas.height;
      const midY = h * 0.5;

      ctx.clearRect(0, 0, w, h);

      // background: deep charcoal with slight diagonal lift
      const bg = ctx.createLinearGradient(w * 0.2, h * 0.15, w, h * 0.75);
      bg.addColorStop(0, '#050507');
      bg.addColorStop(0.55, '#07070a');
      bg.addColorStop(1, '#050507');
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, w, h);

      // progress: start as vertical "|" glow, then converge into ◀
      const p = easeInOutCubic(clamp(progress01, 0, 1));
      const tipX = w * (1 - 0.46 * p); // from right edge -> toward center
      const barW = w * 0.07; // initial "|" thickness

      const barAlpha = smoothstep(0.28, 0.04, p);
      const triAlpha = smoothstep(0.06, 0.32, p);

      // helper: draw a soft beam (top or bottom)
      const drawBeam = (y0: number, y1: number, strength: number, tint: { r: number; g: number; b: number }) => {
        // initial bar (rectangle on the right)
        if (barAlpha > 0.001) {
          const g = ctx.createLinearGradient(w - barW, 0, w, 0);
          g.addColorStop(0, `rgba(${tint.r},${tint.g},${tint.b},${0.0 * strength})`);
          g.addColorStop(0.25, `rgba(${tint.r},${tint.g},${tint.b},${0.10 * strength})`);
          g.addColorStop(1, `rgba(${tint.r},${tint.g},${tint.b},${0.22 * strength})`);
          ctx.save();
          ctx.globalAlpha = barAlpha;
          ctx.fillStyle = g;
          ctx.shadowColor = `rgba(${tint.r},${tint.g},${tint.b},${0.22 * strength})`;
          ctx.shadowBlur = 26 * dpr;
          ctx.fillRect(w - barW, y0, barW, y1 - y0);
          ctx.restore();
        }

        // converged wedge (triangle fan to tipX,midY)
        if (triAlpha > 0.001) {
          const g = ctx.createLinearGradient(w, midY, tipX, midY);
          g.addColorStop(0, `rgba(${tint.r},${tint.g},${tint.b},${0.26 * strength})`);
          g.addColorStop(0.55, `rgba(${tint.r},${tint.g},${tint.b},${0.10 * strength})`);
          g.addColorStop(1, `rgba(${tint.r},${tint.g},${tint.b},0)`);

          ctx.save();
          ctx.globalAlpha = triAlpha;
          ctx.fillStyle = g;
          ctx.shadowColor = `rgba(${tint.r},${tint.g},${tint.b},${0.20 * strength})`;
          ctx.shadowBlur = 34 * dpr;

          ctx.beginPath();
          ctx.moveTo(w, y0);
          ctx.lineTo(w, y1);
          ctx.lineTo(tipX, midY);
          ctx.closePath();
          ctx.fill();

          // subtle brighter core line (makes it look like a "beam" not a flat triangle)
          const core = ctx.createLinearGradient(w, midY, tipX, midY);
          core.addColorStop(0, `rgba(255,255,255,${0.12 * strength})`);
          core.addColorStop(0.35, `rgba(255,255,255,${0.06 * strength})`);
          core.addColorStop(1, 'rgba(255,255,255,0)');
          ctx.fillStyle = core;
          ctx.globalAlpha = triAlpha * 0.9;
          ctx.shadowColor = 'rgba(255,255,255,0.10)';
          ctx.shadowBlur = 18 * dpr;
          ctx.fill();

          ctx.restore();
        }
      };

      // top-right beam downwards + bottom-right beam upwards
      drawBeam(0, midY, 1.0, { r: 190, g: 205, b: 235 }); // cool white-blue
      drawBeam(midY, h, 0.95, { r: 185, g: 200, b: 230 });

      // very subtle vignette
      ctx.save();
      const vig = ctx.createRadialGradient(w * 0.55, midY, h * 0.2, w * 0.55, midY, Math.max(w, h) * 0.9);
      vig.addColorStop(0, 'rgba(0,0,0,0)');
      vig.addColorStop(0.72, 'rgba(0,0,0,0.25)');
      vig.addColorStop(1, 'rgba(0,0,0,0.70)');
      ctx.fillStyle = vig;
      ctx.fillRect(0, 0, w, h);
      ctx.restore();
    };

    const tick = (now: number) => {
      if (!mounted) return;
      const stop = clamp(stopAt, 0, 1);

      if (prefersReducedMotion || !visible) {
        // static pose for reduced motion / hidden
        draw(stop);
        return;
      }

      if (!startAt) startAt = now;
      const tFull = clamp((now - startAt) / durationMs, 0, 1);
      const t = Math.min(tFull, stop);
      draw(t);

      // stop animating once reaching stopAt (hold the frame)
      if (tFull < stop) {
        raf = requestAnimationFrame(tick);
      }
    };

    resize();
    const ro = new ResizeObserver(() => resize());
    ro.observe(canvas);

    // initial paint
    draw(prefersReducedMotion ? clamp(stopAt, 0, 1) : 0);

    if (!prefersReducedMotion && visible) {
      raf = requestAnimationFrame(tick);
    }

    return () => {
      mounted = false;
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [dpr, durationMs, prefersReducedMotion, stopAt, visible]);

  return <canvas ref={canvasRef} className={cn('absolute inset-0 h-full w-full', className)} aria-hidden />;
}


