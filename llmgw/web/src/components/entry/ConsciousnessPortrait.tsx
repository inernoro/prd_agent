import { entryAsset } from './entryAsset';
import { useEffect, useId, useRef, useState, type CSSProperties } from 'react';
import { FACE_CLIP, PORTRAIT_LINES, PORTRAIT_MESH } from './portraitGeometry';
import { PORTRAIT_DURATION, samplePortrait, smoothProgress } from './portraitTimeline';
import { createPortraitRenderer, loadPortraitImages } from './portraitRenderer';
import { finishEntryArrival, setEntryChrome } from './entryArrival';

type Props = { fog: boolean; arriving: boolean; frameTime?: number };

/** Original layered portrait: vectors, facial surface, spatial material scan, deforming eyelid. */
export function ConsciousnessPortrait({ fog, arriving, frameTime }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const gridClip = useRef<SVGRectElement>(null);
  const [settled, setSettled] = useState(false);
  const id = `portrait-${useId().replace(/:/g, '')}`;
  const controlled = frameTime !== undefined;
  const playing = !fog && (arriving || controlled) && !settled;
  const timeRef = useRef(frameTime);
  timeRef.current = frameTime;

  useEffect(() => {
    if (!playing || !canvas.current || !host.current) return;
    const root = host.current;
    const owner = root.closest<HTMLElement>('.consciousness-home') ?? root.parentElement!;
    let cancelled = false;
    let raf = 0;
    let renderer: ReturnType<typeof createPortraitRenderer> = null;
    const paintState = (time: number) => {
      const state = samplePortrait(time);
      setEntryChrome(state.chrome);
      for (const [key, value] of Object.entries(state)) {
        root.style.setProperty(`--portrait-${key}`, String(value));
        owner.style.setProperty(`--portrait-${key}`, String(value));
      }
      gridClip.current?.setAttribute('height', String(941 * smoothProgress(time, 1.55, 2.6)));
      root.dataset.time = time.toFixed(3);
      root.dataset.eyeOpening = state.eye.toFixed(4);
      owner.style.setProperty('--portrait-controls-visibility', state.controls > .01 ? 'visible' : 'hidden');
      owner.style.setProperty('--portrait-shortcuts-visibility', state.brandFill > .01 ? 'visible' : 'hidden');
    };
    const fallback = () => {
      if (!cancelled) { root.dataset.renderer = renderer ? 'webgl' : 'static-fallback'; paintState(PORTRAIT_DURATION); setSettled(true); finishEntryArrival(); }
    };
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches && !controlled) { fallback(); return; }
    const paint = (time: number) => { renderer?.draw(time); paintState(time); };
    const preparationTimeout = window.setTimeout(fallback, 1800);
    void loadPortraitImages().then(images => {
      if (cancelled || !canvas.current) return;
      window.clearTimeout(preparationTimeout);
      renderer = createPortraitRenderer(canvas.current, images);
      root.dataset.renderer = renderer ? 'webgl' : 'static-fallback';
      if (!renderer) { fallback(); return; }
      const start = performance.now();
      const frame = (now: number) => {
        if (cancelled) return;
        const time = controlled ? timeRef.current ?? 0 : (now - start) / 1000;
        paint(time);
        if (!controlled && time >= PORTRAIT_DURATION) { fallback(); return; }
        raf = requestAnimationFrame(frame);
      };
      raf = requestAnimationFrame(frame);
    }).catch(fallback);
    const contextLost = (event: Event) => { event.preventDefault(); fallback(); };
    root.addEventListener('webglcontextlost', contextLost, true);
    return () => {
      cancelled = true; window.clearTimeout(preparationTimeout); cancelAnimationFrame(raf); renderer?.dispose();
      root.removeEventListener('webglcontextlost', contextLost, true);
    };
  }, [playing, controlled]);

  return <div ref={host} className={`consciousness-portrait${playing ? ' is-building' : ''}${fog ? ' is-ambient' : ''}`}>
    <img className="consciousness-art" src={fog ? entryAsset('companion-sleep.webp') : entryAsset('companion.webp')} alt="" loading="eager" decoding="async" />
    {playing && <canvas ref={canvas} className="portrait-material" aria-hidden="true" />}
    {(playing || fog) && <svg className="portrait-structure" viewBox="0 0 1672 941" preserveAspectRatio="xMaxYMid slice" fill="none" aria-hidden="true">
      <defs>
        <clipPath id={`${id}-face`}><path d={FACE_CLIP} /></clipPath>
        <clipPath id={`${id}-scan`}><rect ref={gridClip} x="0" y="0" width="1672" height={fog ? '941' : '0'} /></clipPath>
      </defs>
      <g className="portrait-lines" stroke="var(--cinema-accent)" strokeWidth="1.45" strokeLinecap="round" strokeLinejoin="round">
        {PORTRAIT_LINES.map((path, index) => <path key={path} d={path} pathLength="1" strokeDasharray="1" style={{ '--trace-order': index } as CSSProperties} />)}
      </g>
      <g className="portrait-mesh" clipPath={`url(#${id}-face)`} stroke="var(--cinema-accent)" strokeWidth=".75">
        <g clipPath={`url(#${id}-scan)`}>{PORTRAIT_MESH.map(path => <path key={path} d={path} />)}</g>
        <circle cx="1380" cy="570" r="3" fill="var(--cinema-accent)" /><circle cx="1500" cy="697" r="2.5" fill="var(--cinema-accent)" />
      </g>
    </svg>}
    {fog && <div className="portrait-ambient-scan" />}
  </div>;
}
