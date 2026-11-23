import { useEffect, useRef, useState } from 'react';

const PHASE_TIMEOUT = { loading: 700, playing: 1850, leaving: 140, finished: 0 };
type Phase = keyof typeof PHASE_TIMEOUT;

export function prepareArrivalVideo(src?: string) {
  if (!src || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const preload = document.createElement('video');
  preload.preload = 'auto';
  preload.src = src;
  return () => { preload.removeAttribute('src'); };
}

/** Decorative video over the settled artwork. The workspace owns its own lifecycle. */
export function ArrivalVideo({ src }: { src: string }) {
  const [initialSrc] = useState(src);
  const [phase, setPhase] = useState<Phase>('loading');
  const video = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const player = video.current;
    if (!player) return;
    player.muted = true;
    void player.play()?.catch(() => setPhase(current => current === 'loading' ? 'finished' : current));
  }, []);
  useEffect(() => {
    if (src !== initialSrc) setPhase('finished');
  }, [src, initialSrc]);

  useEffect(() => {
    if (phase === 'finished') return;
    const timer = window.setTimeout(() => {
      setPhase(current => current === phase ? (phase === 'playing' ? 'leaving' : 'finished') : current);
    }, PHASE_TIMEOUT[phase]);
    return () => window.clearTimeout(timer);
  }, [phase]);

  if (phase === 'finished' || src !== initialSrc) return null;
  return (
    <video
      ref={video}
      className="portrait-arrival"
      data-playback={phase}
      src={initialSrc}
      autoPlay
      muted
      playsInline
      aria-hidden="true"
      tabIndex={-1}
      onPlaying={() => setPhase(current => current === 'loading' ? 'playing' : current)}
      onEnded={() => setPhase('leaving')}
      onError={() => setPhase('finished')}
    />
  );
}
