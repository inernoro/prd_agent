import { useEffect, useId, useRef, useState, type CSSProperties } from 'react';
import { FACE_CLIP, PORTRAIT_LINES, PORTRAIT_MESH, PORTRAIT_DETAILS } from './portraitGeometry';
import { PORTRAIT_DURATION, samplePortrait, smoothProgress } from './portraitTimeline';
import { createPortraitRenderer, loadPortraitImages } from './portraitRenderer';
import { finishEntryArrival, setEntryChrome } from './entryArrival';

type Props = { fog: boolean; arriving: boolean; frameTime?: number };

/** Original layered portrait: vectors, facial surface, spatial material scan, deforming eyelid. */
export function ConsciousnessPortrait({ fog, arriving, frameTime }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const [motionReady, setMotionReady] = useState(false);
  const gridClip = useRef<SVGRectElement>(null);
  const [settled, setSettled] = useState(false);
  const id = `portrait-${useId().replace(/:/g, '')}`;
  const controlled = frameTime !== undefined;
  const playing = !fog && (arriving || controlled) && !settled;
  const timeRef = useRef(frameTime);
  timeRef.current = frameTime;

  useEffect(() => {
    if (!playing || !host.current) return;
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
      gridClip.current?.setAttribute('height', String(941 * smoothProgress(time, .8, 1.5)));
      root.dataset.time = time.toFixed(3);
      root.dataset.eyeOpening = state.eye.toFixed(4);
      owner.style.setProperty('--portrait-controls-visibility', state.controls > .01 ? 'visible' : 'hidden');
      owner.style.setProperty('--portrait-shortcuts-visibility', state.brandFill > .01 ? 'visible' : 'hidden');
    };
    const fallback = () => {
      if (!cancelled) { root.dataset.renderer = renderer ? 'webgl' : 'static-fallback'; paintState(PORTRAIT_DURATION); setSettled(true); finishEntryArrival(); }
    };
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches && !controlled) { fallback(); return; }
    if (!controlled && video.current) {
      // The expensive portrait is authored once in cloud. Native decoding drives the live UI clock.
      const movie = video.current;
      const startedAt = performance.now();
      let started = false;
      let lastTime = 0;
      let lastAdvance = startedAt;
      root.dataset.renderer = 'native-video';
      const complete = () => {
        if (cancelled) return;
        paintState(PORTRAIT_DURATION); setSettled(true); finishEntryArrival();
      };
      const playingVideo = () => {
        if (started) return;
        started = true;
        movie.currentTime = Math.min((performance.now() - startedAt) / 1000, 1.4);
        setMotionReady(true);
      };
      const failed = () => { root.dataset.renderer = 'static-fallback'; complete(); };
      const tick = (now: number) => {
        if (cancelled) return;
        const time = started ? movie.currentTime : Math.min(1.4, Math.max(0, (now-startedAt)/1000));
        if (time > lastTime) { lastTime = time; lastAdvance = now; }
        if (started && now-lastAdvance > 3000) { failed(); return; }
        paintState(time);
        if (time >= PORTRAIT_DURATION) { complete(); return; }
        raf = requestAnimationFrame(tick);
      };
      movie.addEventListener('playing', playingVideo);
      movie.addEventListener('ended', complete);
      movie.addEventListener('error', failed);
      const timeout = window.setTimeout(() => { if (!started) failed(); }, 5000);
      paintState(0); raf = requestAnimationFrame(tick);
      void movie.play().catch(failed);
      return () => {
        cancelled = true; cancelAnimationFrame(raf); window.clearTimeout(timeout); movie.pause();
        movie.removeEventListener('playing', playingVideo); movie.removeEventListener('ended', complete); movie.removeEventListener('error', failed);
      };
    }
    const paint = (time: number) => { renderer?.draw(time); paintState(time); };
    // Vectors start on the first frame, independently of image decoding / GPU setup.
    // If material is late, hold only at the completed structural stage, never a black screen.
    const start = performance.now();
    let held = 0;
    paintState(0);
    const frame = (now: number) => {
      if (cancelled) return;
      if (!renderer) held = Math.max(held, (now - start) / 1000 - 1.4);
      const time = controlled ? timeRef.current ?? 0 : Math.max(0, (now - start) / 1000 - held);
      paint(time);
      if (!controlled && time >= PORTRAIT_DURATION) { fallback(); return; }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    const preparationTimeout = window.setTimeout(fallback, 1800);
    void loadPortraitImages().then(images => {
      if (cancelled || !canvas.current) return;
      renderer = createPortraitRenderer(canvas.current, images);
      root.dataset.renderer = renderer ? 'webgl' : 'static-fallback';
      window.clearTimeout(preparationTimeout);
      if (!renderer) fallback();
    }).catch(fallback);
    const contextLost = (event: Event) => { event.preventDefault(); fallback(); };
    root.addEventListener('webglcontextlost', contextLost, true);
    return () => {
      cancelled = true; window.clearTimeout(preparationTimeout); cancelAnimationFrame(raf); renderer?.dispose();
      root.removeEventListener('webglcontextlost', contextLost, true);
    };
  }, [playing, controlled]);

  return <div ref={host} className={`consciousness-portrait${playing ? ' is-building' : ''}${fog ? ' is-ambient' : ''}`}>
    <img className="consciousness-art" src={fog ? '/media/entry/companion-sleep.webp' : '/media/entry/companion.webp'} alt="" loading="eager" decoding="async" />
    {playing && (controlled ? <canvas ref={canvas} className="portrait-material" aria-hidden="true" /> : <video ref={video} className="portrait-material portrait-motion" src={'/media/entry/portrait-motion.mp4'} muted playsInline preload="auto" aria-hidden="true" />)}
    {((playing && (controlled || !motionReady)) || fog) && <svg className="portrait-structure" viewBox="0 0 1672 941" preserveAspectRatio="xMaxYMid slice" fill="none" aria-hidden="true">
      <defs>
        <linearGradient id={`${id}-ink`} x1="0" y1="0" x2="1" y2="1"><stop stopColor="#3481d5" /><stop offset=".5" stopColor="#81caff" /><stop offset="1" stopColor="#3879ce" /></linearGradient>
        <filter id={`${id}-glow`} x="-10%" y="-10%" width="120%" height="120%"><feGaussianBlur stdDeviation="1.5" /></filter>
        <clipPath id={`${id}-face`}><path d={FACE_CLIP} /></clipPath>
        <clipPath id={`${id}-scan`}><rect ref={gridClip} x="0" y="0" width="1672" height={fog ? '941' : '0'} /></clipPath>
      </defs>
      <g>
        <g className="portrait-lines" stroke={`url(#${id}-ink)`} strokeLinecap="round" strokeLinejoin="round">
          <g className="portrait-line-glow" filter={`url(#${id}-glow)`} strokeWidth="4" opacity=".32">
            {PORTRAIT_LINES.map((path, index) => <path key={path} d={path} pathLength="1" strokeDasharray="1" style={{ '--trace-order': index } as CSSProperties} />)}
          </g>
          <g strokeWidth="1.3">{PORTRAIT_LINES.map((path, index) => <path key={path} d={path} pathLength="1" strokeDasharray="1" style={{ '--trace-order': index } as CSSProperties} />)}</g>
          <g className="portrait-fine-lines" strokeWidth=".7" opacity=".68">{PORTRAIT_DETAILS.map((path, index) => <path key={path} d={path} pathLength="1" strokeDasharray="1" style={{ '--trace-order': index + 12 } as CSSProperties} />)}</g>
        </g>
        <g className="portrait-mesh" clipPath={`url(#${id}-face)`} stroke="#76b9ef" strokeWidth=".65">
          <g clipPath={`url(#${id}-scan)`}>{PORTRAIT_MESH.map(path => <path key={path} d={path} />)}</g>
        </g>
      </g>
    </svg>}
    {fog && <div className="portrait-ambient-scan" />}
  </div>;
}
