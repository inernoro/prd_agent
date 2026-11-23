import { useEffect, useRef } from 'react';

const LOAD_TIMEOUT = 1800;
const PLAYBACK_TIMEOUT = 1950;
const FADE_DURATION = 140;
let prepared: HTMLVideoElement | undefined;

function createVideo(src: string) {
  const video = document.createElement('video');
  video.className = 'portrait-arrival';
  video.setAttribute('aria-hidden', 'true');
  video.tabIndex = -1;
  video.preload = 'auto';
  video.playsInline = true;
  video.muted = true;
  video.src = src;
  return video;
}

function release(video: HTMLVideoElement) {
  video.remove();
  video.removeAttribute('src');
  video.load();
}

export function prepareArrivalVideo(src?: string) {
  if (!src || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  if (prepared) release(prepared);
  const video = createVideo(src);
  prepared = video;
  video.load();
  return () => {
    // Give the destination a chance to take ownership across the route change.
    window.setTimeout(() => {
      if (prepared !== video) return;
      prepared = undefined;
      release(video);
    }, LOAD_TIMEOUT);
  };
}

/** The native decoder moves from login to the decorative layer without restarting its request. */
export function ArrivalVideo({ src }: { src: string }) {
  const target = useRef<HTMLDivElement>(null);
  const originalSrc = useRef(src);
  const themeChanged = useRef(false);

  useEffect(() => {
    const host = target.current;
    if (src !== originalSrc.current) themeChanged.current = true;
    if (!host || themeChanged.current) return;
    const video = prepared?.getAttribute('src') === src ? prepared : createVideo(src);
    if (prepared === video) prepared = undefined;
    let timer: number;
    let finished = false;

    const finish = () => {
      if (finished) return;
      finished = true;
      window.clearTimeout(timer);
      video.removeEventListener('playing', playing);
      video.removeEventListener('ended', fade);
      video.removeEventListener('error', finish);
      release(video);
    };
    const fade = () => {
      window.clearTimeout(timer);
      video.dataset.playback = 'leaving';
      timer = window.setTimeout(finish, FADE_DURATION);
    };
    const playing = () => {
      if (video.dataset.playback !== 'loading') return;
      video.dataset.playback = 'playing';
      window.clearTimeout(timer);
      timer = window.setTimeout(fade, PLAYBACK_TIMEOUT);
    };
    video.dataset.playback = 'loading';
    video.addEventListener('playing', playing);
    video.addEventListener('ended', fade);
    video.addEventListener('error', finish);
    host.append(video);
    timer = window.setTimeout(finish, LOAD_TIMEOUT);
    void video.play().catch(finish);

    return finish;
  }, [src]);

  return <div ref={target} className="portrait-arrival-slot" aria-hidden="true" />;
}
