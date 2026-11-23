import { useEffect, useState } from 'react';

const PHASE_TIMEOUT = { loading: 500, playing: 1850, leaving: 140, finished: 0 };
type Phase = keyof typeof PHASE_TIMEOUT;

/** Decorative video over the settled artwork. The workspace owns its own lifecycle. */
export function ArrivalVideo({ src }: { src: string }) {
  const [initialSrc] = useState(src);
  const [phase, setPhase] = useState<Phase>('loading');

  useEffect(() => {
    if (src !== initialSrc) setPhase('finished');
  }, [src, initialSrc]);

  useEffect(() => {
    if (phase === 'finished') return;
    const timer = window.setTimeout(() => {
      setPhase(phase === 'playing' ? 'leaving' : 'finished');
    }, PHASE_TIMEOUT[phase]);
    return () => window.clearTimeout(timer);
  }, [phase]);

  if (phase === 'finished' || src !== initialSrc) return null;
  return (
    <video
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
