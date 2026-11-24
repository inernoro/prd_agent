import { useEffect, useRef, useState } from 'react';

/** Original v14 Threads geometry; rendered behind the first 240 px only. */
export function WritingThreads({ collection = false, paused }: { collection?: boolean; paused?: boolean }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [still, setStill] = useState(false);
  useEffect(() => {
    const element = canvas.current;
    const context = element?.getContext('2d');
    if (!element || !context) return;
    const media = matchMedia('(prefers-reduced-motion: reduce)');
    let frame = 0;
    let width = 0;
    let height = 0;
    const draw = (time: number) => {
      if (!element.isConnected || width <= 0 || height <= 0) return;
      context.clearRect(0, 0, width, height);
      const theme = document.documentElement.dataset.theme;
      const dark = theme !== 'light';
      const rgb = getComputedStyle(element).getPropertyValue('--writing-thread-rgb').trim();
      if (!rgb) return;
      if (collection && width <= 700) {
        for (let i = 0; i < 14; i++) {
          const p = i / 13, base = height * (.2 + p * .5), alpha = (dark ? .32 : .26) * (1 - Math.abs(p - .5) * 1.2);
          const gradient = context.createLinearGradient(0, 0, 0, height);
          gradient.addColorStop(0, `rgba(${rgb},${alpha})`); gradient.addColorStop(1, `rgba(${rgb},0)`);
          context.beginPath();
          for (let x = 0; x <= width; x += 6) {
            const nx = x / width;
            const y = base + Math.sin(nx * 3 + time * .25 + p * 4) * height * .06 * (.4 + p) + Math.sin(nx * 7 - time * .18 + p * 9) * height * .015;
            if (!x) context.moveTo(x, y); else context.lineTo(x, y);
          }
          context.strokeStyle = gradient; context.lineWidth = 1; context.stroke();
        }
        return;
      }
      const amplitude = height * .12 * .6;
      const layers = collection ? [
        { n: 7, w: 2.5, a: .09, s: .12, ph: 2.3, y0: .05, y1: .95 },
        { n: 20, w: 1, a: .26, s: .25, ph: 0, y0: .08, y1: .78 },
      ] : [
        { n: 5, w: 2.5, a: .07, s: .12, ph: 2.3, y0: .05, y1: .95 },
        { n: 12, w: 1, a: .2, s: .25, ph: 0, y0: .08, y1: .78 },
      ];
      for (const layer of layers) for (let i = 0; i < layer.n; i++) {
        const p = i / (layer.n - 1);
        const base = height * (layer.y0 + p * (layer.y1 - layer.y0));
        const alpha = layer.a * (dark ? 1.25 : 1) * (1 - Math.abs(p - .5) * 1.2);
        const gradient = context.createLinearGradient(0, 0, 0, height);
        gradient.addColorStop(0, `rgba(${rgb},${alpha})`);
        gradient.addColorStop(.75, `rgba(${rgb},${alpha * .55})`);
        gradient.addColorStop(1, `rgba(${rgb},0)`);
        context.beginPath();
        for (let x = 0; x <= width; x += collection ? 8 : 6) {
          const nx = x / width;
          const y = base + Math.sin(nx * 3.2 + time * layer.s + p * 4.1 + layer.ph) * amplitude * (.35 + p * .8)
            + Math.sin(nx * 7.1 - time * layer.s * .7 + p * 9.3) * amplitude * .22;
          if (!x) context.moveTo(x, y); else context.lineTo(x, y);
        }
        context.strokeStyle = gradient; context.lineWidth = layer.w; context.stroke();
      }
    };
    const fit = () => {
      const rect = element.getBoundingClientRect();
      const scale = Math.min(2, devicePixelRatio || 1);
      width = rect.width; height = rect.height;
      element.width = Math.max(1, width * scale); element.height = Math.max(1, height * scale);
      context.setTransform(scale, 0, 0, scale, 0, 0); draw(0);
    };
    const sync = () => {
      cancelAnimationFrame(frame);
      if ((paused ?? still) || media.matches) { draw(0); return; }
      const tick = (time: number) => { draw(time / 1000); frame = requestAnimationFrame(tick); };
      frame = requestAnimationFrame(tick);
    };
    const resize = new ResizeObserver(fit);
    const theme = new MutationObserver(() => draw(0));
    resize.observe(element); theme.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    fit(); sync(); media.addEventListener('change', sync);
    return () => { cancelAnimationFrame(frame); resize.disconnect(); theme.disconnect(); media.removeEventListener('change', sync); };
  }, [still, collection, paused]);
  return <><canvas className={`writing-threads ${collection ? 'collection-threads' : ''}`} ref={canvas} aria-hidden="true" />{paused === undefined && <button className="writing-motion-control" aria-pressed={still} onClick={() => setStill(v => !v)}>{still ? '恢复动态' : '减少动态'}</button>}</>;
}
